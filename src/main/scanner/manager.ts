import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import scanWorkerPath from './worker?modulePath';
import { Events, type EventChannel } from '@shared/api';
import { categoryOf, extensionOf } from '@shared/categories';
import { formatBytes, formatCount, formatDuration, plural } from '@shared/format';
import type {
  FileEntry,
  Opportunities,
  ScanOptions,
  ScanProgress,
  ScanState,
  ScanSummary,
  VolumeInfo,
} from '@shared/types';
import type { HistoryStore } from '../history';
import { readJson, writeJsonAtomic } from '../json-file';
import { classifyTransferSource, protectedReason, volumeRootOf, type KnownPaths } from '../policy';
import { getVolume } from '../volumes';
import { createDirectoryReader, isCloudTag, isLinkTag, type DirectoryReader } from './reader';
import type { CompactScanResult, ScanInput, ScanProgressInfo } from './scan';
import { ScanIndex } from './scan-index';

const MOVABLE_MIN_SIZE = 100 * 1024 * 1024;

interface RunningScan {
  scanId: string;
  options: ScanOptions;
  worker: Worker;
  cancel: Int32Array;
  startedAt: number;
  volume: VolumeInfo | null;
  progress: ScanProgress;
}

export interface ScanManagerDeps {
  known: KnownPaths;
  history: HistoryStore;
  storeDirectory: string;
  emit(channel: EventChannel, payload: unknown): void;
}

export class ScanManager {
  private running: RunningScan | null = null;
  private index: ScanIndex | null = null;
  private summary: ScanSummary | null = null;
  private lastSummary: ScanSummary | null = null;
  private liveReader: DirectoryReader | null = null;

  constructor(private readonly deps: ScanManagerDeps) {}

  private get lastScanPath(): string {
    return join(this.deps.storeDirectory, 'last-scan.json');
  }

  async init(): Promise<void> {
    const stored = await readJson<{ version: number; summary: ScanSummary }>(this.lastScanPath);
    if (stored?.version === 1 && stored.summary?.scanId) this.lastSummary = stored.summary;
  }

  state(): ScanState {
    if (this.running) {
      return {
        status: 'running',
        progress: this.running.progress,
        options: this.running.options,
        lastSummary: this.summary ?? this.lastSummary,
      };
    }
    if (this.summary && this.index) return { status: 'ready', summary: this.summary };
    return { status: 'idle', lastSummary: this.summary ?? this.lastSummary };
  }

  requireIndex(scanId: string): ScanIndex {
    if (!this.index || this.index.scanId !== scanId) {
      throw new Error('Os resultados desta análise não estão mais disponíveis. Faça uma nova análise.');
    }
    return this.index;
  }

  async start(options: ScanOptions): Promise<{ scanId: string }> {
    if (this.running) throw new Error('Já existe uma análise em andamento.');
    const root = volumeRootOf(options.root);
    const volume = await getVolume(root);
    if (!volume) throw new Error(`Não foi possível acessar o disco ${root}.`);

    const excludePaths: string[] = [];
    const usersRoot = dirname(this.deps.known.home);
    if (!options.includeUserFolders && volumeRootOf(usersRoot) === root) excludePaths.push(usersRoot);

    const input: ScanInput = {
      root,
      includeHidden: options.includeHidden,
      excludePaths,
      dedupeHardLinks: volume.fileSystem.toUpperCase() === 'NTFS',
    };
    const scanId = randomUUID();
    const cancelBuffer = new SharedArrayBuffer(4);
    const worker = new Worker(scanWorkerPath, { workerData: { input, cancel: cancelBuffer } });
    const startedAt = Date.now();
    const normalizedOptions: ScanOptions = { ...options, root };
    this.running = {
      scanId,
      options: normalizedOptions,
      worker,
      cancel: new Int32Array(cancelBuffer),
      startedAt,
      volume,
      progress: {
        scanId,
        root,
        currentPath: root,
        filesScanned: 0,
        dirsScanned: 0,
        bytesScanned: 0,
        inaccessible: 0,
        elapsedMs: 0,
        estimatedRatio: 0,
      },
    };
    // A new scan replaces the previous results.
    this.index = null;
    this.summary = null;

    let settled = false;
    worker.on('message', (message: { type: string; info?: ScanProgressInfo; result?: CompactScanResult; message?: string }) => {
      if (message.type === 'progress' && message.info) this.onProgress(scanId, message.info);
      else if (message.type === 'done' && message.result) {
        settled = true;
        void this.finish(scanId, message.result, null);
      } else if (message.type === 'error') {
        settled = true;
        void this.finish(scanId, null, message.message ?? 'Erro desconhecido');
      }
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      void this.finish(scanId, null, error.message);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      void this.finish(scanId, null, `A análise terminou inesperadamente (código ${code}).`);
    });
    this.deps.emit(Events.scanProgress, this.running.progress);
    return { scanId };
  }

