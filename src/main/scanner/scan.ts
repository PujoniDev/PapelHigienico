import { categoryOf, extensionOf, CATEGORY_ORDER } from '@shared/categories';
import type { FileCategory } from '@shared/types';
import { isCloudTag, isLinkTag, type DirectoryReader } from './reader';

export const FLAG_INACCESSIBLE = 1;
export const FLAG_PARTIAL = 2;
export const FLAG_HIDDEN_SKIPPED = 4;
export const FLAG_CLOUD = 8;
export const FLAG_HIDDEN = 16;

export interface ScanInput {
  root: string;
  includeHidden: boolean;
  /** Absolute folder paths (any case) that must not be entered. */
  excludePaths: string[];
  /** Count each hard-linked file once (only meaningful on NTFS). */
  dedupeHardLinks: boolean;
  largeFilesLimit?: number;
  perCategoryLimit?: number;
}

export interface ScanProgressInfo {
  currentPath: string;
  filesScanned: number;
  dirsScanned: number;
  bytesScanned: number;
  inaccessible: number;
}

export interface ScanHooks {
  isCancelled(): boolean;
  onProgress(info: ScanProgressInfo): void;
  progressIntervalMs?: number;
}

export interface CompactFile {
  dir: number;
  name: string;
  size: number;
  sizeOnDisk: number;
  modifiedMs: number;
  hidden: boolean;
  cloud: boolean;
}

export interface CompactScanResult {
  root: string;
  names: string[];
  parent: Int32Array;
  size: Float64Array;
  logicalSize: Float64Array;
  fileCount: Float64Array;
  folderCount: Float64Array;
  directFiles: Float64Array;
  directSize: Float64Array;
  modified: Float64Array;
  flags: Uint8Array;
  largeFiles: CompactFile[];
  largeFilesTruncated: boolean;
  categories: { category: FileCategory; count: number; size: number }[];
  extensions: { extension: string; category: FileCategory; count: number; size: number }[];
  inaccessibleCount: number;
  inaccessibleSamples: string[];
  skippedLinks: number;
  skippedHidden: { files: number; folders: number; fileBytes: number };
  excludedHit: string[];
  hardLinkDuplicateBytes: number;
  cancelled: boolean;
  limitedMetadata: boolean;
}

/** Keeps the N largest files seen so far using a binary min-heap on size. */
export class TopFiles {
  private readonly heap: CompactFile[] = [];

  constructor(private readonly limit: number) {}

  offer(file: CompactFile): void {
    const heap = this.heap;
    if (heap.length < this.limit) {
      heap.push(file);
      this.siftUp(heap.length - 1);
    } else if (this.limit > 0 && file.size > heap[0].size) {
      heap[0] = file;
      this.siftDown(0);
    }
  }

  /** Cheap pre-check so callers can skip allocating a record for small files. */
  accepts(size: number): boolean {
    return this.heap.length < this.limit || (this.limit > 0 && size > this.heap[0].size);
  }

  values(): CompactFile[] {
    return this.heap.slice();
  }

  private siftUp(index: number): void {
    const heap = this.heap;
    const item = heap[index];
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].size <= item.size) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  }

  private siftDown(index: number): void {
    const heap = this.heap;
    const item = heap[index];
    const length = heap.length;
    for (;;) {
      let child = index * 2 + 1;
      if (child >= length) break;
      if (child + 1 < length && heap[child + 1].size < heap[child].size) child++;
      if (heap[child].size >= item.size) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = item;
  }
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith('\\') || parent.endsWith('/') ? parent + name : parent + '\\' + name;
}

