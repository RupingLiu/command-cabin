import {
  createClipboardHistoryPluginRuntime,
  createClipboardHistoryRepository,
  type ClipboardHistoryPluginRuntime,
  type ClipboardHistoryRepository,
} from '@command-cabin/built-in-plugin-clipboard-history';
import {
  createFavoritesRepository,
  createHistoryRepository,
  createInMemorySettingsStore,
  createPluginRepository,
  createSettingsRepository,
  openCommandCabinDatabase,
  runMigrations,
  type CommandCabinDatabase,
  type CommandCabinSettingsStore,
  type PluginRepository,
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
  CLEAR_CLIPBOARD_HISTORY_CHANNEL,
  EXECUTE_COMMAND_CHANNEL,
  GET_DATA_DIRECTORY_CHANNEL,
  GET_SETTINGS_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  LIST_FAVORITES_CHANNEL,
  LIST_PLUGINS_CHANNEL,
  OPEN_DATA_DIRECTORY_CHANNEL,
  REMOVE_FAVORITE_CHANNEL,
  REMOVE_PLUGIN_CHANNEL,
  REGISTER_PLUGIN_HOST_ENTRY_CHANNEL,
  RELEASE_PLUGIN_HOST_ENTRY_CHANNEL,
  SEARCH_COMMANDS_CHANNEL,
  SET_PLUGIN_ENABLED_CHANNEL,
  UPDATE_SETTINGS_CHANNEL,
  UPDATE_FAVORITE_CHANNEL,
} from '../shared/ipcChannels.js';
import { parseSettingsPatch } from '../shared/settingsApi.js';
import { updateSettingsWithHotkeyRegistration } from './settings/updateSettingsWithHotkeyRegistration.js';

const mainDirectory = fileURLToPath(new URL('.', import.meta.url));
const windowEntryPaths = resolveWindowEntryPaths(mainDirectory);
const pluginWebviewPolicyStore = createPluginWebviewPolicyStore({
  expectedPreloadPath: getPluginBridgePreloadPath(windowEntryPaths.preloadPath),
});
let settingsStore: CommandCabinSettingsStore = createInMemorySettingsStore();
let commandCabinDatabase: CommandCabinDatabase | undefined;
let clipboardHistoryRuntime: ClipboardHistoryPluginRuntime | undefined;
let launcherCommandService: LauncherCommandService = createLauncherCommandService();
let pluginRepository: PluginRepository | undefined;
let isShutdownResuming = false;

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
  settingsStore = createSettingsRepository(commandCabinDatabase);
  pluginRepository = createPluginRepository(commandCabinDatabase);
  const clipboardHistoryRepository = createClipboardHistoryRepository(commandCabinDatabase);
  clipboardHistoryRuntime = createPersistentClipboardHistoryRuntime(clipboardHistoryRepository);
  clipboardHistoryRuntime.watcher.start();

  return createLauncherCommandService({
    clipboardHistoryRepository,
    favoritesRepository: createFavoritesRepository(commandCabinDatabase),
    historyRepository: createHistoryRepository(commandCabinDatabase),
    openPath: async (path) => {
      const errorMessage = await shell.openPath(path);

      if (errorMessage.trim().length > 0) {
        throw new Error(errorMessage);
      }
    },
    openUrl: (url) => shell.openExternal(url),
    readClipboardText: () => clipboard.readText(),
    writeClipboardText: (text) => {
      clipboard.writeText(text);
    },
  });
}

function createPersistentClipboardHistoryRuntime(
  repository: ClipboardHistoryRepository,
): ClipboardHistoryPluginRuntime {
  return createClipboardHistoryPluginRuntime({
    onError: (error) => {
      console.error('Clipboard history watcher failed.', error);
    },
    readText: () => clipboard.readText(),
    repository,
  });
}

async function stopClipboardHistoryAndCloseDatabase(): Promise<void> {
  const runtime = clipboardHistoryRuntime;
  clipboardHistoryRuntime = undefined;

  if (runtime) {
    await runtime.watcher.stop();
  }

  commandCabinDatabase?.close();
  commandCabinDatabase = undefined;
  pluginRepository = undefined;
  settingsStore = createInMemorySettingsStore();
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

ipcMain.handle(CLEAR_CLIPBOARD_HISTORY_CHANNEL, () =>
  launcherCommandService.clearClipboardHistory(),
);

ipcMain.handle(GET_SETTINGS_CHANNEL, () => settingsStore.getSettings());

ipcMain.handle(UPDATE_SETTINGS_CHANNEL, (_event, input: unknown) => {
  return updateSettingsWithHotkeyRegistration({
    settingsPatch: parseSettingsPatch(input),
    settingsStore,
    tryRegisterHotkey: desktopApplication.tryRegisterGlobalHotkey,
  });
});

ipcMain.handle(LIST_PLUGINS_CHANNEL, () => pluginRepository?.listPlugins() ?? []);

ipcMain.handle(SET_PLUGIN_ENABLED_CHANNEL, (_event, id: unknown, enabled: unknown) => {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Plugin id must be a non-empty string.');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('Plugin enabled state must be a boolean.');
  }

  return pluginRepository?.setPluginEnabled(id.trim(), enabled);
});

ipcMain.handle(REMOVE_PLUGIN_CHANNEL, (_event, id: unknown) => {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Plugin id must be a non-empty string.');
  }

  return pluginRepository?.removePlugin(id.trim()) ?? false;
});

ipcMain.handle(GET_DATA_DIRECTORY_CHANNEL, () => ({
  path: app.getPath('userData'),
}));

ipcMain.handle(OPEN_DATA_DIRECTORY_CHANNEL, async () => {
  const path = app.getPath('userData');
  const errorMessage = await shell.openPath(path);

  if (errorMessage.trim().length > 0) {
    throw new Error(errorMessage);
  }

  return { path };
});

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

app.on('before-quit', (event) => {
  if (isShutdownResuming || !clipboardHistoryRuntime) {
    return;
  }

  event.preventDefault();
  isShutdownResuming = true;
  void stopClipboardHistoryAndCloseDatabase()
    .catch((error: unknown) => {
      console.error('Failed to stop clipboard history cleanly.', error);
    })
    .finally(() => {
      app.quit();
    });
});

app.on('will-quit', () => {
  desktopApplication.dispose();
  globalShortcut.unregisterAll();
  if (clipboardHistoryRuntime || commandCabinDatabase) {
    void stopClipboardHistoryAndCloseDatabase();
  }
});
