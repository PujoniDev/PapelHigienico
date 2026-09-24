import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { Events, type EventChannel } from '@shared/api';
import { formatBytes, plural } from '@shared/format';
import type {
  CleanupCategory,
  CleanupCategoryId,
  CleanupItem,
  CleanupItemPage,
  CleanupItemsQuery,
  CleanupPreview,
  CleanupRequest,
  CleanupResult,
  CleanupSelection,
  FailedItem,
  OperationStatus,
  RecycleBinInfo,
} from '@shared/types';
import { describeFsError, type FileRemover } from '../file-ops';
import type { HistoryStore } from '../history';
import { isWithin, samePath, volumeRootOf, type KnownPaths } from '../policy';
import { measuredGain } from '../volumes';
import { isLinkTag, type DirectoryReader } from '../scanner/reader';
import { CLEANUP_CATEGORIES, type CleanupCategoryDef, type CleanupSourceDef } from './rules';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ItemMeta {
  item: CleanupItem;
  source: CleanupSourceDef;
  root: string;
}

interface CategoryState {
  def: CleanupCategoryDef;
  info: CleanupCategory;
  items: CleanupItem[];
  meta: Map<string, ItemMeta>;
}

export interface CleanupDeps {
  known: KnownPaths;
  reader: DirectoryReader;
  remover: FileRemover;
  history: HistoryStore;
  emit(channel: EventChannel, payload: unknown): void;
  runningProcesses(): Promise<Set<string> | null>;
  recycleBin(): RecycleBinInfo;
  freeBytes(root: string): Promise<number | null>;
  now?(): number;
  categories?: CleanupCategoryDef[];
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class CleanupService {
  private state = new Map<CleanupCategoryId, CategoryState>();
  private computing: Promise<CleanupCategory[]> | null = null;
  private executing = false;

  constructor(private readonly deps: CleanupDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get defs(): CleanupCategoryDef[] {
    return this.deps.categories ?? CLEANUP_CATEGORIES;
  }

  async categories(refresh: boolean): Promise<CleanupCategory[]> {
    if (!refresh && this.state.size > 0) {
      // The Recycle Bin changes after every cleanup sent to it; re-reading it is cheap.
      for (const state of this.state.values()) {
        if (state.def.kind !== 'recycle-bin') continue;
        const bin = this.deps.recycleBin();
        state.info = { ...state.info, itemCount: bin.itemCount, size: bin.size };
      }
      return this.defs.map((def) => this.state.get(def.id)!.info);
    }
    this.computing ??= this.computeAll().finally(() => {
      this.computing = null;
    });
    return this.computing;
  }

  private async computeAll(): Promise<CleanupCategory[]> {
    const running = await this.deps.runningProcesses();
    const next = new Map<CleanupCategoryId, CategoryState>();
    for (const def of this.defs) next.set(def.id, await this.computeCategory(def, running));
    this.state = next;
    return this.defs.map((def) => next.get(def.id)!.info);
  }

  private blockedReason(source: CleanupSourceDef, running: Set<string> | null): string | undefined {
    if (!source.processNames?.length) return undefined;
    if (running === null) return 'Não foi possível verificar se o aplicativo está aberto.';
    if (source.processNames.some((name) => running.has(name))) {
      return `Feche o ${source.appName ?? source.label} (inclusive em segundo plano) para limpar este cache.`;
    }
    return undefined;
  }

  private async computeCategory(def: CleanupCategoryDef, running: Set<string> | null): Promise<CategoryState> {
    const info: CleanupCategory = {
      id: def.id,
      title: def.title,
      description: def.description,
      risk: def.risk,
      riskReason: def.riskReason,
      kind: def.kind,
      itemCount: 0,
      size: 0,
      allowsPermanent: def.allowsPermanent,
      sources: [],
      notes: [...def.notes],
    };
    const items: CleanupItem[] = [];
    const meta = new Map<string, ItemMeta>();

    if (def.kind === 'recycle-bin') {
      const bin = this.deps.recycleBin();
      info.itemCount = bin.itemCount;
      info.size = bin.size;
      if (!bin.available) info.error = 'Não foi possível consultar a Lixeira.';
      return { def, info, items, meta };
    }

    try {
      for (const source of def.sources(this.deps.known)) {
        const blockedReason = this.blockedReason(source, running);
        let sourceCount = 0;
        let sourceSize = 0;
        for (const root of source.roots) {
          const found = await this.collect(source, root, def.maxItems - items.length);
          for (const item of found) {
            if (!blockedReason) {
              if (def.tag) item.tag = def.tag(item.name);
              items.push(item);
              meta.set(item.path.toLowerCase(), { item, source, root });
            }
            sourceCount++;
            sourceSize += item.size;
          }
        }
        if (source.roots.length > 0) {
          info.sources.push({
            id: source.id,
            label: source.label,
            root: source.roots[0],
            itemCount: sourceCount,
            size: sourceSize,
            blockedReason,
          });
        }
      }
    } catch (error) {
      info.error = describeFsError(error);
    }

    items.sort((a, b) => b.size - a.size);
    info.itemCount = items.length;
    info.size = items.reduce((sum, item) => sum + item.size, 0);
    return { def, info, items, meta };
  }

  /** Lists matching files below one root without following links or junctions. */
  private async collect(source: CleanupSourceDef, root: string, limit: number): Promise<CleanupItem[]> {
    const found: CleanupItem[] = [];
    const cutoff = this.now() - source.minAgeDays * DAY_MS;
    const stack = [root];
    let visited = 0;
    while (stack.length > 0 && found.length < limit) {
      const dir = stack.pop()!;
      const entries = this.deps.reader.read(dir);
      if (++visited % 50 === 0) await yieldToEventLoop();
      if (!entries) continue;
      for (const entry of entries) {
        if (isLinkTag(entry.reparseTag)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          // Reparse-point folders (cloud placeholders and similar) are not entered.
          if (source.recursive && entry.reparseTag === 0) stack.push(path);
          continue;
        }
        if (Math.max(entry.modifiedMs, entry.createdMs) > cutoff) continue;
        if (entry.size < source.minSize) continue;
        if (source.match && !source.match(entry.name)) continue;
        found.push({
          path,
          name: entry.name,
          sourceId: source.id,
          sourceLabel: source.label,
          size: entry.size,
          modifiedMs: entry.modifiedMs,
        });
        if (found.length >= limit) break;
      }
    }
    return found;
  }

  items(query: CleanupItemsQuery): CleanupItemPage {
    const state = this.state.get(query.categoryId);
    if (!state) return { items: [], total: 0 };
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(query.limit ?? 100, 500);
    return { items: state.items.slice(offset, offset + limit), total: state.items.length };
  }

  /** Resolves a selection against the items this service found; unknown paths are ignored. */
  private resolve(selection: CleanupSelection): { state: CategoryState; items: ItemMeta[] } {
    const state = this.state.get(selection.categoryId);
    if (!state) throw new Error('Atualize a lista de limpeza antes de continuar.');
    if (state.def.kind === 'recycle-bin') throw new Error('A Lixeira é esvaziada por uma ação separada.');
    const listed = new Set(selection.paths.map((path) => path.toLowerCase()));
    const items =
      selection.mode === 'all'
        ? state.items.filter((item) => !listed.has(item.path.toLowerCase())).map((item) => state.meta.get(item.path.toLowerCase())!)
        : [...listed].map((key) => state.meta.get(key)).filter((meta): meta is ItemMeta => Boolean(meta));
    return { state, items };
  }

  preview(selections: CleanupSelection[]): CleanupPreview {
    const groups: CleanupPreview['groups'] = [];
    let allowsPermanent = true;
    for (const selection of selections) {
      const { state, items } = this.resolve(selection);
      if (items.length === 0) continue;
      allowsPermanent &&= state.def.allowsPermanent;
      groups.push({
        categoryId: state.def.id,
        title: state.def.title,
        count: items.length,
        size: items.reduce((sum, meta) => sum + meta.item.size, 0),
        samples: items.slice(0, 5).map((meta) => meta.item.path),
      });
    }
    return {
      groups,
      totalCount: groups.reduce((sum, group) => sum + group.count, 0),
      totalSize: groups.reduce((sum, group) => sum + group.size, 0),
      allowsPermanent: groups.length > 0 && allowsPermanent,
    };
  }

  /** Re-checks a file right before removal; returns a reason to skip it, or null. */
  private async revalidate(meta: ItemMeta): Promise<string | null> {
    const { item, source, root } = meta;
    const roots = source.roots;
    if (!roots.some((candidate) => samePath(candidate, root)) || !isWithin(item.path, root)) {
      return 'Fora das pastas permitidas.';
    }
    let stats;
    try {
      stats = await fsp.lstat(item.path);
    } catch (error) {
      return describeFsError(error);
    }
    if (!stats.isFile()) return 'Não é mais um arquivo comum.';
    if (stats.size !== item.size || Math.abs(stats.mtimeMs - item.modifiedMs) > 2) {
      return 'O arquivo mudou desde a revisão.';
    }
    const cutoff = this.now() - source.minAgeDays * DAY_MS;
    if (Math.max(stats.mtimeMs, stats.birthtimeMs) > cutoff) return 'O arquivo é recente.';
    return null;
  }

  async execute(request: CleanupRequest): Promise<CleanupResult> {
    if (this.executing) throw new Error('Já existe uma limpeza em andamento.');
    const startedAt = this.now();
    const resolved = request.selections.map((selection) => this.resolve(selection));
    if (request.mode === 'permanent') {
      const forbidden = resolved.find(({ state }) => !state.def.allowsPermanent);
      if (forbidden) throw new Error(`"${forbidden.state.def.title}" só pode ir para a Lixeira.`);
    }
    const work = resolved.flatMap(({ state, items }) => items.map((meta) => ({ state, meta })));
    if (work.length === 0) throw new Error('Nenhum item selecionado.');

    this.executing = true;
    try {
      const running = await this.deps.runningProcesses();
      const volumes = [...new Set(work.map(({ meta }) => volumeRootOf(meta.item.path)))];
      const freeBefore = await Promise.all(volumes.map((root) => this.deps.freeBytes(root)));

      const failed: FailedItem[] = [];
      const skipped: FailedItem[] = [];
      const removed: CleanupItem[] = [];
      const touchedDirs = new Map<string, string>();
      let lastEmit = 0;
      for (let i = 0; i < work.length; i++) {
        const { meta } = work[i];
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          this.deps.emit(Events.cleanupProgress, { done: i, total: work.length, currentPath: meta.item.path });
        }
        const blocked = this.blockedReason(meta.source, running);
        const reason = blocked ?? (await this.revalidate(meta));
        if (reason) {
          skipped.push({ path: meta.item.path, reason });
          continue;
        }
        try {
          if (request.mode === 'trash') await this.deps.remover.trash(meta.item.path);
          else await this.deps.remover.remove(meta.item.path);
          removed.push(meta.item);
          touchedDirs.set(dirname(meta.item.path).toLowerCase(), meta.root);
          work[i].state.meta.delete(meta.item.path.toLowerCase());
        } catch (error) {
          failed.push({ path: meta.item.path, reason: describeFsError(error, request.mode === 'trash' ? 'trash' : 'remove') });
        }
      }
      this.deps.emit(Events.cleanupProgress, { done: work.length, total: work.length, currentPath: '' });
      await this.removeEmptyFolders(touchedDirs);

      for (const { state } of resolved) {
        state.items = state.items.filter((item) => state.meta.has(item.path.toLowerCase()));
        state.info.itemCount = state.items.length;
        state.info.size = state.items.reduce((sum, item) => sum + item.size, 0);
      }

      const freeAfter = await Promise.all(volumes.map((root) => this.deps.freeBytes(root)));
      const freedBytes = measuredGain(freeBefore, freeAfter);

      const removedSize = removed.reduce((sum, item) => sum + item.size, 0);
      const status: OperationStatus =
        removed.length === 0 ? 'failed' : failed.length || skipped.length ? 'partial' : 'completed';
      const selectedSize = work.reduce((sum, { meta }) => sum + meta.item.size, 0);
      const verb = request.mode === 'trash' ? 'enviados para a Lixeira' : 'excluídos permanentemente';
      const entry = await this.deps.history.add(
        {
          type: 'cleanup',
          title: `Limpeza: ${plural(removed.length, 'arquivo', 'arquivos')} ${verb}`,
          startedAt,
          finishedAt: this.now(),
          status,
          itemCount: removed.length,
          estimatedBytes: selectedSize,
          freedBytes: request.mode === 'permanent' ? freedBytes : null,
          summary:
            `${formatBytes(removedSize)} ${verb}` +
            (failed.length ? `; ${plural(failed.length, 'falha', 'falhas')}` : '') +
            (skipped.length ? `; ${plural(skipped.length, 'ignorado', 'ignorados')}` : ''),
        },
        {
          lines: [
            { label: 'Categorias', value: resolved.map(({ state }) => state.def.title).join(', ') },
            { label: 'Modo', value: request.mode === 'trash' ? 'Enviar para a Lixeira' : 'Excluir permanentemente' },
            { label: 'Selecionado', value: `${plural(work.length, 'arquivo', 'arquivos')} (${formatBytes(selectedSize)})` },
            { label: 'Removido', value: `${plural(removed.length, 'arquivo', 'arquivos')} (${formatBytes(removedSize)})` },
            { label: 'Espaço livre ganho (medido)', value: freedBytes === null ? 'Não medido' : formatBytes(freedBytes) },
          ],
          items: [
            ...removed.map((item) => ({ path: item.path, detail: formatBytes(item.size), ok: true })),
            ...failed.map((item) => ({ path: item.path, detail: item.reason, ok: false })),
            ...skipped.map((item) => ({ path: item.path, detail: `Ignorado: ${item.reason}`, ok: false })),
          ],
        },
      );

      return {
        historyId: entry.id,
        status,
        mode: request.mode,
        removedCount: removed.length,
        removedSize,
        failed,
        skipped,
        freedBytes,
      };
    } finally {
      this.executing = false;
    }
  }

  /** Removes folders left empty by the cleanup, never going above the rule's root. */
  private async removeEmptyFolders(touched: Map<string, string>): Promise<void> {
    const candidates = new Map<string, string>();
    for (const [dir, root] of touched) {
      let current = dir;
      while (isWithin(current, root) && !samePath(current, root)) {
        candidates.set(current.toLowerCase(), root);
        current = dirname(current);
      }
    }
    const ordered = [...candidates.keys()].sort((a, b) => b.length - a.length);
    for (const dir of ordered) {
      await fsp.rmdir(dir).catch(() => undefined);
    }
  }
}
