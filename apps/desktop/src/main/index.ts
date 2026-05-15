import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';

import { createMainWindow } from './window/createMainWindow.js';
import { resolveWindowEntryPaths } from './window/entryPaths.js';

const mainDirectory = fileURLToPath(new URL('.', import.meta.url));

function getWindowOptions() {
  return {
    isPackaged: app.isPackaged,
    ...resolveWindowEntryPaths(mainDirectory),
    rendererDevServerUrl: process.env.ELECTRON_RENDERER_URL,
  };
}

async function createApplicationWindow(): Promise<void> {
  await createMainWindow(getWindowOptions());
}

app
  .whenReady()
  .then(createApplicationWindow)
  .catch((error: unknown) => {
    console.error('Failed to start CommandCabin.', error);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createApplicationWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