  cancel(scanId: string): void {
    if (this.running?.scanId === scanId) Atomics.store(this.running.cancel, 0, 1);
  }

  private onProgress(scanId: string, info: ScanProgressInfo): void {
    const running = this.running;
    if (!running || running.scanId !== scanId) return;
    const used = running.volume?.usedBytes ?? 0;
    running.progress = {
      scanId,
      root: running.options.root,
      ...info,
      elapsedMs: Date.now() - running.startedAt,
      estimatedRatio: used > 0 ? Math.min(0.99, info.bytesScanned / used) : null,
    };
    this.deps.emit(Events.scanProgress, running.progress);
  }

  private async finish(scanId: string, result: CompactScanResult | null, errorMessage: string | null): Promise<void> {
    const running = this.running;
    if (!running || running.scanId !== scanId) return;
    this.running = null;
    const finishedAt = Date.now();

    let summary: ScanSummary;
    if (result) {
      const index = new ScanIndex(scanId, result);
      this.index = index;
      summary = {
        scanId,
        root: running.options.root,
        options: running.options,
        status: result.cancelled ? 'cancelled' : 'completed',
        startedAt: running.startedAt,
        finishedAt,
        totalSize: result.size[0],
        logicalSize: result.logicalSize[0],
        fileCount: result.fileCount[0],
        folderCount: result.folderCount[0],
        inaccessibleCount: result.inaccessibleCount,
        inaccessibleSamples: result.inaccessibleSamples,
        skippedLinks: result.skippedLinks,
        skippedHidden: result.skippedHidden,
        skippedUserFolders: result.excludedHit.length > 0,
        hardLinkDuplicateBytes: result.hardLinkDuplicateBytes,
        volume: running.volume
          ? { totalBytes: running.volume.totalBytes, usedBytes: running.volume.usedBytes, freeBytes: running.volume.freeBytes }
          : null,
        topFolders: index.topFolders(5),
        limitedMetadata: result.limitedMetadata,
      };
    } else {
      summary = {
        scanId,
        root: running.options.root,
        options: running.options,
        status: 'failed',
        startedAt: running.startedAt,
        finishedAt,
        totalSize: 0,
        logicalSize: 0,
        fileCount: 0,
        folderCount: 0,
        inaccessibleCount: 0,
        inaccessibleSamples: [],
        skippedLinks: 0,
        skippedHidden: { files: 0, folders: 0, fileBytes: 0 },
        skippedUserFolders: false,
        hardLinkDuplicateBytes: 0,
        volume: null,
        topFolders: [],
        limitedMetadata: false,
        errorMessage: errorMessage ?? undefined,
      };
    }

    this.summary = summary;
    this.lastSummary = summary;
    this.deps.emit(Events.scanFinished, summary);
    await writeJsonAtomic(this.lastScanPath, { version: 1, summary }).catch(() => undefined);
    await this.recordHistory(summary).catch(() => undefined);
  }

