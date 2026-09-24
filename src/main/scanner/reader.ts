import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadKoffi } from '../native/koffi';

export interface RawEntry {
  name: string;
  isDirectory: boolean;
  /** File length in bytes. */
  size: number;
  /** Bytes allocated on disk (0 for cloud-only files, smaller for compressed ones). */
  sizeOnDisk: number;
  modifiedMs: number;
  createdMs: number;
  hidden: boolean;
  /** Reparse tag, or 0 when the entry is not a reparse point. */
  reparseTag: number;
  /** Per-volume file identity used to count hard links once; 0 when unknown. */
  fileKey: number;
}

export interface DirectoryReader {
  /** True when Windows attributes (hidden, allocation size, reparse tags) are available. */
  readonly native: boolean;
  /** Lists a directory, or returns null when it cannot be opened. */
  read(dirPath: string): RawEntry[] | null;
}

const IO_REPARSE_TAG_SYMLINK = 0xa000000c;
const NAME_SURROGATE_BIT = 0x20000000;

/** Symlinks, junctions and mount points point somewhere else and are never followed. */
export function isLinkTag(tag: number): boolean {
  return tag !== 0 && (tag & NAME_SURROGATE_BIT) !== 0;
}

/** OneDrive and other cloud-files placeholders (IO_REPARSE_TAG_CLOUD_0..F). */
export function isCloudTag(tag: number): boolean {
  return tag !== 0 && ((tag & 0xffff0fff) >>> 0) === 0x9000001a;
}

// ---------------------------------------------------------------------------
// Native reader: CreateFileW + NtQueryDirectoryFile return name, attributes,
// sizes, timestamps and file ids for a whole batch of entries per call, which
// is an order of magnitude faster than fs.readdir + fs.lstat on Windows.

const FILE_LIST_DIRECTORY = 0x1;
const SYNCHRONIZE = 0x100000;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const INVALID_HANDLE = -1;

const FILE_ATTRIBUTE_HIDDEN = 0x2;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

const FileFullDirectoryInformation = 2;
const FileIdBothDirectoryInformation = 37;

const STATUS_NO_MORE_FILES = 0x80000006;
const STATUS_NO_SUCH_FILE = 0xc000000f;
const UNSUPPORTED_CLASS = new Set([0xc0000003, 0xc000000d, 0xc00000bb, 0xc0000010]);

const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
const TWO_32 = 4294967296;

type NativeFns = {
  CreateFileW: (...args: unknown[]) => number;
  CloseHandle: (handle: number) => number;
  NtQueryDirectoryFile: (...args: unknown[]) => number;
};

let nativeFns: NativeFns | null | undefined;

function bindNative(): NativeFns | null {
  if (nativeFns !== undefined) return nativeFns;
  const koffi = loadKoffi();
  if (!koffi) return (nativeFns = null);
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    nativeFns = {
      CreateFileW: kernel32.func('CreateFileW', 'intptr_t', [
        'str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', 'intptr_t',
      ]) as NativeFns['CreateFileW'],
      CloseHandle: kernel32.func('CloseHandle', 'int', ['intptr_t']) as NativeFns['CloseHandle'],
      NtQueryDirectoryFile: ntdll.func('NtQueryDirectoryFile', 'int32_t', [
        'intptr_t', 'intptr_t', 'void *', 'void *', 'void *', 'void *', 'uint32_t', 'int', 'uint8_t', 'void *', 'uint8_t',
      ]) as NativeFns['NtQueryDirectoryFile'],
    };
  } catch {
    nativeFns = null;
  }
  return nativeFns;
}

/** Converts "C:\\dir" or "\\\\server\\share\\dir" to the long-path form accepted by CreateFileW. */
export function toLongPath(dirPath: string): string {
  if (dirPath.startsWith('\\\\?\\')) return dirPath;
  if (dirPath.startsWith('\\\\')) return '\\\\?\\UNC\\' + dirPath.slice(2);
  return '\\\\?\\' + dirPath;
}

function readFiletimeMs(buffer: Buffer, offset: number): number {
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  return (high * TWO_32 + low) / 10000 - FILETIME_EPOCH_OFFSET_MS;
}

function readInt64(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset + 4) * TWO_32 + buffer.readUInt32LE(offset);
}

