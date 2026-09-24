import { create } from 'zustand';
import type {
  AppInfo,
  CleanupCategory,
  FileCategory,
  FileEntry,
  ScanOptions,
  ScanProgress,
  ScanState,
  Settings,
  TransferProgress,
  TransferRecord,
  VolumeInfo,
} from '@shared/types';
import { api, errorMessage } from './api';

export type Route = 'overview' | 'analyze' | 'cleanup' | 'transfer' | 'apps' | 'history' | 'settings';
export type AnalyzeTab = 'folders' | 'files' | 'types';

export interface AnalyzeView {
  folderId: number;
  tab: AnalyzeTab;
  category: FileCategory | null;
  minSize: number | null;
  underFolderId: number | null;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface AppState {
  ready: boolean;
  route: Route;
  info: AppInfo | null;
  settings: Settings | null;
  volumes: VolumeInfo[];
  scan: ScanState;
  analyze: AnalyzeView;
  cleanupCategories: CleanupCategory[] | null;
  transferSelection: Record<string, FileEntry>;
  transferOperationId: string | null;
  transferProgress: TransferProgress | null;
  transferRecord: TransferRecord | null;
  toasts: Toast[];

  init(): Promise<void>;
  navigate(route: Route): void;
  openAnalyze(view: Partial<AnalyzeView>): void;
  refreshVolumes(): Promise<void>;
  refreshScan(): Promise<void>;
  startScan(options: ScanOptions): Promise<void>;
  cancelScan(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setCleanupCategories(categories: CleanupCategory[] | null): void;
  addToTransfer(entries: FileEntry[]): void;
  removeFromTransfer(paths: string[]): void;
  clearTransfer(): void;
  setTransferOperation(id: string | null): void;
  receiveTransferRecord(record: TransferRecord): void;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
}

let toastCounter = 0;
let subscribed = false;

export const defaultAnalyzeView: AnalyzeView = {
  folderId: 0,
  tab: 'folders',
  category: null,
  minSize: null,
  underFolderId: null,
};

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  route: 'overview',
  info: null,
  settings: null,
  volumes: [],
  scan: { status: 'idle', lastSummary: null },
  analyze: defaultAnalyzeView,
  cleanupCategories: null,
  transferSelection: {},
  transferOperationId: null,
  transferProgress: null,
  transferRecord: null,
  toasts: [],

  async init() {
    if (!subscribed) {
      subscribed = true;
      api.scan.onProgress((progress: ScanProgress) => {
        const current = get().scan;
        // First event of a new scan: fetch the real options from the main process.
        if (current.status !== 'running') void get().refreshScan();
        set({
          scan: {
            status: 'running',
            progress,
            options:
              current.status === 'running'
                ? current.options
                : { root: progress.root, includeHidden: false, includeUserFolders: true },
            lastSummary: current.status === 'ready' ? current.summary : current.lastSummary,
          },
        });
      });
      api.scan.onFinished((summary) => {
        void get().refreshScan();
        void get().refreshVolumes();
        if (summary.status === 'failed') get().toast('error', `A análise falhou: ${summary.errorMessage ?? ''}`);
        else if (summary.status === 'cancelled') get().toast('info', 'Análise cancelada. Os resultados parciais estão disponíveis.');
        else get().toast('success', `Análise de ${summary.root} concluída.`);
      });
      api.transfer.onProgress((progress) => set({ transferProgress: progress }));
      api.transfer.onFinished((record) => {
        get().receiveTransferRecord(record);
        void get().refreshVolumes();
      });
    }
    const [info, settings, volumes, scan] = await Promise.all([
      api.app.info(),
      api.settings.get(),
      api.volumes.list(),
      api.scan.state(),
    ]);
    set({ info, settings, volumes, scan, ready: true });
  },

  navigate(route) {
    set({ route });
  },

  openAnalyze(view) {
    set({ route: 'analyze', analyze: { ...get().analyze, ...view } });
  },

  async refreshVolumes() {
    try {
      set({ volumes: await api.volumes.list() });
    } catch (error) {
      get().toast('error', errorMessage(error));
    }
  },

  async refreshScan() {
    const scan = await api.scan.state();
    const previous = get().scan;
    const newScan = scan.status === 'ready' && (previous.status !== 'ready' || previous.summary.scanId !== scan.summary.scanId);
    set({ scan, ...(newScan ? { analyze: defaultAnalyzeView } : {}) });
  },

  async startScan(options) {
    try {
      await api.scan.start(options);
      set({ analyze: defaultAnalyzeView });
      await get().refreshScan();
    } catch (error) {
      get().toast('error', errorMessage(error));
    }
  },

  async cancelScan() {
    const scan = get().scan;
    if (scan.status === 'running') await api.scan.cancel(scan.progress.scanId);
  },

  async updateSettings(patch) {
    // Show the change right away; the main process validates and persists it.
    const previous = get().settings;
    if (previous) set({ settings: { ...previous, ...patch } });
    try {
      set({ settings: await api.settings.update(patch) });
    } catch (error) {
      set({ settings: previous });
      get().toast('error', errorMessage(error));
    }
  },

  setCleanupCategories(categories) {
    set({ cleanupCategories: categories });
  },

  addToTransfer(entries) {
    const next = { ...get().transferSelection };
    for (const entry of entries) next[entry.path] = entry;
    set({ transferSelection: next });
  },

  removeFromTransfer(paths) {
    const next = { ...get().transferSelection };
    for (const path of paths) delete next[path];
    set({ transferSelection: next });
  },

  clearTransfer() {
    set({ transferSelection: {} });
  },

  setTransferOperation(id) {
    set({ transferOperationId: id, transferRecord: null, transferProgress: null });
  },

  receiveTransferRecord(record) {
    // A late "running" snapshot must never replace a record that already finished.
    const current = get().transferRecord;
    if (current?.id === record.id && current.status !== 'running' && record.status === 'running') return;
    set({
      transferOperationId: record.id,
      transferRecord: record,
      ...(record.status !== 'running' ? { transferProgress: null } : {}),
    });
  },

  toast(kind, text) {
    const id = ++toastCounter;
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-4) });
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 5000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },
}));

/** Summary of the scan whose results are loaded (or the last one saved on disk). */
export function currentSummary(scan: ScanState) {
  if (scan.status === 'ready') return scan.summary;
  return scan.lastSummary;
}
