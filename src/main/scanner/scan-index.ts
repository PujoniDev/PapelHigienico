import { categoryOf, extensionOf } from '@shared/categories';
import type {
  FileEntry,
  FilePage,
  FolderEntry,
  FolderPage,
  LargeFilesQuery,
  SearchResult,
  TypeBreakdown,
} from '@shared/types';
import {
  FLAG_CLOUD,
  FLAG_HIDDEN,
  FLAG_HIDDEN_SKIPPED,
  FLAG_INACCESSIBLE,
  FLAG_PARTIAL,
  type CompactFile,
  type CompactScanResult,
} from './scan';

const MAX_PAGE = 500;

/** Read-only view over a finished scan. Folder ids are indexes into the compact arrays. */
export class ScanIndex {
  private readonly childStart: Int32Array;
  private readonly childList: Int32Array;
  private readonly files: CompactFile[];

  constructor(readonly scanId: string, private readonly data: CompactScanResult) {
    const count = data.names.length;
    const childCounts = new Int32Array(count);
    for (let i = 1; i < count; i++) childCounts[data.parent[i]]++;
    this.childStart = new Int32Array(count + 1);
    for (let i = 0; i < count; i++) this.childStart[i + 1] = this.childStart[i] + childCounts[i];
    this.childList = new Int32Array(Math.max(0, count - 1));
    const cursor = this.childStart.slice(0, count);
    for (let i = 1; i < count; i++) this.childList[cursor[data.parent[i]]++] = i;
    for (let i = 0; i < count; i++) {
      const start = this.childStart[i];
      const end = this.childStart[i + 1];
      if (end - start > 1) {
        const sorted = Array.from(this.childList.subarray(start, end)).sort((a, b) => data.size[b] - data.size[a]);
        this.childList.set(sorted, start);
      }
    }
    this.files = data.largeFiles;
  }

  get result(): CompactScanResult {
    return this.data;
  }

  get folderTotal(): number {
    return this.data.names.length;
  }

  hasFolder(id: number): boolean {
    return Number.isInteger(id) && id >= 0 && id < this.data.names.length;
  }

  pathOf(id: number): string {
    const parts: string[] = [];
    let current = id;
    while (current > 0) {
      parts.push(this.data.names[current]);
      current = this.data.parent[current];
    }
    const root = this.data.names[0];
    if (parts.length === 0) return root;
    const separator = root.endsWith('\\') ? '' : '\\';
    return root + separator + parts.reverse().join('\\');
  }

  folder(id: number): FolderEntry {
    const d = this.data;
    const flags = d.flags[id];
    return {
      id,
      name: id === 0 ? d.names[0] : d.names[id],
      path: this.pathOf(id),
      size: d.size[id],
      logicalSize: d.logicalSize[id],
      fileCount: d.fileCount[id],
      folderCount: d.folderCount[id],
      modifiedMs: d.modified[id],
      childCount: this.childStart[id + 1] - this.childStart[id],
      flags: {
        inaccessible: (flags & FLAG_INACCESSIBLE) !== 0,
        partial: (flags & FLAG_PARTIAL) !== 0,
        hiddenSkipped: (flags & FLAG_HIDDEN_SKIPPED) !== 0,
        cloud: (flags & FLAG_CLOUD) !== 0,
        hidden: (flags & FLAG_HIDDEN) !== 0,
      },
    };
  }

  children(id: number): number[] {
    return Array.from(this.childList.subarray(this.childStart[id], this.childStart[id + 1]));
  }

  folderPage(id: number, offset = 0, limit = 200): FolderPage {
    const all = this.children(id);
    const start = Math.max(0, offset);
    const slice = all.slice(start, start + Math.min(limit, MAX_PAGE));
    const breadcrumb: FolderPage['breadcrumb'] = [];
    let current = id;
    while (current >= 0) {
      breadcrumb.unshift({ id: current, name: this.data.names[current] });
      current = current === 0 ? -1 : this.data.parent[current];
    }
    return {
      folder: this.folder(id),
      breadcrumb,
      children: slice.map((child) => this.folder(child)),
      totalChildren: all.length,
      directFiles: { count: this.data.directFiles[id], size: this.data.directSize[id] },
    };
  }

  topFolders(limit: number): FolderEntry[] {
    return this.children(0)
      .slice(0, limit)
      .map((id) => this.folder(id));
  }

  isUnder(folderId: number, ancestorId: number): boolean {
    let current = folderId;
    while (current >= 0) {
      if (current === ancestorId) return true;
      current = current === 0 ? -1 : this.data.parent[current];
    }
    return false;
  }

  fileEntry(file: CompactFile): FileEntry {
    const folder = this.pathOf(file.dir);
    const separator = folder.endsWith('\\') ? '' : '\\';
    return {
      path: folder + separator + file.name,
      name: file.name,
      folder,
      size: file.size,
      sizeOnDisk: file.sizeOnDisk,
      modifiedMs: file.modifiedMs,
      extension: extensionOf(file.name),
      category: categoryOf(file.name),
      hidden: file.hidden,
      cloud: file.cloud,
    };
  }

  largeFiles(query: LargeFilesQuery): FilePage {
    const needle = query.search?.trim().toLowerCase() ?? '';
    const matches = this.files.filter((file) => {
      if (query.minSize !== undefined && file.size < query.minSize) return false;
      if (query.category && categoryOf(file.name) !== query.category) return false;
      if (needle && !file.name.toLowerCase().includes(needle)) return false;
      if (query.underFolderId !== undefined && !this.isUnder(file.dir, query.underFolderId)) return false;
      return true;
    });
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(query.limit ?? 100, MAX_PAGE);
    return {
      items: matches.slice(offset, offset + limit).map((file) => this.fileEntry(file)),
      total: matches.length,
      truncated: this.data.largeFilesTruncated,
    };
  }

  /** All kept large files as entries (used for opportunity estimates). */
  allLargeFiles(minSize: number): FileEntry[] {
    return this.files.filter((file) => file.size >= minSize).map((file) => this.fileEntry(file));
  }

  types(): TypeBreakdown {
    return {
      categories: this.data.categories.filter((c) => c.count > 0).sort((a, b) => b.size - a.size),
      extensions: this.data.extensions,
    };
  }

  search(text: string, limit = 50): SearchResult {
    const needle = text.trim().toLowerCase();
    if (!needle) return { folders: [], files: [] };
    const folderIds: number[] = [];
    const names = this.data.names;
    for (let i = 1; i < names.length; i++) {
      if (names[i].toLowerCase().includes(needle)) folderIds.push(i);
    }
    folderIds.sort((a, b) => this.data.size[b] - this.data.size[a]);
    return {
      folders: folderIds.slice(0, limit).map((id) => this.folder(id)),
      files: this.largeFiles({ scanId: this.scanId, search: needle, limit }).items,
    };
  }
}
