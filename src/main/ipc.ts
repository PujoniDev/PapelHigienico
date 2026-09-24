import { promises as fsp } from 'node:fs';
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { Channels } from '@shared/api';
import type { AppInfo } from '@shared/types';
import type { AppsService } from './apps';
import type { CleanupService } from './cleanup/service';
import type { HistoryStore } from './history';
import { isDrivePath, normalizePath } from './policy';
import { emptyRecycleBin, openRecycleBin, queryRecycleBin } from './recycle-bin';
import type { ScanManager } from './scanner/manager';
import type { SettingsStore } from './settings';
import { settingsSchema } from './settings';
import type { TransferService } from './transfer/service';
import { listVolumes } from './volumes';

export interface IpcServices {
  window: () => BrowserWindow | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  appInfo: () => AppInfo;
  scan: ScanManager;
  cleanup: CleanupService;
  transfer: TransferService;
  apps: AppsService;
  history: HistoryStore;
  settings: SettingsStore;
}

const pathString = z.string().min(3).max(32_767);
const id = z.string().min(1).max(200);
const scanId = z.uuid();
const folderId = z.number().int().min(0);
const categoryId = z.enum(['user-temp', 'crash-reports', 'app-cache', 'recycle-bin', 'downloads']);
const fileCategory = z.enum(['video', 'image', 'audio', 'document', 'archive', 'installer', 'diskImage', 'other']);
const page = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() };

const schemas = {
  scanOptions: z.object({
    root: z.string().regex(/^[A-Za-z]:\\$/),
    includeHidden: z.boolean(),
    includeUserFolders: z.boolean(),
  }),
  folderQuery: z.object({ scanId, folderId, ...page }),
  largeFilesQuery: z.object({
    scanId,
    category: fileCategory.optional(),
    minSize: z.number().min(0).optional(),
    underFolderId: folderId.optional(),
    search: z.string().max(200).optional(),
    ...page,
  }),
  cleanupItems: z.object({ categoryId, ...page }),
  cleanupSelections: z
    .array(z.object({ categoryId, mode: z.enum(['all', 'only']), paths: z.array(pathString).max(200_000) }))
    .max(10),
  cleanupRequest: z.object({
    selections: z
      .array(z.object({ categoryId, mode: z.enum(['all', 'only']), paths: z.array(pathString).max(200_000) }))
      .min(1)
      .max(10),
    mode: z.enum(['trash', 'permanent']),
  }),
  transferPreview: z.object({
    files: z.array(pathString).min(1).max(10_000),
    destination: pathString,
    preserveStructure: z.boolean(),
  }),
  transferStart: z.object({
    files: z.array(pathString).min(1).max(10_000),
    destination: pathString,
    preserveStructure: z.boolean(),
    conflictPolicy: z.enum(['rename', 'skip']),
    acknowledgeSynced: z.boolean(),
  }),
  removeOriginals: z.object({ operationId: z.uuid(), mode: z.enum(['trash', 'permanent']) }),
  settingsPatch: settingsSchema.partial(),
};

type Handler = (...args: unknown[]) => unknown;

