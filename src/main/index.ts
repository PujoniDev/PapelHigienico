import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron';
import type { EventChannel } from '@shared/api';
import type { AppInfo } from '@shared/types';
import { AppsService } from './apps';
import { CleanupService } from './cleanup/service';
import type { FileRemover } from './file-ops';
import { HistoryStore } from './history';
import { registerIpc } from './ipc';
import { resolveKnownPaths } from './known-paths';
import { runningProcessNames } from './processes';
import { queryRecycleBin } from './recycle-bin';
import { ScanManager } from './scanner/manager';
import { createDirectoryReader } from './scanner/reader';
import { SettingsStore } from './settings';
import { TransferService } from './transfer/service';
import { freeBytesOf, getVolume } from './volumes';

app.setAppUserModelId('com.limpac.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  const emit = (channel: EventChannel, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const isTrustedSender = (event: IpcMainInvokeEvent) =>
    mainWindow !== null && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame;

  const remover: FileRemover = {
    // Electron aborts instead of deleting when an item cannot go to the Recycle Bin.
    trash: (path) => shell.trashItem(path),
    remove: (path) => fsp.unlink(path),
  };

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });

    const userData = app.getPath('userData');
    const known = resolveKnownPaths((name) => app.getPath(name));
    const history = new HistoryStore(join(userData, 'historico'));
    const settings = new SettingsStore(userData, (next) => {
      nativeTheme.themeSource = next.theme;
    });
    const reader = createDirectoryReader();
    const scan = new ScanManager({ known, history, storeDirectory: userData, emit });
    await scan.init();
    const cleanup = new CleanupService({
      known,
      reader,
      remover,
      history,
      emit,
      runningProcesses: runningProcessNames,
      recycleBin: queryRecycleBin,
      freeBytes: freeBytesOf,
    });
    const transfer = new TransferService({
      known,
      remover,
      history,
      storeDirectory: userData,
      emit,
      getVolume,
      freeBytes: freeBytesOf,
    });
    const apps = new AppsService();

    nativeTheme.themeSource = (await settings.get()).theme;

    const appInfo = (): AppInfo => ({
      version: app.getVersion(),
      userDataPath: userData,
      historyPath: history.directory,
      platformSupported: process.platform === 'win32',
      nativeReader: reader.native,
      knownFolders: [
        { label: 'Área de Trabalho', path: known.desktop },
        { label: 'Documentos', path: known.documents },
        { label: 'Downloads', path: known.downloads },
        { label: 'Imagens', path: known.pictures },
        { label: 'Vídeos', path: known.videos },
        { label: 'Músicas', path: known.music },
      ],
    });

    registerIpc({
      window: () => mainWindow,
      isTrustedSender,
      appInfo,
      scan,
      cleanup,
      transfer,
      apps,
      history,
      settings,
    });

    mainWindow = createWindow();
    mainWindow.on('close', (event) => {
      if (!transfer.isRunning() || !mainWindow) return;
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Continuar a transferência', 'Sair mesmo assim'],
        defaultId: 0,
        cancelId: 0,
        title: 'Transferência em andamento',
        message: 'Uma cópia de arquivos está em andamento.',
        detail: 'Se sair agora, a cópia é interrompida. Os arquivos originais continuam intactos no lugar de origem.',
      });
      if (choice === 0) event.preventDefault();
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
      scan.dispose();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'LimpaC',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  if (!app.isPackaged) {
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') window.webContents.toggleDevTools();
    });
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
}
