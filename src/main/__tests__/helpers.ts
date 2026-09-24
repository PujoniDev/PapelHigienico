import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FileRemover } from '../file-ops';
import { normalizePath, type KnownPaths } from '../policy';

export function makeTempDir(prefix = 'limpac-test-'): { path: string; cleanup(): void } {
  const path = normalizePath(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function writeFile(path: string, sizeOrContent: number | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof sizeOrContent === 'number' ? Buffer.alloc(sizeOrContent, 7) : sizeOrContent);
}

/** Known folders rooted at a fake profile inside a test directory. */
export function fakeKnownPaths(root: string): KnownPaths {
  const home = join(root, 'Users', 'ana');
  return {
    systemDrive: 'C:\\',
    systemRoot: 'C:\\Windows',
    programFiles: ['C:\\Program Files', 'C:\\Program Files (x86)'],
    programData: 'C:\\ProgramData',
    home,
    appData: join(home, 'AppData', 'Roaming'),
    localAppData: join(home, 'AppData', 'Local'),
    temp: join(home, 'AppData', 'Local', 'Temp'),
    desktop: join(home, 'Desktop'),
    documents: join(home, 'Documents'),
    downloads: join(home, 'Downloads'),
    pictures: join(home, 'Pictures'),
    videos: join(home, 'Videos'),
    music: join(home, 'Music'),
    syncedRoots: [{ label: 'OneDrive', path: join(home, 'OneDrive') }],
  };
}

/** Moves "trashed" files into a folder instead of the real Recycle Bin. */
export function fakeRemover(trashDir: string, options: { failTrash?: (path: string) => boolean } = {}) {
  const trashed: string[] = [];
  const removed: string[] = [];
  const remover: FileRemover = {
    async trash(path) {
      if (options.failTrash?.(path)) throw new Error('trash failed');
      mkdirSync(trashDir, { recursive: true });
      renameSync(path, join(trashDir, `${trashed.length}-${path.split('\\').pop()}`));
      trashed.push(path);
    },
    async remove(path) {
      rmSync(path);
      removed.push(path);
    },
  };
  return { remover, trashed, removed };
}