export function runScan(reader: DirectoryReader, input: ScanInput, hooks: ScanHooks): CompactScanResult {
  const excluded = new Set(input.excludePaths.map((p) => p.toLowerCase().replace(/[\\/]+$/, '')));
  const interval = hooks.progressIntervalMs ?? 150;

  const names: string[] = [input.root];
  const parent: number[] = [-1];
  const modified: number[] = [0];
  const flags: number[] = [0];
  const directFiles: number[] = [0];
  const directSize: number[] = [0];
  const directLogical: number[] = [0];

  const overall = new TopFiles(input.largeFilesLimit ?? 3000);
  const perCategory = new Map<FileCategory, TopFiles>(
    CATEGORY_ORDER.map((c) => [c, new TopFiles(input.perCategoryLimit ?? 400)]),
  );
  const categoryTotals = new Map<FileCategory, { count: number; size: number }>(
    CATEGORY_ORDER.map((c) => [c, { count: 0, size: 0 }]),
  );
  const extensionTotals = new Map<string, { count: number; size: number }>();
  const seenKeys = input.dedupeHardLinks ? new Set<number>() : null;

  const inaccessibleSamples: string[] = [];
  const excludedHit: string[] = [];
  let inaccessibleCount = 0;
  let skippedLinks = 0;
  const skippedHidden = { files: 0, folders: 0, fileBytes: 0 };
  let hardLinkDuplicateBytes = 0;
  let filesScanned = 0;
  let bytesScanned = 0;
  let cancelled = false;
  let lastProgress = Date.now();

  const stackIds: number[] = [0];
  const stackPaths: string[] = [input.root];

  while (stackIds.length > 0) {
    if (hooks.isCancelled()) {
      cancelled = true;
      break;
    }
    const dirId = stackIds.pop()!;
    const dirPath = stackPaths.pop()!;
    const entries = reader.read(dirPath);
    if (entries === null) {
      flags[dirId] |= FLAG_INACCESSIBLE;
      inaccessibleCount++;
      if (inaccessibleSamples.length < 20) inaccessibleSamples.push(dirPath);
      continue;
    }

    for (const entry of entries) {
      if (isLinkTag(entry.reparseTag)) {
        skippedLinks++;
        continue;
      }
      if (entry.hidden && !input.includeHidden) {
        flags[dirId] |= FLAG_HIDDEN_SKIPPED;
        if (entry.isDirectory) skippedHidden.folders++;
        else {
          skippedHidden.files++;
          skippedHidden.fileBytes += entry.sizeOnDisk;
        }
        continue;
      }
      const cloud = isCloudTag(entry.reparseTag);

      if (entry.isDirectory) {
        const childPath = joinPath(dirPath, entry.name);
        if (excluded.size > 0 && excluded.has(childPath.toLowerCase())) {
          excludedHit.push(childPath);
          continue;
        }
        const childId = names.length;
        names.push(entry.name);
        parent.push(dirId);
        modified.push(entry.modifiedMs);
        flags.push((cloud ? FLAG_CLOUD : 0) | (entry.hidden ? FLAG_HIDDEN : 0));
        directFiles.push(0);
        directSize.push(0);
        directLogical.push(0);
        stackIds.push(childId);
        stackPaths.push(childPath);
        continue;
      }

      filesScanned++;
      let onDisk = entry.sizeOnDisk;
      if (seenKeys !== null && entry.fileKey !== 0) {
        if (seenKeys.has(entry.fileKey)) {
          hardLinkDuplicateBytes += onDisk;
          onDisk = 0;
        } else {
          seenKeys.add(entry.fileKey);
        }
      }
      directFiles[dirId]++;
      directSize[dirId] += onDisk;
      directLogical[dirId] += entry.size;
      bytesScanned += onDisk;

      const extension = extensionOf(entry.name);
      const category = categoryOf(entry.name);
      const totals = categoryTotals.get(category)!;
      totals.count++;
      totals.size += onDisk;
      const extKey = extension || '(sem extensão)';
      const ext = extensionTotals.get(extKey);
      if (ext) {
        ext.count++;
        ext.size += onDisk;
      } else {
        extensionTotals.set(extKey, { count: 1, size: onDisk });
      }

      const categoryTop = perCategory.get(category)!;
      if (overall.accepts(entry.size) || categoryTop.accepts(entry.size)) {
        const record: CompactFile = {
          dir: dirId,
          name: entry.name,
          size: entry.size,
          sizeOnDisk: onDisk,
          modifiedMs: entry.modifiedMs,
          hidden: entry.hidden,
          cloud,
        };
        overall.offer(record);
        categoryTop.offer(record);
      }
    }

    const now = Date.now();
    if (now - lastProgress >= interval) {
      lastProgress = now;
      hooks.onProgress({
        currentPath: dirPath,
        filesScanned,
        dirsScanned: names.length,
        bytesScanned,
        inaccessible: inaccessibleCount,
      });
    }
  }

  // Roll sizes up the tree. Children always have larger ids than their parent.
  const count = names.length;
  const size = Float64Array.from(directSize);
  const logicalSize = Float64Array.from(directLogical);
  const fileCount = Float64Array.from(directFiles);
  const folderCount = new Float64Array(count);
  const flagArray = Uint8Array.from(flags);
  for (let i = count - 1; i > 0; i--) {
    const p = parent[i];
    size[p] += size[i];
    logicalSize[p] += logicalSize[i];
    fileCount[p] += fileCount[i];
    folderCount[p] += folderCount[i] + 1;
    if (flagArray[i] & (FLAG_INACCESSIBLE | FLAG_PARTIAL)) flagArray[p] |= FLAG_PARTIAL;
    if (flagArray[i] & FLAG_HIDDEN_SKIPPED) flagArray[p] |= FLAG_HIDDEN_SKIPPED;
  }

  // Merge the per-category heaps into one list without duplicates.
  const merged = new Set<CompactFile>(overall.values());
  for (const top of perCategory.values()) {
    for (const file of top.values()) merged.add(file);
  }
  const largeFilesTruncated = filesScanned > merged.size;

  const extensions = [...extensionTotals.entries()]
    .map(([extension, value]) => ({
      extension,
      category: extension === '(sem extensão)' ? ('other' as FileCategory) : categoryOf('x.' + extension),
      count: value.count,
      size: value.size,
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 40);

  return {
    root: input.root,
    names,
    parent: Int32Array.from(parent),
    size,
    logicalSize,
    fileCount,
    folderCount,
    directFiles: Float64Array.from(directFiles),
    directSize: Float64Array.from(directSize),
    modified: Float64Array.from(modified),
    flags: flagArray,
    largeFiles: [...merged].sort((a, b) => b.size - a.size),
    largeFilesTruncated,
    categories: CATEGORY_ORDER.map((category) => ({ category, ...categoryTotals.get(category)! })),
    extensions,
    inaccessibleCount,
    inaccessibleSamples,
    skippedLinks,
    skippedHidden,
    excludedHit,
    hardLinkDuplicateBytes,
    cancelled,
    limitedMetadata: !reader.native,
  };
}
