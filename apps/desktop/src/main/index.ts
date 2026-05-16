import {
  createFavoritesRepository,
  createHistoryRepository,
  createInMemorySettingsStore,
  openCommandCabinDatabase,
  runMigrations,
  type CommandCabinDatabase,
} from '@command-cabin/core';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDesktopApplicationController } from './desktopApplication.js';
import {
  createLauncherCommandService,
  type LauncherCommandService,
} from './launcher/launcherCommandService.js';
import { createMainWindow } from './window/createMainWindow.js';
import { resolveWindowEntryPaths } from './window/entryPaths.js';
import {
  createPluginWebviewPolicyStore,
  getPluginBridgePreloadPath,
} from './window/webviewGuard.js';
import {
  parseFavoriteCreateRequest,
  parseFavoriteId,
  parseFavoriteUpdateRequest,
} from '../shared/favoritesApi.js';
import {
  ADD_FAVORITE_CHANNEL,
  EXECUTE_COMMAND_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  LIST_FAVORITES_CHANNEL,
  REMOVE_FAVORITE_CHANNEL,
  REGISTER_PLUGIN_HOST_ENTRY_CHANNEL,
  RELEASE_PLUGIN_HOST_ENTRY_CHANNEL,
  SEARCH_COMMANDS_CHANNEL,
  UPDATE_FAVORITE_CHANNEL,
} from '../shared/ipcChannels.js';

const mainDirectory = fileURLToPath(new URL('.', import.meta.url));
const windowEntryPaths = resolveWindowEntryPaths(mainDirectory);
const pluginWebviewPolicyStore = createPluginWebviewPolicyStore({
  expectedPreloadPath: getPluginBridgePreloadPath(windowEntryPaths.preloadPath),
});
const settingsStore = createInMemorySettingsStore();
let commandCabinDatabase: CommandCabinDatabase | undefined;
let launcherCommandService: LauncherCommandService = createLauncherCommandService();

function getWindowOptions() {
  return {
    isPackaged: app.isPackaged,
    ...windowEntryPaths,
    pluginWebviewPolicyStore,
    rendererDevServerUrl: process.env.ELECTRON_RENDERER_URL,
  };
}

async function createApplicationWindow(): Promise<void> {
  launcherCommandService = createPersistentLauncherCommandService();
  await desktopApplication.start();
}

function createPersistentLauncherCommandService(): LauncherCommandService {
  commandCabinDatabase = openCommandCabinDatabase({
    path: join(app.getPath('userData'), 'command-cabin.sqlite'),
  });
  runMigrations(commandCabinDatabase);

  return createLauncherCommandService({
    favoritesRepository: createFavoritesRepository(commandCabinDatabase),
    historyRepository: createHistoryRepository(commandCabinDatabase),
    openPath: async (path) => {
      const errorMessage = await shell.openPath(path);

      if (errorMessage.trim().length > 0) {
        throw new Error(errorMessage);
      }
    },
    openUrl: (url) => shell.openExternal(url),
    writeClipboardText: (text) => {
      clipboard.writeText(text);
    },
  });
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

ipcMain.handle(LIST_FAVORITES_CHANNEL, () => launcherCommandService.listFavorites());

ipcMain.handle(ADD_FAVORITE_CHANNEL, (_event, input: unknown) =>
  launcherCommandService.addFavorite(parseFavoriteCreateRequest(input)),
);

ipcMain.handle(UPDATE_FAVORITE_CHANNEL, (_event, id: unknown, input: unknown) =>
  launcherCommandService.updateFavorite(parseFavoriteId(id), parseFavoriteUpdateRequest(input)),
);

ipcMain.handle(REMOVE_FAVORITE_CHANNEL, (_event, id: unknown) =>
  launcherCommandService.removeFavorite(parseFavoriteId(id)),
);

ipcMain.handle(REGISTER_PLUGIN_HOST_ENTRY_CHANNEL, (_event, input: unknown) =>
  pluginWebviewPolicyStore.register(input),
);

ipcMain.handle(RELEASE_PLUGIN_HOST_ENTRY_CHANNEL, (_event, launchToken: unknown) => {
  if (typeof launchToken !== 'string' || launchToken.trim().length === 0) {
    return false;
  }

  return pluginWebviewPolicyStore.release(launchToken);
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
  commandCabinDatabase?.close();
  commandCabinDatabase = undefined;
});
