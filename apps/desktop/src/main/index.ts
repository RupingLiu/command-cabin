import { createInMemorySettingsStore } from '@command-cabin/core';
import { app, dialog, globalShortcut } from 'electron';
import { fileURLToPath } from 'node:url';

import { createDesktopApplicationController } from './desktopApplication.js';
import { createMainWindow } from './window/createMainWindow.js';
import { resolveWindowEntryPaths } from './window/entryPaths.js';

const mainDirectory = fileURLToPath(new URL('.', import.meta.url));
const settingsStore = createInMemorySettingsStore();

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