  private async recordHistory(summary: ScanSummary): Promise<void> {
    const statusText =
      summary.status === 'failed'
        ? `Falhou: ${summary.errorMessage ?? ''}`
        : `${formatBytes(summary.totalSize)} em ${plural(summary.fileCount, 'arquivo', 'arquivos')}` +
          (summary.inaccessibleCount ? `; ${plural(summary.inaccessibleCount, 'pasta sem acesso', 'pastas sem acesso')}` : '');
    await this.deps.history.add(
      {
        type: 'scan',
        title: `Análise de ${summary.root}`,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        status: summary.status,
        itemCount: summary.fileCount,
        estimatedBytes: null,
        freedBytes: null,
        summary: statusText,
      },
      {
        lines: [
          { label: 'Disco', value: summary.root },
          { label: 'Duração', value: formatDuration(summary.finishedAt - summary.startedAt) },
          { label: 'Tamanho analisado (em disco)', value: formatBytes(summary.totalSize) },
          { label: 'Arquivos', value: formatCount(summary.fileCount) },
          { label: 'Pastas', value: formatCount(summary.folderCount) },
          { label: 'Pastas sem acesso', value: formatCount(summary.inaccessibleCount) },
          { label: 'Links e junções não seguidos', value: formatCount(summary.skippedLinks) },
          { label: 'Arquivos ocultos incluídos', value: summary.options.includeHidden ? 'Sim' : 'Não' },
          { label: 'Pastas pessoais incluídas', value: summary.options.includeUserFolders ? 'Sim' : 'Não' },
        ],
        items: summary.inaccessibleSamples.map((path) => ({ path, detail: 'Sem acesso', ok: false })),
      },
    );
  }

  /** Files directly inside a folder, read live (the scan keeps only the largest files). */
  folderFiles(scanId: string, folderId: number): FileEntry[] {
    const index = this.requireIndex(scanId);
    if (!index.hasFolder(folderId)) throw new Error('Pasta não encontrada nos resultados.');
    const folder = index.pathOf(folderId);
    this.liveReader ??= createDirectoryReader();
    const entries = this.liveReader.read(folder);
    if (!entries) throw new Error('Não foi possível ler esta pasta (acesso negado ou pasta removida).');
    const includeHidden = this.summary?.options.includeHidden ?? false;
    const separator = folder.endsWith('\\') ? '' : '\\';
    return entries
      .filter((entry) => !entry.isDirectory && !isLinkTag(entry.reparseTag) && (includeHidden || !entry.hidden))
      .sort((a, b) => b.size - a.size)
      .slice(0, 500)
      .map((entry) => ({
        path: folder + separator + entry.name,
        name: entry.name,
        folder,
        size: entry.size,
        sizeOnDisk: entry.sizeOnDisk,
        modifiedMs: entry.modifiedMs,
        extension: extensionOf(entry.name),
        category: categoryOf(entry.name),
        hidden: entry.hidden,
        cloud: isCloudTag(entry.reparseTag),
      }));
  }

  opportunities(thresholdBytes: number, volumes: VolumeInfo[]): Opportunities {
    const index = this.index;
    if (!index || !this.summary) return { scanId: null, largeFiles: null, movable: null };
    const known = this.deps.known;
    const scanRoot = this.summary.root;
    const hasOtherVolume = volumes.some((volume) => volume.root !== scanRoot && (volume.type === 'fixed' || volume.type === 'removable'));

    let largeCount = 0;
    let largeSize = 0;
    let movableCount = 0;
    let movableSize = 0;
    for (const file of index.allLargeFiles(Math.min(thresholdBytes, MOVABLE_MIN_SIZE))) {
      if (file.cloud) continue;
      if (file.size >= thresholdBytes && !protectedReason(file.path, known)) {
        largeCount++;
        largeSize += file.sizeOnDisk;
      }
      if (file.size >= MOVABLE_MIN_SIZE) {
        const classification = classifyTransferSource(file.path, known);
        if (classification.eligible && classification.personal && !classification.synced) {
          movableCount++;
          movableSize += file.sizeOnDisk;
        }
      }
    }
    return {
      scanId: index.scanId,
      largeFiles: { count: largeCount, size: largeSize, threshold: thresholdBytes },
      movable: { count: movableCount, size: movableSize, minSize: MOVABLE_MIN_SIZE, hasOtherVolume },
    };
  }

  dispose(): void {
    if (this.running) void this.running.worker.terminate();
  }
}
