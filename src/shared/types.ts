// Domain types shared by the main process, the preload bridge and the renderer.
// Sizes are bytes, timestamps are milliseconds since the Unix epoch.

export type RiskLevel = 'low' | 'medium' | 'review' | 'high';

export type OperationStatus = 'completed' | 'partial' | 'cancelled' | 'failed';

// ---------------------------------------------------------------------------
// Volumes

export type VolumeType = 'fixed' | 'removable' | 'network' | 'cdrom' | 'ramdisk' | 'unknown';

export interface VolumeInfo {
  /** Root path, e.g. "C:\\". */
  root: string;
  letter: string;
  label: string;
  fileSystem: string;
  type: VolumeType;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  isSystem: boolean;
}

// ---------------------------------------------------------------------------
// File categories

export type FileCategory =
  | 'video'
  | 'image'
  | 'audio'
  | 'document'
  | 'archive'
  | 'installer'
  | 'diskImage'
  | 'other';

// ---------------------------------------------------------------------------
// Scan

export interface ScanOptions {
  root: string;
  includeHidden: boolean;
  includeUserFolders: boolean;
}

export interface ScanProgress {
  scanId: string;
  root: string;
  currentPath: string;
  filesScanned: number;
  dirsScanned: number;
  bytesScanned: number;
  inaccessible: number;
  elapsedMs: number;
  /** Rough completion ratio (0..1) based on the volume's used space, or null when unknown. */
  estimatedRatio: number | null;
}

export interface FolderFlags {
  inaccessible: boolean;
  /** Some content below this folder could not be read. */
  partial: boolean;
  /** Hidden items inside were skipped because of the scan options. */
  hiddenSkipped: boolean;
  cloud: boolean;
  hidden: boolean;
}

export interface FolderEntry {
  id: number;
  name: string;
  path: string;
  /** Space the folder takes on disk (allocation size, hard links counted once). */
  size: number;
  /** Sum of file lengths. */
  logicalSize: number;
  fileCount: number;
  folderCount: number;
  modifiedMs: number;
  childCount: number;
  flags: FolderFlags;
}

export interface FileEntry {
  path: string;
  name: string;
  folder: string;
  size: number;
  sizeOnDisk: number;
  modifiedMs: number;
  extension: string;
  category: FileCategory;
  hidden: boolean;
  cloud: boolean;
}

export interface ScanSummary {
  scanId: string;
  root: string;
  options: ScanOptions;
  status: OperationStatus;
  startedAt: number;
  finishedAt: number;
  totalSize: number;
  logicalSize: number;
  fileCount: number;
  folderCount: number;
  inaccessibleCount: number;
  inaccessibleSamples: string[];
  skippedLinks: number;
  skippedHidden: { files: number; folders: number; fileBytes: number };
  skippedUserFolders: boolean;
  hardLinkDuplicateBytes: number;
  volume: { totalBytes: number; usedBytes: number; freeBytes: number } | null;
  topFolders: FolderEntry[];
  /** True when the scanner could not read Windows attributes (fallback reader). */
  limitedMetadata: boolean;
  errorMessage?: string;
}

export type ScanState =
  | { status: 'idle'; lastSummary: ScanSummary | null }
  | { status: 'running'; progress: ScanProgress; options: ScanOptions; lastSummary: ScanSummary | null }
  | { status: 'ready'; summary: ScanSummary };

export interface FolderQuery {
  scanId: string;
  folderId: number;
  offset?: number;
  limit?: number;
}

export interface FolderPage {
  folder: FolderEntry;
  breadcrumb: { id: number; name: string }[];
  children: FolderEntry[];
  totalChildren: number;
  directFiles: { count: number; size: number };
}

export interface LargeFilesQuery {
  scanId: string;
  category?: FileCategory;
  minSize?: number;
  underFolderId?: number;
  search?: string;
  offset?: number;
  limit?: number;
}

export interface FilePage {
  items: FileEntry[];
  total: number;
  /** The scanner keeps only the largest files of each type; totals are within that set. */
  truncated: boolean;
}

export interface CategoryStat {
  category: FileCategory;
  count: number;
  size: number;
}

export interface ExtensionStat {
  extension: string;
  category: FileCategory;
  count: number;
  size: number;
}

export interface TypeBreakdown {
  categories: CategoryStat[];
  extensions: ExtensionStat[];
}

export interface SearchResult {
  folders: FolderEntry[];
  files: FileEntry[];
}

export interface Opportunities {
  scanId: string | null;
  largeFiles: { count: number; size: number; threshold: number } | null;
  movable: { count: number; size: number; minSize: number; hasOtherVolume: boolean } | null;
}

// ---------------------------------------------------------------------------
// Cleanup

export type CleanupCategoryId = 'user-temp' | 'crash-reports' | 'app-cache' | 'recycle-bin' | 'downloads';

export interface CleanupSourceInfo {
  id: string;
  label: string;
  root: string;
  itemCount: number;
  size: number;
  blockedReason?: string;
}

export interface CleanupCategory {
  id: CleanupCategoryId;
  title: string;
  description: string;
  risk: RiskLevel;
  riskReason: string;
  kind: 'files' | 'review' | 'recycle-bin';
  itemCount: number;
  size: number;
  /** Whether permanent deletion may be offered as a non-default option. */
  allowsPermanent: boolean;
  sources: CleanupSourceInfo[];
  notes: string[];
  error?: string;
}

export interface CleanupItem {
  path: string;
  name: string;
  sourceId: string;
  sourceLabel: string;
  size: number;
  modifiedMs: number;
  tag?: string;
}

