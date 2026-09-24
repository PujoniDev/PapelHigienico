import { randomUUID } from 'node:crypto';
import { promises as fsp, realpath } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Events, type EventChannel } from '@shared/api';
import { categoryOf, extensionOf } from '@shared/categories';
import { formatBytes, plural } from '@shared/format';
import type {
  FailedItem,
  FileEntry,
  RemoveOriginalsRequest,
  RemoveOriginalsResult,
  TransferClassification,
  TransferItem,
  TransferPreview,
  TransferPreviewItem,
  TransferPreviewRequest,
  TransferProgress,
  TransferRecord,
  TransferStartRequest,
  UndoTransferResult,
  VolumeInfo,
} from '@shared/types';
import { describeFsError, type FileRemover } from '../file-ops';
import type { HistoryStore } from '../history';
import { readJson, SerialQueue, writeJsonAtomic } from '../json-file';
import {
  classifyTransferSource,
  isDrivePath,
  isWithin,
  normalizePath,
  protectedReason,
  relativeDestination,
  samePath,
  volumeRootOf,
  type KnownPaths,
} from '../policy';
import { measuredGain } from '../volumes';
import { copyVerified, pathExists, PARTIAL_SUFFIX, uniqueName } from './copy';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const FAT32_MAX_FILE = 4 * GB - 1;
const MTIME_TOLERANCE_MS = 2;
// fs.realpath.native resolves junctions and symlinks through the OS (GetFinalPathNameByHandle).
const realpathNative = promisify(realpath.native);

export interface TransferDeps {
  known: KnownPaths;
  remover: FileRemover;
  history: HistoryStore;
  storeDirectory: string;
  emit(channel: EventChannel, payload: unknown): void;
  getVolume(root: string): Promise<VolumeInfo | null>;
  freeBytes(root: string): Promise<number | null>;
}

/** Safety margin kept free on the destination on top of the files themselves. */
export function destinationMargin(volume: VolumeInfo | null): number {
  if (!volume) return GB;
  return Math.max(100 * MB, Math.min(GB, volume.totalBytes * 0.02));
}

