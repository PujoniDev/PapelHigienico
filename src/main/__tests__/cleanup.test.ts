import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CleanupCategoryDef } from '../cleanup/rules';
import { safeTempRoot } from '../cleanup/rules';
import { CleanupService } from '../cleanup/service';
import { HistoryStore } from '../history';
import { createDirectoryReader } from '../scanner/reader';
import { fakeKnownPaths, fakeRemover, makeTempDir, writeFile } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
// The age rule looks at creation time too, which tests cannot backdate, so the
// service runs with a clock 30 days ahead and "recent" files get a future mtime.
const NOW = Date.now() + 30 * DAY;

let temp: ReturnType<typeof makeTempDir>;
let cacheRoot: string;
let downloads: string;

function setModified(path: string, ms: number) {
  utimesSync(path, new Date(ms), new Date(ms));
}

function categories(): CleanupCategoryDef[] {
  return [
    {
      id: 'user-temp',
      title: 'Temporários',
      description: '',
      risk: 'low',
      riskReason: '',
      kind: 'files',
      allowsPermanent: true,
      notes: [],
      maxItems: 1000,
      sources: () => [{ id: 'temp', label: 'Temp', roots: [cacheRoot], minAgeDays: 7, minSize: 0, recursive: true }],
    },
    {
      id: 'app-cache',
      title: 'Cache',
      description: '',
      risk: 'medium',
      riskReason: '',
      kind: 'files',
      allowsPermanent: true,
      notes: [],
      maxItems: 1000,
      sources: () => [
        {
          id: 'browser',
          label: 'Navegador',
          appName: 'Navegador',
          roots: [join(temp.path, 'browser')],
          minAgeDays: 0,
          minSize: 0,
          recursive: true,
          processNames: ['browser.exe'],
        },
      ],
    },
    {
      id: 'downloads',
      title: 'Downloads',
      description: '',
      risk: 'review',
      riskReason: '',
      kind: 'review',
      allowsPermanent: false,
      notes: [],
      maxItems: 1000,
      sources: () => [{ id: 'downloads', label: 'Downloads', roots: [downloads], minAgeDays: 0, minSize: 10, recursive: true }],
    },
  ];
}

function service(options: { running?: string[]; failTrash?: (path: string) => boolean } = {}) {
  const fake = fakeRemover(join(temp.path, '_trash'), { failTrash: options.failTrash });
  const history = new HistoryStore(join(temp.path, '_history'));
  const cleanup = new CleanupService({
    known: fakeKnownPaths(temp.path),
    reader: createDirectoryReader(),
    remover: fake.remover,
    history,
    emit: () => undefined,
    runningProcesses: async () => new Set(options.running ?? []),
    recycleBin: () => ({ available: true, itemCount: 0, size: 0 }),
    freeBytes: async () => 1000,
    now: () => NOW,
    categories: categories(),
  });
  return { cleanup, fake, history };
}

beforeEach(() => {
  temp = makeTempDir();
  cacheRoot = join(temp.path, 'temp');
  downloads = join(temp.path, 'downloads');
  writeFile(join(cacheRoot, 'old.tmp'), 100);
  writeFile(join(cacheRoot, 'nested', 'old2.tmp'), 200);
  writeFile(join(cacheRoot, 'recent.tmp'), 300);
  setModified(join(cacheRoot, 'recent.tmp'), NOW - DAY);
  writeFile(join(temp.path, 'browser', 'Cache', 'data_1'), 50);
  writeFile(join(downloads, 'setup.exe'), 500);
  writeFile(join(downloads, 'tiny.txt'), 5);
});

afterEach(() => temp.cleanup());

describe('cleanup categories', () => {
  it('lists only old files and ignores recent ones', async () => {
    const { cleanup } = service();
    const [tempCategory] = await cleanup.categories(true);
    expect(tempCategory.itemCount).toBe(2);
    expect(tempCategory.size).toBe(300);
    const names = cleanup.items({ categoryId: 'user-temp' }).items.map((item) => item.name);
    expect(names).toEqual(['old2.tmp', 'old.tmp']);
  });

  it('does not offer the cache of a running app', async () => {
    const { cleanup } = service({ running: ['browser.exe'] });
    const list = await cleanup.categories(true);
    const cache = list.find((category) => category.id === 'app-cache')!;
    expect(cache.itemCount).toBe(0);
    expect(cache.sources[0].blockedReason).toContain('Feche');
  });

  it('applies the minimum size for review categories', async () => {
    const { cleanup } = service();
    await cleanup.categories(true);
    expect(cleanup.items({ categoryId: 'downloads' }).items.map((item) => item.name)).toEqual(['setup.exe']);
  });
});