export interface CleanupItemsQuery {
  categoryId: CleanupCategoryId;
  offset?: number;
  limit?: number;
}

export interface CleanupItemPage {
  items: CleanupItem[];
  total: number;
}

export interface CleanupSelection {
  categoryId: CleanupCategoryId;
  /** 'all' selects every item except `paths`; 'only' selects exactly `paths`. */
  mode: 'all' | 'only';
  paths: string[];
}

export type DeleteMode = 'trash' | 'permanent';

export interface CleanupPreview {
  groups: { categoryId: CleanupCategoryId; title: string; count: number; size: number; samples: string[] }[];
  totalCount: number;
  totalSize: number;
  allowsPermanent: boolean;
}

export interface CleanupRequest {
  selections: CleanupSelection[];
  mode: DeleteMode;
}

export interface CleanupProgress {
  done: number;
  total: number;
  currentPath: string;
}

export interface FailedItem {
  path: string;
  reason: string;
}

export interface CleanupResult {
  historyId: string;
  status: OperationStatus;
  mode: DeleteMode;
  removedCount: number;
  removedSize: number;
  failed: FailedItem[];
  skipped: FailedItem[];
  /** Change in free space on the affected volume(s), when measurable. */
  freedBytes: number | null;
}

export interface RecycleBinInfo {
  available: boolean;
  itemCount: number;
  size: number;
}

export interface RecycleBinEmptyResult {
  ok: boolean;
  freedBytes: number | null;
  message?: string;
}

// ---------------------------------------------------------------------------
// Transfer

export type ConflictPolicy = 'rename' | 'skip';

export interface TransferClassification {
  path: string;
  eligible: boolean;
  blockedReason?: string;
  warnings: string[];
  personal: boolean;
  synced: boolean;
}

export interface TransferPreviewRequest {
  files: string[];
  destination: string;
  preserveStructure: boolean;
}

export interface TransferPreviewItem {
  source: string;
  destination: string;
  size: number;
  sizeOnDisk: number;
  modifiedMs: number;
  eligible: boolean;
  blockedReason?: string;
  warnings: string[];
  synced: boolean;
  conflict: boolean;
}

export interface TransferPreview {
  items: TransferPreviewItem[];
  destination: string;
  destinationVolume: VolumeInfo | null;
  eligibleCount: number;
  totalSize: number;
  freedOnSource: number;
  requiredWithMargin: number;
  conflicts: number;
  syncedCount: number;
  errors: string[];
  canProceed: boolean;
}

export interface TransferStartRequest extends TransferPreviewRequest {
  conflictPolicy: ConflictPolicy;
  acknowledgeSynced: boolean;
}

export type TransferItemStatus =
  | 'pending'
  | 'copying'
  | 'copied'
  | 'skipped-conflict'
  | 'skipped-changed'
  | 'failed'
  | 'cancelled';

export type OriginalStatus = 'kept' | 'trashed' | 'deleted' | 'remove-failed';

export interface TransferItem {
  id: number;
  source: string;
  destination: string;
  size: number;
  sourceModifiedMs: number;
  hash?: string;
  status: TransferItemStatus;
  error?: string;
  originalStatus: OriginalStatus;
  originalError?: string;
  restored?: boolean;
  destinationRemoved?: boolean;
  undoError?: string;
}

export interface TransferRecord {
  id: string;
  createdAt: number;
  finishedAt?: number;
  status: 'running' | OperationStatus;
  destinationRoot: string;
  preserveStructure: boolean;
  conflictPolicy: ConflictPolicy;
  items: TransferItem[];
  removal?: { at: number; mode: DeleteMode; freedBytes: number | null };
  undoneAt?: number;
}

export interface TransferProgress {
  operationId: string;
  phase: 'copying' | 'verifying';
  fileIndex: number;
  fileCount: number;
  currentFile: string;
  bytesDone: number;
  bytesTotal: number;
}

export interface RemoveOriginalsRequest {
  operationId: string;
  mode: DeleteMode;
}

export interface RemoveOriginalsResult {
  record: TransferRecord;
  removedCount: number;
  removedSize: number;
  failed: FailedItem[];
  freedBytes: number | null;
}

export interface UndoTransferResult {
  record: TransferRecord;
  restoredCount: number;
  removedCopies: number;
  failed: FailedItem[];
}

// ---------------------------------------------------------------------------
// Installed apps

export interface InstalledApp {
  id: string;
  name: string;
  publisher: string;
  version: string;
  size: number | null;
  installDate: string | null;
  canUninstall: boolean;
}

export interface UninstallResult {
  launched: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// History

export type HistoryType = 'scan' | 'cleanup' | 'recycle-bin' | 'transfer' | 'transfer-remove' | 'transfer-undo' | 'uninstall';

export interface HistoryEntry {
  id: string;
  type: HistoryType;
  title: string;
  startedAt: number;
  finishedAt: number;
  status: OperationStatus;
  itemCount: number;
  estimatedBytes: number | null;
  freedBytes: number | null;
  summary: string;
  hasReport: boolean;
  transferId?: string;
}

export interface HistoryReport {
  entry: HistoryEntry;
  lines: { label: string; value: string }[];
  items: { path: string; detail: string; ok: boolean }[];
  truncatedItems: number;
}

// ---------------------------------------------------------------------------
// Settings

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Settings {
  defaultVolume: string;
  largeFileThresholdMB: number;
  confirmTransfers: boolean;
  theme: ThemePreference;
  lastDestination: string | null;
}

export interface AppInfo {
  version: string;
  userDataPath: string;
  historyPath: string;
  platformSupported: boolean;
  nativeReader: boolean;
  knownFolders: { label: string; path: string }[];
}