export function registerIpc(services: IpcServices): void {
  const handle = (channel: string, handler: Handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!services.isTrustedSender(event)) throw new Error('Origem não autorizada.');
      return handler(...args);
    });
  };

  handle(Channels.appInfo, () => services.appInfo());
  handle(Channels.volumesList, () => listVolumes());

  // Scan
  handle(Channels.scanStart, (options) => services.scan.start(schemas.scanOptions.parse(options)));
  handle(Channels.scanCancel, (value) => services.scan.cancel(scanId.parse(value)));
  handle(Channels.scanState, () => services.scan.state());
  handle(Channels.scanFolder, (query) => {
    const q = schemas.folderQuery.parse(query);
    const index = services.scan.requireIndex(q.scanId);
    if (!index.hasFolder(q.folderId)) throw new Error('Pasta não encontrada nos resultados.');
    return index.folderPage(q.folderId, q.offset, q.limit);
  });
  handle(Channels.scanLargeFiles, (query) => {
    const q = schemas.largeFilesQuery.parse(query);
    return services.scan.requireIndex(q.scanId).largeFiles(q);
  });
  handle(Channels.scanTypes, (value) => services.scan.requireIndex(scanId.parse(value)).types());
  handle(Channels.scanSearch, (value, text) =>
    services.scan.requireIndex(scanId.parse(value)).search(z.string().max(200).parse(text)),
  );
  handle(Channels.scanFolderFiles, (value, folder) => services.scan.folderFiles(scanId.parse(value), folderId.parse(folder)));
  handle(Channels.scanOpportunities, async () => {
    const settings = await services.settings.get();
    return services.scan.opportunities(settings.largeFileThresholdMB * 1024 * 1024, await listVolumes());
  });

  // Cleanup
  handle(Channels.cleanupCategories, (refresh) => services.cleanup.categories(z.boolean().parse(refresh)));
  handle(Channels.cleanupItems, (query) => services.cleanup.items(schemas.cleanupItems.parse(query)));
  handle(Channels.cleanupPreview, (selections) => services.cleanup.preview(schemas.cleanupSelections.parse(selections)));
  handle(Channels.cleanupExecute, (request) => services.cleanup.execute(schemas.cleanupRequest.parse(request)));

  // Recycle Bin
  handle(Channels.recycleQuery, () => queryRecycleBin());
  handle(Channels.recycleOpen, () => openRecycleBin());
  handle(Channels.recycleEmpty, async () => {
    const result = emptyRecycleBin();
    await services.history
      .add({
        type: 'recycle-bin',
        title: 'Lixeira esvaziada',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: result.ok ? 'completed' : 'failed',
        itemCount: 0,
        estimatedBytes: null,
        freedBytes: result.freedBytes,
        summary: result.message ?? 'Os itens da Lixeira foram apagados definitivamente.',
      })
      .catch(() => undefined);
    return result;
  });

  // Transfer
  handle(Channels.transferClassify, (paths) =>
    services.transfer.classify(z.array(pathString).max(10_000).parse(paths)),
  );
  handle(Channels.transferPickFiles, async () => {
    const window = services.window();
    const options = {
      title: 'Escolha arquivos para mover',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    const entries = await Promise.all(result.filePaths.map((path) => services.transfer.fileEntry(path)));
    return entries.filter((entry) => entry !== null);
  });
  handle(Channels.transferPickDestination, async (defaultPath) => {
    const window = services.window();
    const start = z.string().max(1024).nullable().parse(defaultPath);
    const options = {
      title: 'Escolha a pasta de destino',
      defaultPath: start ?? undefined,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : normalizePath(result.filePaths[0]);
  });
  handle(Channels.transferPreview, (request) => services.transfer.preview(schemas.transferPreview.parse(request)));
  handle(Channels.transferStart, async (request) => {
    const parsed = schemas.transferStart.parse(request);
    const result = await services.transfer.start(parsed);
    await services.settings.update({ lastDestination: normalizePath(parsed.destination) }).catch(() => undefined);
    return result;
  });
  handle(Channels.transferCancel, (value) => services.transfer.cancel(z.uuid().parse(value)));
  handle(Channels.transferGet, (value) => services.transfer.get(z.uuid().parse(value)));
  handle(Channels.transferRemoveOriginals, (request) =>
    services.transfer.removeOriginals(schemas.removeOriginals.parse(request)),
  );
  handle(Channels.transferUndo, (value) => services.transfer.undo(z.uuid().parse(value)));

  // Apps
  handle(Channels.appsList, () => services.apps.list());
  handle(Channels.appsUninstall, async (value) => {
    const result = await services.apps.uninstall(id.parse(value));
    if (result.launched) {
      await services.history
        .add({
          type: 'uninstall',
          title: 'Desinstalador aberto',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          status: 'completed',
          itemCount: 1,
          estimatedBytes: null,
          freedBytes: null,
          summary: result.message,
        })
        .catch(() => undefined);
    }
    return result;
  });
  handle(Channels.appsOpenSettings, () => shell.openExternal('ms-settings:appsfeatures'));

  // History
  handle(Channels.historyList, () => services.history.list());
  handle(Channels.historyReport, (value) => services.history.report(id.parse(value)));
  handle(Channels.historyClear, () => services.history.clear());
  handle(Channels.historyOpenFolder, async () => {
    await fsp.mkdir(services.history.directory, { recursive: true });
    await shell.openPath(services.history.directory);
  });

  // Settings
  handle(Channels.settingsGet, () => services.settings.get());
  handle(Channels.settingsUpdate, (patch) => services.settings.update(schemas.settingsPatch.parse(patch)));

  // Shell helpers: reveal in Explorer never runs the file; openFolder only opens folders.
  handle(Channels.shellShowInFolder, async (value) => {
    const path = normalizePath(pathString.parse(value));
    if (!isDrivePath(path)) throw new Error('Caminho inválido.');
    await fsp.lstat(path);
    shell.showItemInFolder(path);
  });
  handle(Channels.shellOpenFolder, async (value) => {
    const path = normalizePath(pathString.parse(value));
    if (!isDrivePath(path)) throw new Error('Caminho inválido.');
    const stats = await fsp.stat(path);
    if (!stats.isDirectory()) throw new Error('Somente pastas podem ser abertas.');
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
}
