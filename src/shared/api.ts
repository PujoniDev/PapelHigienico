import type {
  AppInfo,
  CleanupCategory,
  CleanupItemPage,
  CleanupItemsQuery,
  CleanupPreview,
  CleanupProgress,
  CleanupRequest,
  CleanupResult,
  CleanupSelection,
  FilePage,
  FileEntry,
  FolderPage,
  FolderQuery,
  HistoryEntry,
  HistoryReport,
  InstalledApp,
  LargeFilesQuery,
  Opportunities,
  RecycleBinEmptyResult,
  RecycleBinInfo,
  RemoveOriginalsRequest,
  RemoveOriginalsResult,
  ScanOptions,
  ScanProgress,
  ScanState,
  ScanSummary,
  SearchResult,
  Settings,
  TransferClassification,
  TransferPreview,
  TransferPreviewRequest,
  TransferProgress,
  TransferRecord,
  TransferStartRequest,
  TypeBreakdown,
  UndoTransferResult,
  UninstallResult,
  VolumeInfo,
} from './types';

/** Request/response channels. Every entry is validated in the main process. */
export const Channels = {
  appInfo: 'app:info',
  volumesList: 'volumes:list',
  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanState: 'scan:state',
  scanFolder: 'scan:folder',
  scanLargeFiles: 'scan:large-files',
  scanTypes: 'scan:types',
  scanSearch: 'scan:search',
  scanFolderFiles: 'scan:folder-files',
  scanOpportunities: 'scan:opportunities',
  cleanupCategories: 'cleanup:categories',
  cleanupItems: 'cleanup:items',
  cleanupPreview: 'cleanup:preview',
  cleanupExecute: 'cleanup:execute',
  recycleQuery: 'recycle:query',
  recycleOpen: 'recycle:open',
  recycleEmpty: 'recycle:empty',
  transferClassify: 'transfer:classify',
  transferPickFiles: 'transfer:pick-files',
  transferPickDestination: 'transfer:pick-destination',
  transferPreview: 'transfer:preview',
  transferStart: 'transfer:start',
  transferCancel: 'transfer:cancel',
  transferGet: 'transfer:get',
  transferRemoveOriginals: 'transfer:remove-originals',
  transferUndo: 'transfer:undo',
  appsList: 'apps:list',
  appsUninstall: 'apps:uninstall',
  appsOpenSettings: 'apps:open-settings',
  historyList: 'history:list',
  historyReport: 'history:report',
  historyClear: 'history:clear',
  historyOpenFolder: 'history:open-folder',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  shellShowInFolder: 'shell:show-in-folder',
  shellOpenFolder: 'shell:open-folder',
} as const;

/** One-way events pushed from the main process to the renderer. */
export const Events = {
  scanProgress: 'event:scan-progress',
  scanFinished: 'event:scan-finished',
  cleanupProgress: 'event:cleanup-progress',
  transferProgress: 'event:transfer-progress',
  transferFinished: 'event:transfer-finished',
} as const;

export type EventChannel = (typeof Events)[keyof typeof Events];

export type Unsubscribe = () => void;

export interface LimpaCApi {
  app: {
    info(): Promise<AppInfo>;
  };
  volumes: {
    list(): Promise<VolumeInfo[]>;
  };
  scan: {
    start(options: ScanOptions): Promise<{ scanId: string }>;
    cancel(scanId: string): Promise<void>;
    state(): Promise<ScanState>;
    folder(query: FolderQuery): Promise<FolderPage>;
    largeFiles(query: LargeFilesQuery): Promise<FilePage>;
    types(scanId: string): Promise<TypeBreakdown>;
    search(scanId: string, text: string): Promise<SearchResult>;
    folderFiles(scanId: string, folderId: number): Promise<FileEntry[]>;
    opportunities(): Promise<Opportunities>;
    onProgress(callback: (progress: ScanProgress) => void): Unsubscribe;
    onFinished(callback: (summary: ScanSummary) => void): Unsubscribe;
  };
  cleanup: {
    categories(refresh: boolean): Promise<CleanupCategory[]>;
    items(query: CleanupItemsQuery): Promise<CleanupItemPage>;
    preview(selections: CleanupSelection[]): Promise<CleanupPreview>;
    execute(request: CleanupRequest): Promise<CleanupResult>;
    onProgress(callback: (progress: CleanupProgress) => void): Unsubscribe;
  };
  recycleBin: {
    query(): Promise<RecycleBinInfo>;
    open(): Promise<void>;
    empty(): Promise<RecycleBinEmptyResult>;
  };
  transfer: {
    classify(paths: string[]): Promise<TransferClassification[]>;
    pickFiles(): Promise<FileEntry[]>;
    pickDestination(defaultPath: string | null): Promise<string | null>;
    preview(request: TransferPreviewRequest): Promise<TransferPreview>;
    start(request: TransferStartRequest): Promise<{ operationId: string }>;
    cancel(operationId: string): Promise<void>;
    get(operationId: string): Promise<TransferRecord | null>;
    removeOriginals(request: RemoveOriginalsRequest): Promise<RemoveOriginalsResult>;
    undo(operationId: string): Promise<UndoTransferResult>;
    onProgress(callback: (progress: TransferProgress) => void): Unsubscribe;
    onFinished(callback: (record: TransferRecord) => void): Unsubscribe;
  };
  apps: {
    list(): Promise<InstalledApp[]>;
    uninstall(appId: string): Promise<UninstallResult>;
    openSettings(): Promise<void>;
  };
  history: {
    list(): Promise<HistoryEntry[]>;
    report(id: string): Promise<HistoryReport | null>;
    clear(): Promise<void>;
    openFolder(): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  shell: {
    showInFolder(path: string): Promise<void>;
    openFolder(path: string): Promise<void>;
  };
}
