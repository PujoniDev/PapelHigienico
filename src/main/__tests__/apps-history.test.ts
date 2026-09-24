import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatBytes } from '@shared/format';
import { parseCommandLine, uninstallCommand } from '../apps';
import { HistoryStore } from '../history';
import { SettingsStore } from '../settings';
import { makeTempDir } from './helpers';

describe('uninstall command lines', () => {
  it.each([
    ['"C:\\Program Files\\App\\unins000.exe"', 'C:\\Program Files\\App\\unins000.exe', ''],
    ['"C:\\Program Files\\App\\uninstall.exe" /S --x', 'C:\\Program Files\\App\\uninstall.exe', '/S --x'],
    ['C:\\Program Files\\App Name\\uninst.exe /quiet', 'C:\\Program Files\\App Name\\uninst.exe', '/quiet'],
    ['MsiExec.exe /I{12345678-1234-1234-1234-123456789012}', 'MsiExec.exe', '/I{12345678-1234-1234-1234-123456789012}'],
    ['rundll32.exe dfshim.dll,ShArpMaintain app.application', 'rundll32.exe', 'dfshim.dll,ShArpMaintain app.application'],
  ])('parses %s', (command, file, args) => {
    expect(parseCommandLine(command)).toEqual({ file, args });
  });

  it('uses msiexec /x for Windows Installer products', () => {
    const key = '{12345678-1234-1234-1234-123456789012}';
    expect(uninstallCommand({ Hive: 'HKLM64', Key: key, WindowsInstaller: 1, UninstallString: `MsiExec.exe /I${key}` })).toEqual({
      file: 'msiexec.exe',
      args: `/x ${key}`,
    });
  });

  it('returns null without an uninstaller', () => {
    expect(uninstallCommand({ Hive: 'HKCU', Key: 'x' })).toBeNull();
  });
});

describe('history store', () => {
  let temp: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    temp = makeTempDir();
  });
  afterEach(() => temp.cleanup());

  const base = {
    type: 'cleanup' as const,
    title: 'Limpeza',
    startedAt: 1,
    finishedAt: 2,
    status: 'completed' as const,
    itemCount: 1,
    estimatedBytes: 10,
    freedBytes: null,
    summary: 'ok',
  };

  it('stores newest first, with optional reports, and clears', async () => {
    const store = new HistoryStore(join(temp.path, 'h'));
    await store.add(base);
    const second = await store.add({ ...base, title: 'Segunda' }, { lines: [{ label: 'a', value: 'b' }], items: [] });
    const list = await store.list();
    expect(list.map((entry) => entry.title)).toEqual(['Segunda', 'Limpeza']);
    expect((await store.report(second.id))?.lines).toEqual([{ label: 'a', value: 'b' }]);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('serializes concurrent writes', async () => {
    const store = new HistoryStore(join(temp.path, 'h'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add({ ...base, title: `#${i}` })));
    expect(await store.list()).toHaveLength(20);
  });

  it('keeps valid settings and rejects invalid ones', async () => {
    const store = new SettingsStore(join(temp.path, 's'));
    expect((await store.get()).largeFileThresholdMB).toBe(500);
    expect((await store.update({ theme: 'dark' })).theme).toBe('dark');
    await expect(store.update({ largeFileThresholdMB: -1 })).rejects.toThrow();
    expect((await new SettingsStore(join(temp.path, 's')).get()).theme).toBe('dark');
  });
});

describe('formatting', () => {
  it('formats sizes with pt-BR decimals', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(formatBytes(null)).toBe('—');
  });
});
