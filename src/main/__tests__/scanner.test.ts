import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDirectoryReader } from '../scanner/reader';
import { runScan, TopFiles, type CompactFile, type ScanInput } from '../scanner/scan';
import { ScanIndex } from '../scanner/scan-index';
import { makeTempDir, writeFile } from './helpers';

const windows = process.platform === 'win32';
let temp: ReturnType<typeof makeTempDir>;
let root: string;

beforeAll(() => {
  temp = makeTempDir();
  root = temp.path;
  writeFile(join(root, 'a.bin'), 1000);
  writeFile(join(root, 'sub', 'b.bin'), 5000);
  writeFile(join(root, 'sub', 'deep', 'c.mp4'), 20000);
  writeFile(join(root, 'excluded', 'e.bin'), 7000);
  linkSync(join(root, 'sub', 'b.bin'), join(root, 'sub', 'b-link.bin'));
  symlinkSync(join(root, 'sub'), join(root, 'link'), 'junction');
  writeFile(join(root, 'hidden.bin'), 3000);
  writeFile(join(root, 'hiddenDir', 'x.bin'), 4000);
  mkdirSync(join(root, 'empty'));
  if (windows) {
    execFileSync('attrib', ['+h', join(root, 'hidden.bin')]);
    execFileSync('attrib', ['+h', join(root, 'hiddenDir')]);
  }
});

afterAll(() => temp.cleanup());

const hooks = { isCancelled: () => false, onProgress: () => undefined };

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return { root, includeHidden: false, excludePaths: [join(root, 'excluded')], dedupeHardLinks: true, ...overrides };
}

describe.runIf(windows)('native scanner', () => {
  const reader = createDirectoryReader(true);

  it('uses the native reader on Windows', () => {
    expect(reader.native).toBe(true);
  });

  it('skips junctions, hidden items and excluded folders', () => {
    const result = runScan(reader, input(), hooks);
    expect(result.names).toContain('sub');
    expect(result.names).toContain('deep');
    expect(result.names).not.toContain('link');
    expect(result.names).not.toContain('hiddenDir');
    expect(result.names).not.toContain('excluded');
    expect(result.skippedLinks).toBe(1);
    expect(result.skippedHidden).toMatchObject({ files: 1, folders: 1 });
    expect(result.excludedHit).toEqual([join(root, 'excluded')]);
    // a + b + b-link + c (logical sizes count every name)
    expect(result.logicalSize[0]).toBe(1000 + 5000 + 5000 + 20000);
    expect(result.fileCount[0]).toBe(4);
    expect(result.folderCount[0]).toBe(3); // sub, deep, empty
  });

  it('counts hard-linked data once', () => {
    const result = runScan(reader, input(), hooks);
    expect(result.hardLinkDuplicateBytes).toBeGreaterThan(0);
    const withoutDedupe = runScan(reader, input({ dedupeHardLinks: false }), hooks);
    expect(withoutDedupe.size[0] - result.size[0]).toBe(result.hardLinkDuplicateBytes);
  });

  it('includes hidden items on request', () => {
    const result = runScan(reader, input({ includeHidden: true }), hooks);
    expect(result.names).toContain('hiddenDir');
    expect(result.logicalSize[0]).toBe(1000 + 5000 + 5000 + 20000 + 3000 + 4000);
  });

  it('keeps the largest files with their folder', () => {
    const result = runScan(reader, input(), hooks);
    const index = new ScanIndex('scan', result);
    const [largest] = index.largeFiles({ scanId: 'scan' }).items;
    expect(largest.name).toBe('c.mp4');
    expect(largest.category).toBe('video');
    expect(largest.path).toBe(join(root, 'sub', 'deep', 'c.mp4'));
    expect(result.categories.find((c) => c.category === 'video')?.count).toBe(1);
  });

  it('stops when cancelled and reports it', () => {
    let calls = 0;
    const result = runScan(reader, input(), { isCancelled: () => ++calls > 1, onProgress: () => undefined });
    expect(result.cancelled).toBe(true);
    expect(result.names.length).toBeLessThan(4);
  });

  it('marks unreadable folders instead of failing', () => {
    const result = runScan(reader, input({ root: join(root, 'does-not-exist') }), hooks);
    expect(result.inaccessibleCount).toBe(1);
    expect(result.flags[0] & 1).toBe(1);
  });
});

describe('fallback scanner', () => {
  const reader = createDirectoryReader(false);

  it('still skips links and exclusions', () => {
    const result = runScan(reader, input({ includeHidden: true }), hooks);
    expect(reader.native).toBe(false);
    expect(result.limitedMetadata).toBe(true);
    expect(result.names).not.toContain('link');
    expect(result.names).not.toContain('excluded');
    expect(result.logicalSize[0]).toBe(1000 + 5000 + 5000 + 20000 + 3000 + 4000);
  });
});

describe('scan index', () => {
  it('orders children by size and builds paths and breadcrumbs', () => {
    const result = runScan(createDirectoryReader(), input({ includeHidden: true }), hooks);
    const index = new ScanIndex('id', result);
    const page = index.folderPage(0);
    expect(page.children[0].name).toBe('sub');
    for (let i = 1; i < page.children.length; i++) {
      expect(page.children[i - 1].size).toBeGreaterThanOrEqual(page.children[i].size);
    }
    const deep = index.search('deep').folders[0];
    expect(deep.path).toBe(join(root, 'sub', 'deep'));
    expect(index.folderPage(deep.id).breadcrumb.map((crumb) => crumb.name)).toEqual([root, 'sub', 'deep']);
    const underSub = index.largeFiles({ scanId: 'id', underFolderId: page.children[0].id });
    expect(underSub.items.map((file) => file.name).sort()).toEqual(['b-link.bin', 'b.bin', 'c.mp4']);
    expect(index.largeFiles({ scanId: 'id', category: 'video' }).total).toBe(1);
    expect(index.largeFiles({ scanId: 'id', minSize: 4500 }).total).toBe(3);
  });
});

describe('TopFiles', () => {
  it('keeps only the N largest', () => {
    const top = new TopFiles(3);
    for (const size of [5, 1, 9, 3, 7, 2, 8]) top.offer({ size } as CompactFile);
    expect(
      top
        .values()
        .map((file) => file.size)
        .sort((a, b) => b - a),
    ).toEqual([9, 8, 7]);
  });
});