class NtDirectoryReader implements DirectoryReader {
  readonly native = true;
  private readonly buffer = Buffer.alloc(256 * 1024);
  private readonly ioStatus = Buffer.alloc(16);
  private infoClass = FileIdBothDirectoryInformation;

  constructor(private readonly fns: NativeFns) {}

  read(dirPath: string): RawEntry[] | null {
    const handle = this.fns.CreateFileW(
      toLongPath(dirPath),
      FILE_LIST_DIRECTORY | SYNCHRONIZE,
      FILE_SHARE_ALL,
      null,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      0,
    );
    if (handle === INVALID_HANDLE || handle === 0) return null;
    const entries: RawEntry[] = [];
    try {
      let restart = 1;
      for (;;) {
        const status =
          this.fns.NtQueryDirectoryFile(
            handle, 0, null, null, this.ioStatus, this.buffer, this.buffer.length, this.infoClass, 0, null, restart,
          ) >>> 0;
        if (status === STATUS_NO_MORE_FILES || status === STATUS_NO_SUCH_FILE) break;
        if (status !== 0) {
          // Some file systems (FAT, network shares) do not support file ids.
          if (restart && this.infoClass === FileIdBothDirectoryInformation && UNSUPPORTED_CLASS.has(status)) {
            this.infoClass = FileFullDirectoryInformation;
            continue;
          }
          if (restart) return null;
          break;
        }
        restart = 0;
        this.parse(entries);
      }
    } finally {
      this.fns.CloseHandle(handle);
    }
    return entries;
  }

  private parse(out: RawEntry[]): void {
    const buf = this.buffer;
    const withId = this.infoClass === FileIdBothDirectoryInformation;
    const nameOffset = withId ? 104 : 68;
    let offset = 0;
    for (;;) {
      const next = buf.readUInt32LE(offset);
      const nameLength = buf.readUInt32LE(offset + 60);
      const name = buf.toString('utf16le', offset + nameOffset, offset + nameOffset + nameLength);
      if (name !== '.' && name !== '..') {
        const attributes = buf.readUInt32LE(offset + 56);
        const isReparse = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
        // FileId = sequence (high 16 bits) + MFT record (low 48 bits); the record alone
        // identifies a live file on the volume and fits in a double.
        const fileKey = withId ? buf.readUInt16LE(offset + 100) * TWO_32 + buf.readUInt32LE(offset + 96) : 0;
        out.push({
          name,
          isDirectory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
          size: readInt64(buf, offset + 40),
          sizeOnDisk: readInt64(buf, offset + 48),
          modifiedMs: readFiletimeMs(buf, offset + 24),
          createdMs: readFiletimeMs(buf, offset + 8),
          hidden: (attributes & FILE_ATTRIBUTE_HIDDEN) !== 0,
          // For reparse points the EaSize field holds the reparse tag.
          reparseTag: isReparse ? buf.readUInt32LE(offset + 64) : 0,
          fileKey,
        });
      }
      if (next === 0) break;
      offset += next;
    }
  }
}

// ---------------------------------------------------------------------------
// Portable fallback: slower and without Windows attributes.

class NodeDirectoryReader implements DirectoryReader {
  readonly native = false;

  read(dirPath: string): RawEntry[] | null {
    let names: string[];
    try {
      names = readdirSync(dirPath);
    } catch {
      return null;
    }
    const entries: RawEntry[] = [];
    for (const name of names) {
      let stats;
      try {
        stats = lstatSync(join(dirPath, name));
      } catch {
        continue;
      }
      entries.push({
        name,
        isDirectory: stats.isDirectory(),
        size: stats.isFile() ? stats.size : 0,
        sizeOnDisk: stats.isFile() ? stats.size : 0,
        modifiedMs: stats.mtimeMs,
        createdMs: stats.birthtimeMs,
        hidden: false,
        reparseTag: stats.isSymbolicLink() ? IO_REPARSE_TAG_SYMLINK : 0,
        fileKey: 0,
      });
    }
    return entries;
  }
}

export function createDirectoryReader(preferNative = true): DirectoryReader {
  const fns = preferNative ? bindNative() : null;
  return fns ? new NtDirectoryReader(fns) : new NodeDirectoryReader();
}