function sameMtime(a: number, b: number): boolean {
  return Math.abs(a - b) <= MTIME_TOLERANCE_MS;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fsp.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when no folder on the way to `path` is a symlink or junction. */
async function pathHasNoLinks(folder: string): Promise<boolean> {
  try {
    return samePath(await realpathNative(folder), folder);
  } catch {
    return false;
  }
}

/** Nearest existing ancestor of a path (the destination folder may not exist yet). */
async function nearestExisting(path: string): Promise<string | null> {
  let current = path;
  for (;;) {
    if (await pathExists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export class TransferService {
  private readonly queue = new SerialQueue();
  private active: { record: TransferRecord; abort: AbortController } | null = null;
  private busy = false;

  constructor(private readonly deps: TransferDeps) {}

  private recordPath(id: string): string {
    return join(this.deps.storeDirectory, 'transfers', `${id.replace(/[^a-f0-9-]/gi, '')}.json`);
  }

  private save(record: TransferRecord): Promise<void> {
    const snapshot = structuredClone(record);
    return this.queue.run(() => writeJsonAtomic(this.recordPath(record.id), { version: 1, record: snapshot }));
  }

  async get(id: string): Promise<TransferRecord | null> {
    if (this.active?.record.id === id) return structuredClone(this.active.record);
    const stored = await readJson<{ version: number; record: TransferRecord }>(this.recordPath(id));
    if (stored?.version !== 1 || !stored.record) return null;
    const record = stored.record;
    // The app was closed during the copy: mark what was in flight and drop partial files.
    if (record.status === 'running') {
      for (const item of record.items) {
        if (item.status === 'copying' || item.status === 'pending') {
          item.status = 'failed';
          item.error = 'A transferência foi interrompida.';
          await fsp.rm(item.destination + PARTIAL_SUFFIX, { force: true }).catch(() => undefined);
        }
      }
      record.status = record.items.some((item) => item.status === 'copied') ? 'partial' : 'failed';
      record.finishedAt ??= Date.now();
      await this.save(record);
    }
    return record;
  }

  classify(paths: string[]): TransferClassification[] {
    return paths.map((path) => classifyTransferSource(path, this.deps.known));
  }

  async fileEntry(path: string): Promise<FileEntry | null> {
    try {
      const normalized = normalizePath(path);
      const stats = await fsp.lstat(normalized);
      if (!stats.isFile()) return null;
      const name = basename(normalized);
      return {
        path: normalized,
        name,
        folder: dirname(normalized),
        size: stats.size,
        sizeOnDisk: stats.size,
        modifiedMs: stats.mtimeMs,
        extension: extensionOf(name),
        category: categoryOf(name),
        hidden: false,
        cloud: false,
      };
    } catch {
      return null;
    }
  }

  async preview(request: TransferPreviewRequest): Promise<TransferPreview> {
    const known = this.deps.known;
    const errors: string[] = [];
    const destination = normalizePath(request.destination);
    let destinationVolume: VolumeInfo | null = null;

    if (!isDrivePath(destination)) {
      errors.push('Escolha uma pasta em um disco com letra (ex.: D:\\).');
    } else {
      const why = protectedReason(destination, known);
      if (why) errors.push(`Esta pasta de destino não pode ser usada. ${why}`);
      destinationVolume = await this.deps.getVolume(volumeRootOf(destination));
      if (!destinationVolume) errors.push('Não foi possível acessar o disco de destino.');
      const existing = await nearestExisting(destination);
      if (!existing || !(await isDirectory(existing))) errors.push('A pasta de destino não existe.');
      else if (!(await pathHasNoLinks(existing))) errors.push('A pasta de destino passa por um link ou junção de pasta.');
    }

    const seen = new Set<string>();
    const claimed = new Set<string>();
    const items: TransferPreviewItem[] = [];
    for (const file of request.files) {
      const classification = classifyTransferSource(file, known);
      const key = classification.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const item: TransferPreviewItem = {
        source: classification.path,
        destination: '',
        size: 0,
        sizeOnDisk: 0,
        modifiedMs: 0,
        eligible: classification.eligible,
        blockedReason: classification.blockedReason,
        warnings: [...classification.warnings],
        synced: classification.synced,
        conflict: false,
      };
      items.push(item);
      if (!item.eligible) continue;

      const block = (reason: string) => {
        item.eligible = false;
        item.blockedReason = reason;
      };
      let stats;
      try {
        stats = await fsp.lstat(item.source);
      } catch (error) {
        block(describeFsError(error));
        continue;
      }
      if (!stats.isFile()) {
        block(stats.isSymbolicLink() ? 'É um atalho (link), não um arquivo.' : 'Somente arquivos individuais podem ser movidos.');
        continue;
      }
      item.size = stats.size;
      item.sizeOnDisk = stats.size;
      item.modifiedMs = stats.mtimeMs;
      if (!(await pathHasNoLinks(dirname(item.source)))) {
        block('O caminho passa por um link ou junção de pasta.');
        continue;
      }
      if (destinationVolume && volumeRootOf(item.source) === destinationVolume.root) {
        block('O arquivo já está no disco de destino.');
        continue;
      }
      if (destinationVolume?.fileSystem.toUpperCase() === 'FAT32' && item.size > FAT32_MAX_FILE) {
        block('O disco de destino (FAT32) não aceita arquivos maiores que 4 GB.');
        continue;
      }
      item.destination = request.preserveStructure
        ? join(destination, relativeDestination(item.source, known))
        : join(destination, basename(item.source));
      const destinationKey = item.destination.toLowerCase();
      item.conflict = claimed.has(destinationKey) || (await pathExists(item.destination));
      claimed.add(destinationKey);
    }

    const eligible = items.filter((item) => item.eligible);
    const totalSize = eligible.reduce((sum, item) => sum + item.size, 0);
    const requiredWithMargin = totalSize + destinationMargin(destinationVolume);
    if (eligible.length === 0) errors.push('Nenhum dos arquivos selecionados pode ser movido.');
    if (destinationVolume && eligible.length > 0 && requiredWithMargin > destinationVolume.freeBytes) {
      errors.push(
        `Espaço insuficiente no destino: são necessários ${formatBytes(requiredWithMargin)} (com margem de segurança) e há ${formatBytes(destinationVolume.freeBytes)} livres.`,
      );
    }

    return {
      items,
      destination,
      destinationVolume,
      eligibleCount: eligible.length,
      totalSize,
      freedOnSource: eligible.reduce((sum, item) => sum + item.sizeOnDisk, 0),
      requiredWithMargin,
      conflicts: eligible.filter((item) => item.conflict).length,
      syncedCount: eligible.filter((item) => item.synced).length,
      errors,
      canProceed: errors.length === 0,
    };
  }

  private ensureIdle(): void {
    if (this.active || this.busy) throw new Error('Aguarde a operação de transferência em andamento terminar.');
  }

  async start(request: TransferStartRequest): Promise<{ operationId: string }> {
    this.ensureIdle();
    this.busy = true;
    try {
      const preview = await this.preview(request);
      if (!preview.canProceed) throw new Error(preview.errors[0]);
      if (preview.syncedCount > 0 && !request.acknowledgeSynced) {
        throw new Error('Confirme o aviso sobre arquivos sincronizados antes de continuar.');
      }
      const claimed = new Set<string>();
      const items: TransferItem[] = [];
      for (const item of preview.items.filter((candidate) => candidate.eligible)) {
        let destination = item.destination;
        let status: TransferItem['status'] = 'pending';
        if (item.conflict || claimed.has(destination.toLowerCase())) {
          if (request.conflictPolicy === 'skip') status = 'skipped-conflict';
          else destination = await uniqueName(destination, claimed);
        }
        claimed.add(destination.toLowerCase());
        items.push({
          id: items.length,
          source: item.source,
          destination,
          size: item.size,
          sourceModifiedMs: item.modifiedMs,
          status,
          originalStatus: 'kept',
        });
      }
      const record: TransferRecord = {
        id: randomUUID(),
        createdAt: Date.now(),
        status: 'running',
        destinationRoot: preview.destination,
        preserveStructure: request.preserveStructure,
        conflictPolicy: request.conflictPolicy,
        items,
      };
      await fsp.mkdir(preview.destination, { recursive: true });
      await this.save(record);
      const abort = new AbortController();
      this.active = { record, abort };
      void this.run(record, abort.signal);
      return { operationId: record.id };
    } finally {
      this.busy = false;
    }
  }

  cancel(operationId: string): void {
    if (this.active?.record.id === operationId) this.active.abort.abort();
  }

  private async run(record: TransferRecord, signal: AbortSignal): Promise<void> {
    const pending = record.items.filter((item) => item.status === 'pending');
    const bytesTotal = pending.reduce((sum, item) => sum + item.size, 0) * 2;
    let bytesDone = 0;
    let lastEmit = 0;
    const emit = (item: TransferItem, index: number, phase: TransferProgress['phase'], force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 100) return;
      lastEmit = now;
      const progress: TransferProgress = {
        operationId: record.id,
        phase,
        fileIndex: index,
        fileCount: pending.length,
        currentFile: item.source,
        bytesDone,
        bytesTotal,
      };
      this.deps.emit(Events.transferProgress, progress);
    };

    for (let index = 0; index < pending.length; index++) {
      const item = pending[index];
      if (signal.aborted) {
        item.status = 'cancelled';
        continue;
      }
      const countedBefore = bytesDone;
      try {
        const stats = await fsp.lstat(item.source);
        if (!stats.isFile() || stats.size !== item.size || !sameMtime(stats.mtimeMs, item.sourceModifiedMs)) {
          item.status = 'skipped-changed';
          item.error = 'O arquivo mudou desde a revisão.';
          bytesDone += item.size * 2;
          continue;
        }
        item.status = 'copying';
        emit(item, index, 'copying', true);
        await fsp.mkdir(dirname(item.destination), { recursive: true });
        item.hash = await copyVerified(item.source, item.destination, {
          signal,
          expectedSize: item.size,
          onBytes: (bytes, phase) => {
            bytesDone += bytes;
            emit(item, index, phase);
          },
        });
        await fsp.utimes(item.destination, stats.atime, stats.mtime);
        const after = await fsp.lstat(item.source);
        if (after.size !== item.size || !sameMtime(after.mtimeMs, item.sourceModifiedMs)) {
          // The original changed while it was being copied: the copy is not trustworthy.
          await fsp.rm(item.destination, { force: true });
          item.hash = undefined;
          throw new Error('O arquivo foi alterado durante a cópia.');
        }
        item.status = 'copied';
      } catch (error) {
        item.status = signal.aborted ? 'cancelled' : 'failed';
        item.error = signal.aborted ? 'Cancelado.' : describeFsError(error, 'copy');
      }
      bytesDone = countedBefore + item.size * 2;
      await this.save(record);
    }

    const copied = record.items.filter((item) => item.status === 'copied');
    record.status = signal.aborted
      ? 'cancelled'
      : copied.length === 0
        ? 'failed'
        : copied.length === record.items.length
          ? 'completed'
          : 'partial';
    record.finishedAt = Date.now();
    await this.save(record);
    this.active = null;
    this.deps.emit(Events.transferFinished, structuredClone(record));
    await this.recordHistory(record).catch(() => undefined);
  }

  private async recordHistory(record: TransferRecord): Promise<void> {
    const copied = record.items.filter((item) => item.status === 'copied');
    const copiedSize = copied.reduce((sum, item) => sum + item.size, 0);
    await this.deps.history.add(
      {
        type: 'transfer',
        title: `Cópia para ${record.destinationRoot}`,
        startedAt: record.createdAt,
        finishedAt: record.finishedAt ?? Date.now(),
        status: record.status === 'running' ? 'failed' : record.status,
        itemCount: copied.length,
        estimatedBytes: record.items.reduce((sum, item) => sum + item.size, 0),
        freedBytes: null,
        summary: `${plural(copied.length, 'arquivo copiado e verificado', 'arquivos copiados e verificados')} (${formatBytes(copiedSize)}). Os originais foram mantidos.`,
        transferId: record.id,
      },
      {
        lines: [
          { label: 'Destino', value: record.destinationRoot },
          { label: 'Estrutura de pastas', value: record.preserveStructure ? 'Mantida' : 'Todos na mesma pasta' },
          { label: 'Nomes repetidos', value: record.conflictPolicy === 'rename' ? 'Renomear' : 'Pular' },
          { label: 'Copiados e verificados', value: `${copied.length} de ${record.items.length}` },
        ],
        items: record.items.map((item) => ({
          path: item.source,
          detail: item.status === 'copied' ? `→ ${item.destination}` : (item.error ?? statusLabel(item.status)),
          ok: item.status === 'copied',
        })),
      },
    );
  }

  async removeOriginals(request: RemoveOriginalsRequest): Promise<RemoveOriginalsResult> {
    this.ensureIdle();
    this.busy = true;
    try {
      const record = await this.get(request.operationId);
      if (!record) throw new Error('Transferência não encontrada.');
      if (record.undoneAt) throw new Error('Esta transferência foi desfeita.');
      const candidates = record.items.filter(
        (item) => item.status === 'copied' && !item.restored && !item.destinationRemoved && (item.originalStatus === 'kept' || item.originalStatus === 'remove-failed'),
      );
      if (candidates.length === 0) throw new Error('Não há originais para remover.');

      const volumes = [...new Set(candidates.map((item) => volumeRootOf(item.source)))];
      const before = await Promise.all(volumes.map((root) => this.deps.freeBytes(root)));
      const failed: FailedItem[] = [];
      let removedCount = 0;
      let removedSize = 0;
      for (const item of candidates) {
        const reason = await this.checkOriginalRemovable(item);
        if (reason) {
          item.originalStatus = 'remove-failed';
          item.originalError = reason;
          failed.push({ path: item.source, reason });
          continue;
        }
        try {
          if (request.mode === 'trash') await this.deps.remover.trash(item.source);
          else await this.deps.remover.remove(item.source);
          item.originalStatus = request.mode === 'trash' ? 'trashed' : 'deleted';
          item.originalError = undefined;
          removedCount++;
          removedSize += item.size;
        } catch (error) {
          const why = describeFsError(error, request.mode === 'trash' ? 'trash' : 'remove');
          item.originalStatus = 'remove-failed';
          item.originalError = why;
          failed.push({ path: item.source, reason: why });
        }
      }
      const after = await Promise.all(volumes.map((root) => this.deps.freeBytes(root)));
      const freedBytes = measuredGain(before, after);
      record.removal = { at: Date.now(), mode: request.mode, freedBytes };
      await this.save(record);

      const verb = request.mode === 'trash' ? 'enviados para a Lixeira' : 'excluídos permanentemente';
      await this.deps.history
        .add(
          {
            type: 'transfer-remove',
            title: `Originais ${verb}`,
            startedAt: record.removal.at,
            finishedAt: Date.now(),
            status: removedCount === 0 ? 'failed' : failed.length ? 'partial' : 'completed',
            itemCount: removedCount,
            estimatedBytes: removedSize,
            freedBytes: request.mode === 'permanent' ? freedBytes : null,
            summary: `${plural(removedCount, 'original', 'originais')} (${formatBytes(removedSize)}) ${verb}; as cópias estão em ${record.destinationRoot}.`,
            transferId: record.id,
          },
          {
            lines: [
              { label: 'Modo', value: request.mode === 'trash' ? 'Enviar para a Lixeira' : 'Excluir permanentemente' },
              { label: 'Espaço livre ganho (medido)', value: freedBytes === null ? 'Não medido' : formatBytes(freedBytes) },
            ],
            items: candidates.map((item) => ({
              path: item.source,
              detail: item.originalStatus === 'remove-failed' ? (item.originalError ?? 'Falhou') : `Cópia em ${item.destination}`,
              ok: item.originalStatus !== 'remove-failed',
            })),
          },
        )
        .catch(() => undefined);

      return { record, removedCount, removedSize, failed, freedBytes };
    } finally {
      this.busy = false;
    }
  }

  /** The original may only go once its verified copy is intact and the original is unchanged. */
  private async checkOriginalRemovable(item: TransferItem): Promise<string | null> {
    if (!classifyTransferSource(item.source, this.deps.known).eligible) return 'O original está em uma pasta protegida.';
    try {
      const original = await fsp.lstat(item.source);
      if (!original.isFile() || original.size !== item.size || !sameMtime(original.mtimeMs, item.sourceModifiedMs)) {
        return 'O original foi alterado depois da cópia; ele foi mantido.';
      }
    } catch (error) {
      return describeFsError(error);
    }
    try {
      const copy = await fsp.lstat(item.destination);
      if (!copy.isFile() || copy.size !== item.size) return 'A cópia no destino mudou ou foi removida; o original foi mantido.';
    } catch {
      return 'A cópia no destino não foi encontrada; o original foi mantido.';
    }
    return null;
  }

  async undo(operationId: string): Promise<UndoTransferResult> {
    this.ensureIdle();
    this.busy = true;
    try {
      const record = await this.get(operationId);
      if (!record) throw new Error('Transferência não encontrada.');
      if (record.undoneAt) throw new Error('Esta transferência já foi desfeita.');
      const targets = record.items.filter((item) => item.status === 'copied' && !item.restored && !item.destinationRemoved);
      if (targets.length === 0) throw new Error('Não há nada para desfazer.');

      const failed: FailedItem[] = [];
      let restoredCount = 0;
      let removedCopies = 0;
      const touched = new Set<string>();
      for (const item of targets) {
        try {
          const copy = await fsp.lstat(item.destination).catch(() => null);
          if (!copy || !copy.isFile()) throw new Error('A cópia no destino não foi encontrada.');
          if (copy.size !== item.size || !sameMtime(copy.mtimeMs, item.sourceModifiedMs)) {
            throw new Error('A cópia no destino foi alterada; nada foi feito com este arquivo.');
          }
          if (item.originalStatus === 'trashed' || item.originalStatus === 'deleted') {
            if (await pathExists(item.source)) throw new Error('Já existe um arquivo no local original.');
            await fsp.mkdir(dirname(item.source), { recursive: true });
            await copyVerified(item.destination, item.source, { expectedSize: item.size, expectedHash: item.hash });
            await fsp.utimes(item.source, copy.atime, copy.mtime);
            item.restored = true;
            item.originalStatus = 'kept';
            restoredCount++;
          } else {
            const original = await fsp.lstat(item.source).catch(() => null);
            if (!original || original.size !== item.size || !sameMtime(original.mtimeMs, item.sourceModifiedMs)) {
              throw new Error('O original não está intacto; a cópia foi mantida.');
            }
          }
          // The original is back in place (or never left): the copy is now a duplicate.
          await this.removeDuplicate(item.destination);
          item.destinationRemoved = true;
          item.undoError = undefined;
          touched.add(dirname(item.destination));
          removedCopies++;
        } catch (error) {
          item.undoError = describeFsError(error);
          failed.push({ path: item.source, reason: item.undoError });
        }
      }
      await this.removeEmptyFolders(touched, record.destinationRoot);
      if (record.items.every((item) => item.status !== 'copied' || item.destinationRemoved)) record.undoneAt = Date.now();
      await this.save(record);

      await this.deps.history
        .add(
          {
            type: 'transfer-undo',
            title: 'Transferência desfeita',
            startedAt: Date.now(),
            finishedAt: Date.now(),
            status: failed.length === 0 ? 'completed' : removedCopies > 0 ? 'partial' : 'failed',
            itemCount: removedCopies,
            estimatedBytes: null,
            freedBytes: null,
            summary:
              `${plural(restoredCount, 'arquivo devolvido', 'arquivos devolvidos')} ao local original; ` +
              `${plural(removedCopies, 'cópia removida', 'cópias removidas')} de ${record.destinationRoot}.`,
            transferId: record.id,
          },
          {
            lines: [{ label: 'Destino', value: record.destinationRoot }],
            items: targets.map((item) => ({
              path: item.source,
              detail: item.undoError ?? (item.restored ? 'Devolvido ao local original' : 'Cópia removida do destino'),
              ok: !item.undoError,
            })),
          },
        )
        .catch(() => undefined);

      return { record, restoredCount, removedCopies, failed };
    } finally {
      this.busy = false;
    }
  }

  /** Removes a verified duplicate: Recycle Bin first, permanent only when the drive has no Recycle Bin. */
  private async removeDuplicate(path: string): Promise<void> {
    try {
      await this.deps.remover.trash(path);
    } catch {
      await this.deps.remover.remove(path);
    }
  }

  private async removeEmptyFolders(folders: Set<string>, root: string): Promise<void> {
    const candidates = new Set<string>();
    for (const folder of folders) {
      let current = folder;
      while (isWithin(current, root) && !samePath(current, root)) {
        candidates.add(current);
        current = dirname(current);
      }
    }
    for (const folder of [...candidates].sort((a, b) => b.length - a.length)) {
      await fsp.rmdir(folder).catch(() => undefined);
    }
  }

  isRunning(): boolean {
    return this.active !== null;
  }
}

export function statusLabel(status: TransferItem['status']): string {
  switch (status) {
    case 'copied':
      return 'Copiado e verificado';
    case 'skipped-conflict':
      return 'Pulado: já existe no destino';
    case 'skipped-changed':
      return 'Pulado: o arquivo mudou';
    case 'failed':
      return 'Falhou';
    case 'cancelled':
      return 'Cancelado';
    case 'copying':
      return 'Copiando';
    default:
      return 'Aguardando';
  }
}
