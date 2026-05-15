import { createInMemorySettingsStore } from '@command-cabin/core';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';

import { createDesktopApplicationController } from './desktopApplication.js';
import { createLauncherCommandService } from './launcher/launcherCommandService.js';
import { createMainWindow } from './window/createMainWindow.js';
import { resolveWindowEntryPaths } from './window/entryPaths.js';
import {
  EXECUTE_COMMAND_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  SEARCH_COMMANDS_CHANNEL,
} from '../shared/ipcChannels.js';

const mainDirectory = fileURLToPath(new URL('.', import.meta.url));
const settingsStore = createInMemorySettingsStore();
const launcherCommandService = createLauncherCommandService();

function getWindowOptions() {
  return {
    isPackaged: app.isPackaged,
    ...resolveWindowEntryPaths(mainDirectory),
    rendererDevServerUrl: process.env.ELECTRON_RENDERER_URL,
  };
}

async function createApplicationWindow(): Promise<void> {
  await desktopApplication.start();
}

const desktopApplication = createDesktopApplicationController({
  createWindow: () => createMainWindow(getWindowOptions()),
  getSettings: () => settingsStore.getSettings(),
  hotkeyRegistry: globalShortcut,
  logger: console,
  notifyHotkeyConflict: (message) => {
    dialog.showErrorBox('CommandCabin shortcut conflict', message);
  },
});

ipcMain.handle(SEARCH_COMMANDS_CHANNEL, (_event, query: unknown) =>
  launcherCommandService.searchCommands(typeof query === 'string' ? query : ''),
);

ipcMain.handle(EXECUTE_COMMAND_CHANNEL, (_event, commandId: unknown) =>
  launcherCommandService.executeCommand(typeof commandId === 'string' ? commandId : ''),
);

ipcMain.handle(HIDE_LAUNCHER_CHANNEL, (event) => {
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

app
  .whenReady()
  .then(createApplicationWindow)
  .catch((error: unknown) => {
    console.error('Failed to start CommandCabin.', error);
    app.quit();
  });

app.on('activate', () => {
  void desktopApplication.handleActivate();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  desktopApplication.dispose();
  globalShortcut.unregisterAll();
});
