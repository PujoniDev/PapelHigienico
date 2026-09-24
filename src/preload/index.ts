import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channels, Events, type EventChannel, type LimpaCApi, type Unsubscribe } from '@shared/api';

// The renderer only sees this small, typed surface; it has no Node or file-system access.

const invoke =
  <T>(channel: string) =>
  (...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>;

const subscribe =
  <T>(channel: EventChannel) =>
  (callback: (payload: T) => void): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };

const api: LimpaCApi = {
  app: { info: invoke(Channels.appInfo) },
  volumes: { list: invoke(Channels.volumesList) },
  scan: {
    start: invoke(Channels.scanStart),
    cancel: invoke(Channels.scanCancel),
    state: invoke(Channels.scanState),
    folder: invoke(Channels.scanFolder),
    largeFiles: invoke(Channels.scanLargeFiles),
    types: invoke(Channels.scanTypes),
    search: invoke(Channels.scanSearch),
    folderFiles: invoke(Channels.scanFolderFiles),
    opportunities: invoke(Channels.scanOpportunities),
    onProgress: subscribe(Events.scanProgress),
    onFinished: subscribe(Events.scanFinished),
  },
  cleanup: {
    categories: invoke(Channels.cleanupCategories),
    items: invoke(Channels.cleanupItems),
    preview: invoke(Channels.cleanupPreview),
    execute: invoke(Channels.cleanupExecute),
    onProgress: subscribe(Events.cleanupProgress),
  },
  recycleBin: {
    query: invoke(Channels.recycleQuery),
    open: invoke(Channels.recycleOpen),
    empty: invoke(Channels.recycleEmpty),
  },
  transfer: {
    classify: invoke(Channels.transferClassify),
    pickFiles: invoke(Channels.transferPickFiles),
    pickDestination: invoke(Channels.transferPickDestination),
    preview: invoke(Channels.transferPreview),
    start: invoke(Channels.transferStart),
    cancel: invoke(Channels.transferCancel),
    get: invoke(Channels.transferGet),
    removeOriginals: invoke(Channels.transferRemoveOriginals),
    undo: invoke(Channels.transferUndo),
    onProgress: subscribe(Events.transferProgress),
    onFinished: subscribe(Events.transferFinished),
  },
  apps: {
    list: invoke(Channels.appsList),
    uninstall: invoke(Channels.appsUninstall),
    openSettings: invoke(Channels.appsOpenSettings),
  },
  history: {
    list: invoke(Channels.historyList),
    report: invoke(Channels.historyReport),
    clear: invoke(Channels.historyClear),
    openFolder: invoke(Channels.historyOpenFolder),
  },
  settings: {
    get: invoke(Channels.settingsGet),
    update: invoke(Channels.settingsUpdate),
  },
  shell: {
    showInFolder: invoke(Channels.shellShowInFolder),
    openFolder: invoke(Channels.shellOpenFolder),
  },
};

contextBridge.exposeInMainWorld('limpac', api);
