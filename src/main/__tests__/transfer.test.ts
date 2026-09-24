import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Events } from '@shared/api';
import type { TransferRecord, VolumeInfo } from '@shared/types';
import { HistoryStore } from '../history';
import { copyVerified, PARTIAL_SUFFIX, uniqueName } from '../transfer/copy';
import { TransferService } from '../transfer/service';
import { fakeKnownPaths, fakeRemover, makeTempDir, writeFile } from './helpers';

let temp: ReturnType<typeof makeTempDir>;
let home: string;
let destination: string;

function volume(freeBytes = 10 * 1024 ** 3, fileSystem = 'NTFS'): VolumeInfo {
  // The destination lives on the same physical disk in tests; report it as another volume.
  return {
    root: 'Z:\\',
    letter: 'Z',
    label: 'Teste',
    fileSystem,
    type: 'fixed',
    totalBytes: 100 * 1024 ** 3,
    freeBytes,
    usedBytes: 0,
    isSystem: false,
  };
}

function setup(options: { freeBytes?: number; fileSystem?: string; failTrash?: (path: string) => boolean } = {}) {
  const fake = fakeRemover(join(temp.path, '_trash'), { failTrash: options.failTrash });
  let finished: ((record: TransferRecord) => void) | null = null;
  const service = new TransferService({
    known: fakeKnownPaths(temp.path),
    remover: fake.remover,
    history: new HistoryStore(join(temp.path, '_history')),
    storeDirectory: join(temp.path, '_store'),
    emit: (channel, payload) => {
      if (channel === Events.transferFinished) finished?.(payload as TransferRecord);
    },
    getVolume: async () => volume(options.freeBytes, options.fileSystem),
    freeBytes: async () => 0,
  });
  const whenFinished = () => new Promise<TransferRecord>((resolve) => (finished = resolve));
  return { service, fake, whenFinished };
}

async function copyAll(service: TransferService, whenFinished: () => Promise<TransferRecord>, files: string[], extra = {}) {
  const done = whenFinished();
  const { operationId } = await service.start({
    files,
    destination,
    preserveStructure: true,
    conflictPolicy: 'rename',
    acknowledgeSynced: false,
    ...extra,
  });
  const record = await done;
  expect(record.id).toBe(operationId);
  return record;
}

beforeEach(() => {
  temp = makeTempDir();
  home = fakeKnownPaths(temp.path).home;
  destination = join(temp.path, 'dest');
  writeFile(join(home, 'Videos', 'Viagem', 'a.mp4'), randomBytes(300_000).toString('base64'));
  writeFile(join(home, 'Documents', 'b.pdf'), 'pdf content');
  writeFile(join(home, 'Documents', 'plugin.dll'), 'binary');
  writeFile(join(home, 'OneDrive', 'c.jpg'), 'photo');
});

afterEach(() => temp.cleanup());

