import {
  createClipboardHistoryPluginRuntime,
  createClipboardHistoryRepository,
  type ClipboardHistoryPluginRuntime,
  type ClipboardHistoryRepository,
} from '@command-cabin/built-in-plugin-clipboard-history';
import {
  createAppIndexer,
  createCommandRegistry,
  createFavoritesRepository,
  createHistoryRepository,
  createIndexCache,
  createInMemorySettingsStore,
  createPluginRuntime,
  createPluginRepository,
  createSettingsRepository,
  openCommandCabinDatabase,
  runMigrations,
  type AppIndexer,
  type CommandCabinDatabase,
  type CommandCabinSettingsStore,
  type CommandPayload,
  type PluginRuntime,
  type PluginRepository,
} from '@command-cabin/core';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDesktopApplicationController } from './desktopApplication.js';
import {
  createLauncherCommandService,
  type LauncherCommandService,
} from './launcher/launcherCommandService.js';
import {
  createDesktopPluginService,
  type DesktopPluginService,
} from './plugins/desktopPluginService.js';
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
  INSTALL_PLUGIN_CHANNEL,
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
import { parsePluginInstallRequest, parseSettingsPatch } from '../shared/settingsApi.js';
import { updateSettingsWithHotkeyRegistration } from './settings/updateSettingsWithHotkeyRegistration.js';

const mainDirectory = fileURLToPath(new URL('.', import.meta.url));
const windowEntryPaths = resolveWindowEntryPaths(mainDirectory);
const pluginWebviewPolicyStore = createPluginWebviewPolicyStore({
  expectedPreloadPath: getPluginBridgePreloadPath(windowEntryPaths.preloadPath),
});
let settingsStore: CommandCabinSettingsStore = createInMemorySettingsStore();
let commandCabinDatabase: CommandCabinDatabase | undefined;
let appIndexer: AppIndexer | undefined;
let clipboardHistoryRuntime: ClipboardHistoryPluginRuntime | undefined;
let desktopPluginService: DesktopPluginService | undefined;
let launcherCommandService: LauncherCommandService = createLauncherCommandService();
let pluginRepository: PluginRepository | undefined;
let pluginRuntime: PluginRuntime | undefined;
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
  launcherCommandService = await createPersistentLauncherCommandService();
  await desktopApplication.start();
}

async function createPersistentLauncherCommandService(): Promise<LauncherCommandService> {
  const userDataPath = app.getPath('userData');

  commandCabinDatabase = openCommandCabinDatabase({
    path: join(userDataPath, 'command-cabin.sqlite'),
  });
  runMigrations(commandCabinDatabase);
  settingsStore = createSettingsRepository(commandCabinDatabase);
  pluginRepository = createPluginRepository(commandCabinDatabase);
  const clipboardHistoryRepository = createClipboardHistoryRepository(commandCabinDatabase);
  clipboardHistoryRuntime = createPersistentClipboardHistoryRuntime(clipboardHistoryRepository);
  clipboardHistoryRuntime.watcher.start();
  const commandRegistry = createCommandRegistry();

  appIndexer = createAppIndexer({
    cache: createIndexCache({
      cacheFilePath: join(userDataPath, 'app-index.json'),
    }),
    onRefreshError: (error) => {
      console.error('App index refresh failed.', error);
    },
    refreshIntervalMs: 30 * 60 * 1000,
  });

  try {
    if (!(await appIndexer.load())) {
      await appIndexer.refresh();
    }
  } catch (error) {
    console.error('Initial app indexing failed.', error);
  }

  appIndexer.startAutoRefresh();

  pluginRuntime = createPluginRuntime({
    clipboard: {
      readText: async () => clipboard.readText(),
      writeText: async (request) => {
        clipboard.writeText(request.text);
      },
    },
    commandRegistry,
    logSink: (entry) => {
      const message = `[plugin:${entry.pluginId ?? 'unknown'}] ${entry.message}`;

      if (entry.level === 'error') {
        console.error(message, entry.error ?? entry.details ?? '');
        return;
      }

      console.log(message, entry.details ?? '');
    },
    moduleLoader: async ({ mainPath }) => import(pathToFileURL(mainPath).href),
  });
  desktopPluginService = createDesktopPluginService({
    onPluginLoadError: (plugin, error) => {
      console.error(`Plugin "${plugin.id}" was disabled after load failure.`, error);
    },
    repository: pluginRepository,
    runtime: pluginRuntime,
  });
  await desktopPluginService.loadEnabledPlugins();

  return createLauncherCommandService({
    actionHandlers: {
      'run-plugin': pluginRuntime.createRunPluginCommandHandler(),
    },
    appCommands: () => appIndexer?.getCommands() ?? [],
    clipboardHistoryRepository,
    commandRegistry,
    favoritesRepository: createFavoritesRepository(commandCabinDatabase),
    historyRepository: createHistoryRepository(commandCabinDatabase),
    openApp: openAppCommand,
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

async function openAppCommand(payload: CommandPayload): Promise<void> {
  const shortcutPath = payload.shortcutPath;

  if (typeof shortcutPath !== 'string' || shortcutPath.trim().length === 0) {
    throw new Error('App shortcut path is missing.');
  }

  const errorMessage = await shell.openPath(shortcutPath);

  if (errorMessage.trim().length > 0) {
    throw new Error(errorMessage);
  }
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
  const runtimePlugins = pluginRuntime;
  pluginRuntime = undefined;
  desktopPluginService = undefined;
  appIndexer?.stopAutoRefresh();
  appIndexer = undefined;

  if (runtime) {
    await runtime.watcher.stop();
  }

  if (runtimePlugins) {
    for (const plugin of runtimePlugins.listPlugins()) {
      if (plugin.status === 'enabled') {
        await runtimePlugins.disablePlugin(plugin.pluginId);
      }
    }
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

ipcMain.handle(LIST_PLUGINS_CHANNEL, () => desktopPluginService?.listPlugins() ?? []);

ipcMain.handle(INSTALL_PLUGIN_CHANNEL, (_event, input: unknown) =>
  desktopPluginService?.installPlugin(parsePluginInstallRequest(input).pluginRoot),
);

ipcMain.handle(SET_PLUGIN_ENABLED_CHANNEL, async (_event, id: unknown, enabled: unknown) => {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Plugin id must be a non-empty string.');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('Plugin enabled state must be a boolean.');
  }

  return desktopPluginService?.setPluginEnabled(id.trim(), enabled);
});

ipcMain.handle(REMOVE_PLUGIN_CHANNEL, async (_event, id: unknown) => {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Plugin id must be a non-empty string.');
  }

  return (await desktopPluginService?.removePlugin(id.trim())) ?? false;
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

ipcMain.handle(REGISTER_PLUGIN_HOST_ENTRY_CHANNEL, (_event, input: unknown) => {
  const pluginId =
    typeof input === 'object' && input !== null && 'pluginId' in input
      ? (input as { pluginId?: unknown }).pluginId
      : undefined;

  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
    throw new Error('Plugin host entry plugin id must be a non-empty string.');
  }

  const plugin = pluginRuntime?.getPlugin(pluginId.trim());

  if (!plugin || plugin.status !== 'enabled' || plugin.manifest.ui === undefined) {
    throw new Error('Plugin page is not available.');
  }

  return pluginWebviewPolicyStore.register({
    name: plugin.manifest.name,
    pluginId: plugin.pluginId,
    pluginRoot: plugin.pluginRoot,
    uiPath: plugin.manifest.ui,
  });
});

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