describe('cleanup execution', () => {
  it('removes only the confirmed selection and records history', async () => {
    const { cleanup, fake, history } = service();
    await cleanup.categories(true);
    const result = await cleanup.execute({
      selections: [{ categoryId: 'user-temp', mode: 'only', paths: [join(cacheRoot, 'old.tmp')] }],
      mode: 'trash',
    });
    expect(result.status).toBe('completed');
    expect(result.removedCount).toBe(1);
    expect(fake.trashed).toEqual([join(cacheRoot, 'old.tmp')]);
    expect(existsSync(join(cacheRoot, 'nested', 'old2.tmp'))).toBe(true);
    const [entry] = await history.list();
    expect(entry.type).toBe('cleanup');
    expect(entry.itemCount).toBe(1);
  });

  it('ignores paths that the rules did not find', async () => {
    const { cleanup, fake } = service();
    await cleanup.categories(true);
    const outsider = join(temp.path, 'important.docx');
    writeFile(outsider, 10);
    await expect(
      cleanup.execute({ selections: [{ categoryId: 'user-temp', mode: 'only', paths: [outsider] }], mode: 'permanent' }),
    ).rejects.toThrow('Nenhum item');
    expect(existsSync(outsider)).toBe(true);
    expect(fake.removed).toEqual([]);
  });

  it('skips files that changed after the review', async () => {
    const { cleanup, fake } = service();
    await cleanup.categories(true);
    writeFileSync(join(cacheRoot, 'old.tmp'), 'changed content');
    const result = await cleanup.execute({ selections: [{ categoryId: 'user-temp', mode: 'all', paths: [] }], mode: 'permanent' });
    expect(result.status).toBe('partial');
    expect(result.skipped.map((item) => item.path)).toEqual([join(cacheRoot, 'old.tmp')]);
    expect(fake.removed).toEqual([join(cacheRoot, 'nested', 'old2.tmp')]);
    // The emptied sub-folder is removed, the rule's root is kept.
    expect(existsSync(join(cacheRoot, 'nested'))).toBe(false);
    expect(existsSync(cacheRoot)).toBe(true);
  });

  it('honours exclusions in "all" mode', async () => {
    const { cleanup, fake } = service();
    await cleanup.categories(true);
    await cleanup.execute({
      selections: [{ categoryId: 'user-temp', mode: 'all', paths: [join(cacheRoot, 'old.tmp')] }],
      mode: 'permanent',
    });
    expect(fake.removed).toEqual([join(cacheRoot, 'nested', 'old2.tmp')]);
  });

  it('refuses permanent deletion for review categories', async () => {
    const { cleanup } = service();
    await cleanup.categories(true);
    await expect(
      cleanup.execute({ selections: [{ categoryId: 'downloads', mode: 'all', paths: [] }], mode: 'permanent' }),
    ).rejects.toThrow('Lixeira');
  });

  it('reports failures and keeps going', async () => {
    const { cleanup, fake } = service({ failTrash: (path) => path.endsWith('old2.tmp') });
    await cleanup.categories(true);
    const result = await cleanup.execute({ selections: [{ categoryId: 'user-temp', mode: 'all', paths: [] }], mode: 'trash' });
    expect(result.status).toBe('partial');
    expect(result.failed).toHaveLength(1);
    expect(fake.trashed).toEqual([join(cacheRoot, 'old.tmp')]);
  });

  it('re-checks running apps at execution time', async () => {
    const running: string[] = [];
    const fake = fakeRemover(join(temp.path, '_trash'));
    const cleanup = new CleanupService({
      known: fakeKnownPaths(temp.path),
      reader: createDirectoryReader(),
      remover: fake.remover,
      history: new HistoryStore(join(temp.path, '_history')),
      emit: () => undefined,
      runningProcesses: async () => new Set(running),
      recycleBin: () => ({ available: true, itemCount: 0, size: 0 }),
      freeBytes: async () => null,
      now: () => NOW,
      categories: categories(),
    });
    await cleanup.categories(true);
    running.push('browser.exe');
    const result = await cleanup.execute({ selections: [{ categoryId: 'app-cache', mode: 'all', paths: [] }], mode: 'trash' });
    expect(result.removedCount).toBe(0);
    expect(result.skipped[0].reason).toContain('Feche');
    expect(fake.trashed).toEqual([]);
  });
});

describe('temp folder safety', () => {
  it('accepts only the standard temp folder inside LocalAppData', () => {
    const known = fakeKnownPaths('C:\\');
    expect(safeTempRoot(known)).toBe(known.temp);
    expect(safeTempRoot({ ...known, temp: 'C:\\' })).toBeNull();
    expect(safeTempRoot({ ...known, temp: 'C:\\Windows\\Temp' })).toBeNull();
    expect(safeTempRoot({ ...known, temp: known.localAppData })).toBeNull();
  });
});