describe('transfer preview', () => {
  it('plans destinations, blocks ineligible files and sums sizes', async () => {
    const { service } = setup();
    const preview = await service.preview({
      files: [join(home, 'Videos', 'Viagem', 'a.mp4'), join(home, 'Documents', 'b.pdf'), join(home, 'Documents', 'plugin.dll')],
      destination,
      preserveStructure: true,
    });
    expect(preview.canProceed).toBe(true);
    expect(preview.eligibleCount).toBe(2);
    expect(preview.items[0].destination).toBe(join(destination, 'Videos', 'Viagem', 'a.mp4'));
    expect(preview.items[2]).toMatchObject({ eligible: false });
    expect(preview.totalSize).toBe(400_000 + 'pdf content'.length);
  });

  it('flags conflicts, including two files with the same name in flat mode', async () => {
    writeFile(join(home, 'Pictures', 'b.pdf'), 'other');
    writeFile(join(destination, 'a.mp4'), 'existing');
    const { service } = setup();
    const preview = await service.preview({
      files: [join(home, 'Videos', 'Viagem', 'a.mp4'), join(home, 'Documents', 'b.pdf'), join(home, 'Pictures', 'b.pdf')],
      destination,
      preserveStructure: false,
    });
    expect(preview.items.map((item) => item.conflict)).toEqual([true, false, true]);
    expect(preview.conflicts).toBe(2);
  });

  it('refuses when the destination lacks space (with margin)', async () => {
    const { service } = setup({ freeBytes: 1000 });
    const preview = await service.preview({ files: [join(home, 'Documents', 'b.pdf')], destination, preserveStructure: true });
    expect(preview.canProceed).toBe(false);
    expect(preview.errors[0]).toContain('Espaço insuficiente');
  });

  it('refuses protected destinations', async () => {
    const { service } = setup();
    const preview = await service.preview({
      files: [join(home, 'Documents', 'b.pdf')],
      destination: 'C:\\Windows\\Temp',
      preserveStructure: true,
    });
    expect(preview.canProceed).toBe(false);
  });

  it('requires acknowledging synced files', async () => {
    const { service } = setup();
    const preview = await service.preview({ files: [join(home, 'OneDrive', 'c.jpg')], destination, preserveStructure: true });
    expect(preview.syncedCount).toBe(1);
    await expect(
      service.start({
        files: [join(home, 'OneDrive', 'c.jpg')],
        destination,
        preserveStructure: true,
        conflictPolicy: 'rename',
        acknowledgeSynced: false,
      }),
    ).rejects.toThrow('sincronizados');
  });
});

describe('copy, removal and undo', () => {
  it('copies, verifies and keeps the originals', async () => {
    const { service, whenFinished } = setup();
    const source = join(home, 'Videos', 'Viagem', 'a.mp4');
    const record = await copyAll(service, whenFinished, [source, join(home, 'Documents', 'plugin.dll')]);
    expect(record.status).toBe('completed');
    expect(record.items).toHaveLength(1);
    const [item] = record.items;
    expect(item.status).toBe('copied');
    expect(item.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(item.destination)).toEqual(readFileSync(source));
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(join(destination, 'Videos', 'Viagem')).some((name) => name.endsWith(PARTIAL_SUFFIX))).toBe(false);
  });

  it('renames or skips on name conflicts, never overwriting', async () => {
    writeFile(join(destination, 'Documents', 'b.pdf'), 'existing');
    const renamed = setup();
    const record = await copyAll(renamed.service, renamed.whenFinished, [join(home, 'Documents', 'b.pdf')]);
    expect(record.items[0].destination).toBe(join(destination, 'Documents', 'b (2).pdf'));
    expect(readFileSync(join(destination, 'Documents', 'b.pdf'), 'utf8')).toBe('existing');

    const skipped = setup();
    const second = await copyAll(skipped.service, skipped.whenFinished, [join(home, 'Documents', 'b.pdf')], {
      conflictPolicy: 'skip',
    });
    expect(second.items[0].status).toBe('skipped-conflict');
    expect(second.status).toBe('failed');
  });

  it('removes originals only as a separate step, then undo brings them back', async () => {
    const { service, whenFinished, fake } = setup();
    const source = join(home, 'Videos', 'Viagem', 'a.mp4');
    const original = readFileSync(source);
    const record = await copyAll(service, whenFinished, [source]);

    const removal = await service.removeOriginals({ operationId: record.id, mode: 'trash' });
    expect(removal.removedCount).toBe(1);
    expect(existsSync(source)).toBe(false);
    expect(fake.trashed).toEqual([source]);
    expect(removal.record.items[0].originalStatus).toBe('trashed');

    const undo = await service.undo(record.id);
    expect(undo.restoredCount).toBe(1);
    expect(undo.failed).toEqual([]);
    expect(readFileSync(source)).toEqual(original);
    expect(existsSync(record.items[0].destination)).toBe(false);
    // Folders created for the copy are cleaned up, the destination itself stays.
    expect(existsSync(join(destination, 'Videos'))).toBe(false);
    expect(existsSync(destination)).toBe(true);
    expect((await service.get(record.id))?.undoneAt).toBeTypeOf('number');
  });

  it('keeps an original that changed after the copy', async () => {
    const { service, whenFinished } = setup();
    const source = join(home, 'Documents', 'b.pdf');
    const record = await copyAll(service, whenFinished, [source]);
    writeFileSync(source, 'edited after the copy');
    const removal = await service.removeOriginals({ operationId: record.id, mode: 'permanent' });
    expect(removal.removedCount).toBe(0);
    expect(removal.failed[0].reason).toContain('alterado');
    expect(existsSync(source)).toBe(true);
  });

  it('undo before removal deletes only the copies', async () => {
    const { service, whenFinished } = setup();
    const source = join(home, 'Documents', 'b.pdf');
    const record = await copyAll(service, whenFinished, [source]);
    const undo = await service.undo(record.id);
    expect(undo.removedCopies).toBe(1);
    expect(undo.restoredCount).toBe(0);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(record.items[0].destination)).toBe(false);
  });

  it('does not remove a copy that was modified in the destination', async () => {
    const { service, whenFinished } = setup();
    const source = join(home, 'Documents', 'b.pdf');
    const record = await copyAll(service, whenFinished, [source]);
    writeFileSync(record.items[0].destination, 'edited in the destination');
    const undo = await service.undo(record.id);
    expect(undo.failed).toHaveLength(1);
    expect(existsSync(record.items[0].destination)).toBe(true);
  });

  it('cancelling leaves originals intact and no partial files', async () => {
    const { service, whenFinished } = setup();
    const big = join(home, 'Videos', 'big.mkv');
    writeFile(big, 64 * 1024 * 1024);
    const done = whenFinished();
    const { operationId } = await service.start({
      files: [big],
      destination,
      preserveStructure: false,
      conflictPolicy: 'rename',
      acknowledgeSynced: false,
    });
    service.cancel(operationId);
    const record = await done;
    expect(record.status).toBe('cancelled');
    expect(existsSync(big)).toBe(true);
    expect(existsSync(join(destination, 'big.mkv'))).toBe(false);
    expect(existsSync(join(destination, 'big.mkv' + PARTIAL_SUFFIX))).toBe(false);
  });
});

describe('copy helpers', () => {
  it('never overwrites an existing destination', async () => {
    writeFile(join(temp.path, 'x', 'src.txt'), 'new');
    writeFile(join(temp.path, 'x', 'dst.txt'), 'old');
    await expect(
      copyVerified(join(temp.path, 'x', 'src.txt'), join(temp.path, 'x', 'dst.txt'), { expectedSize: 3 }),
    ).rejects.toThrow('Já existe');
    expect(readFileSync(join(temp.path, 'x', 'dst.txt'), 'utf8')).toBe('old');
  });

  it('rejects content that does not match the expected hash', async () => {
    writeFile(join(temp.path, 'x', 'src.txt'), 'abc');
    await expect(
      copyVerified(join(temp.path, 'x', 'src.txt'), join(temp.path, 'x', 'out.txt'), { expectedSize: 3, expectedHash: 'f'.repeat(64) }),
    ).rejects.toThrow();
    expect(existsSync(join(temp.path, 'x', 'out.txt'))).toBe(false);
  });

  it('finds a free name', async () => {
    writeFile(join(temp.path, 'n', 'foto.jpg'), 'a');
    writeFile(join(temp.path, 'n', 'foto (2).jpg'), 'a');
    const claimed = new Set([join(temp.path, 'n', 'foto (3).jpg').toLowerCase()]);
    expect(await uniqueName(join(temp.path, 'n', 'foto.jpg'), claimed)).toBe(join(temp.path, 'n', 'foto (4).jpg'));
  });
});
