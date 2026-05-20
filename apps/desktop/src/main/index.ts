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
  createWindowsShortcutResolver,
  openCommandCabinDatabase,
  runMigrations,
  type AppIndexer,
  type CommandCabinDatabase,
  type CommandCabinSettingsStore,
  type PluginRuntime,
  type PluginRepository,
} from '@command-cabin/core';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDesktopApplicationController } from './desktopApplication.js';
import { createAltSpaceHotkeyCaptureController } from './hotkey/altSpaceHotkeyCapture.js';
import { createAppIconResolver } from './icons/appIconResolver.js';
import { createIconDataUrlCache, type IconDataUrlCache } from './icons/iconDataUrlCache.js';
import { hydrateSearchResultsWithCachedIcons } from './icons/searchResultIconHydration.js';
import { createWindowsAppUserModelIconResolver } from './icons/windowsAppUserModelIconResolver.js';
import { startAppIndexing } from './launcher/appIndexStartup.js';
import { createExplorerAppsFolderAppLauncher } from './launcher/appsFolderAppLauncher.js';
import { listDesktopShortcutCommands } from './launcher/desktopShortcutCommands.js';
import { createExchangeRateCache } from './launcher/exchangeRateCache.js';
import { createOpenAppCommand } from './launcher/openAppCommand.js';
import {
  createAppCandidateService,
  listShortcutFilesInDirectories,
  type AppCandidateService,
  type InternalAppCandidate,
} from './launcher/appCandidateService.js';
import {
  createLauncherCommandService,
  type LauncherCommandService,
  type LauncherPinnedAppInput,
} from './launcher/launcherCommandService.js';
import {
  createDesktopPluginService,
  type DesktopPluginService,
} from './plugins/desktopPluginService.js';
import {
  createCommandCabinTrayController,
  resolveTrayIconPath,
  type CommandCabinTrayController,
} from './tray/trayController.js';
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
  ADD_PINNED_APP_CANDIDATE_CHANNEL,
  ADD_FAVORITE_CHANNEL,
  ADD_PINNED_APP_CHANNEL,
  CHECK_FOR_UPDATES_CHANNEL,
  CLEAR_CLIPBOARD_HISTORY_CHANNEL,
  EXECUTE_COMMAND_CHANNEL,
  GET_DATA_DIRECTORY_CHANNEL,
  GET_SETTINGS_CHANNEL,
  GET_UPDATE_STATUS_CHANNEL,
  HIDE_LAUNCHER_CHANNEL,
  INSTALL_PLUGIN_CHANNEL,
  INSTALL_UPDATE_CHANNEL,
  LIST_APP_CANDIDATES_CHANNEL,
  LIST_FAVORITES_CHANNEL,
  LIST_PLUGINS_CHANNEL,
  OPEN_DATA_DIRECTORY_CHANNEL,
  REMOVE_FAVORITE_CHANNEL,
  REMOVE_RECENT_APP_CHANNEL,
  REMOVE_PLUGIN_CHANNEL,
  REGISTER_PLUGIN_HOST_ENTRY_CHANNEL,
  RELEASE_PLUGIN_HOST_ENTRY_CHANNEL,
  SEARCH_COMMANDS_CHANNEL,
  SET_PLUGIN_ENABLED_CHANNEL,
  START_HOTKEY_INPUT_CAPTURE_CHANNEL,
  STOP_HOTKEY_INPUT_CAPTURE_CHANNEL,
  UPDATE_FAVORITE_CHANNEL,
  UPDATE_PINNED_APP_CHANNEL,
  UPDATE_SETTINGS_CHANNEL,
} from '../shared/ipcChannels.js';
import { parseAppCandidateAddRequest, type AppCandidate } from '../shared/appCandidatesApi.js';
import { parsePluginInstallRequest, parseSettingsPatch } from '../shared/settingsApi.js';
import { updateSettingsWithHotkeyRegistration } from './settings/updateSettingsWithHotkeyRegistration.js';
import { configureSingleInstance } from './singleInstance.js';
import { createLaunchAtLoginController, isLaunchAtLoginStartup } from './startup/launchAtLogin.js';
import { createUpdateController, type UpdateController } from './updater/updateController.js';

const require = createRequire(import.meta.url);
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
const mainDirectory = fileURLToPath(new URL('.', import.meta.url));
const windowEntryPaths = resolveWindowEntryPaths(mainDirectory);
const shortcutResolver = createWindowsShortcutResolver();
const appCandidateShortcutResolver = createWindowsShortcutResolver({
  timeoutMs: 750,
});
const appUserModelIconResolver = createWindowsAppUserModelIconResolver({
  logger: console,
});
const appIconResolver = createAppIconResolver({
  fileExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  getFileIcon: (path) => app.getFileIcon(path),
  iconDataUrlCache: {
    read: async (key) => appIconDataUrlCache?.read(key),
    write: async (key, dataUrl) => {
      await appIconDataUrlCache?.write(key, dataUrl);
    },
  },
  readImageDataUrl: async (path) => {
    const image = nativeImage.createFromPath(path);

    return image.isEmpty() ? undefined : image.toDataURL();
  },
  resolveAppUserModelIcon: (appUserModelId) => appUserModelIconResolver.resolve(appUserModelId),
  resolveShortcut: (path) => shortcutResolver.resolve(path),
});
const openAppCommand = createOpenAppCommand({
  openAppsFolderApp: createExplorerAppsFolderAppLauncher(),
  openExternal: (url) => shell.openExternal(url),
  openPath: (path) => shell.openPath(path),
});
const pluginWebviewPolicyStore = createPluginWebviewPolicyStore({
  expectedPreloadPath: getPluginBridgePreloadPath(windowEntryPaths.preloadPath),
});
let settingsStore: CommandCabinSettingsStore = createInMemorySettingsStore();
let commandCabinDatabase: CommandCabinDatabase | undefined;
let appIndexer: AppIndexer | undefined;
let clipboardHistoryRuntime: ClipboardHistoryPluginRuntime | undefined;
let desktopPluginService: DesktopPluginService | undefined;
let appCandidateService: AppCandidateService = createAppCandidateService({
  appCommands: () => [],
  favorites: () => [],
  listDesktopShortcuts: async () => [],
  resolveShortcut: (path) => shortcutResolver.resolve(path),
});
let launcherCommandService: LauncherCommandService = createLauncherCommandService();
let pluginRepository: PluginRepository | undefined;
let pluginRuntime: PluginRuntime | undefined;
let appIconDataUrlCache: IconDataUrlCache | undefined;
let trayController: CommandCabinTrayController | undefined;
let updateController: UpdateController | undefined;
let isShutdownResuming = false;
let nextWindowShowOnReady = true;
let startupPromise: Promise<void> | undefined;

function getWindowOptions() {
  return {
    isPackaged: app.isPackaged,
    ...windowEntryPaths,
    pluginWebviewPolicyStore,
    rendererDevServerUrl: process.env.ELECTRON_RENDERER_URL,
    showOnReady: nextWindowShowOnReady,
  };
}

async function createApplicationWindow({ showWindow }: { showWindow: boolean }): Promise<void> {
  nextWindowShowOnReady = showWindow;
  try {
    launcherCommandService = await createPersistentLauncherCommandService();
    launchAtLoginController.sync(settingsStore.getSettings().launchAtLogin);
    await desktopApplication.start({ showWindow });
  } finally {
    nextWindowShowOnReady = true;
  }
  trayController = createCommandCabinTrayController({
    iconPath: resolveTrayIconPath(mainDirectory),
    language: settingsStore.getSettings().language,
    openSettings: () => {
      void desktopApplication.openSettings();
    },
    quit: () => {
      desktopApplication.requestQuit();
      app.quit();
    },
    show: () => {
      void desktopApplication.showLauncherWindow();
    },
    toggle: () => {
      void desktopApplication.toggleLauncherWindow();
    },
  });
  getUpdateController().startAutomaticCheck();
}

function getUpdateController(): UpdateController {
  updateController ??= createUpdateController({
    autoUpdater,
    getWindows: () =>
      BrowserWindow.getAllWindows().map((window) => ({
        send: (channel, status) => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, status);
          }
        },
      })),
    isPackaged: app.isPackaged,
    logger: console,
  });

  return updateController;
}

function getDesktopShortcutDirectories(): string[] {
  return Array.from(
    new Set([
      app.getPath('desktop'),
      ...(process.env.PUBLIC ? [join(process.env.PUBLIC, 'Desktop')] : []),
    ]),
  );
}

function getLauncherAppCommands() {
  return [
    ...(appIndexer?.getCommands() ?? []),
    ...listDesktopShortcutCommands({
      directories: getDesktopShortcutDirectories(),
    }),
  ];
}

async function createPersistentLauncherCommandService(): Promise<LauncherCommandService> {
  const userDataPath = app.getPath('userData');
  appIconDataUrlCache = createIconDataUrlCache({
    cacheFilePath: join(userDataPath, 'app-icons.json'),
    logger: console,
  });
  const exchangeRateProvider = createExchangeRateCache({
    cacheFilePath: join(userDataPath, 'exchange-rates.json'),
    logger: console,
  });

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
  const favoritesRepository = createFavoritesRepository(commandCabinDatabase);

  appIndexer = createAppIndexer({
    cache: createIndexCache({
      cacheFilePath: join(userDataPath, 'app-index.json'),
    }),
    onRefreshError: (error) => {
      console.error('App index refresh failed.', error);
    },
    refreshIntervalMs: 30 * 60 * 1000,
  });

  void startAppIndexing({
    indexer: appIndexer,
    logger: console,
  });

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

  appCandidateService = createAppCandidateService({
    appCommands: () => appIndexer?.getCommands() ?? [],
    favorites: () => favoritesRepository.listFavorites(),
    listDesktopShortcuts: () => listShortcutFilesInDirectories(getDesktopShortcutDirectories()),
    resolveShortcut: (path) => appCandidateShortcutResolver.resolve(path),
  });

  return createLauncherCommandService({
    actionHandlers: {
      'run-plugin': pluginRuntime.createRunPluginCommandHandler(),
    },
    appVersion: app.getVersion(),
    appCommands: getLauncherAppCommands,
    clipboardHistoryRepository,
    commandRegistry,
    exchangeRateProvider,
    favoritesRepository,
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
  appIconDataUrlCache = undefined;
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
const altSpaceHotkeyCapture = createAltSpaceHotkeyCaptureController({
  registry: globalShortcut,
});
const launchAtLoginController = createLaunchAtLoginController({
  app,
});

async function showExistingApplicationInstance(): Promise<void> {
  if (startupPromise) {
    await startupPromise;
  } else if (!app.isReady()) {
    await app.whenReady();
  }

  await desktopApplication.showLauncherWindow();
}

function startApplication(): Promise<void> {
  const showWindow = !isLaunchAtLoginStartup(process.argv);
  const nextStartupPromise = app.whenReady().then(() => createApplicationWindow({ showWindow }));

  nextStartupPromise.catch((error: unknown) => {
    console.error('Failed to start CommandCabin.', error);
    app.quit();
  });

  return nextStartupPromise;
}

async function createPinnedAppInput(appPath: string): Promise<LauncherPinnedAppInput> {
  const extension = extname(appPath).toLowerCase();

  if (extension !== '.lnk') {
    return {
      appPath,
      executablePath: appPath,
      iconPath: appPath,
    };
  }

  try {
    const shortcut = await shortcutResolver.resolve(appPath);

    return {
      appPath,
      executablePath: shortcut.targetPath,
      iconPath: shortcut.iconPath ?? shortcut.targetPath,
    };
  } catch (error) {
    console.warn('Pinned app shortcut resolution failed.', error);
    return {
      appPath,
    };
  }
}

async function showPinnedAppDialog(
  event: IpcMainInvokeEvent,
  title: string,
): Promise<string | undefined> {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const dialogOptions: OpenDialogOptions = {
    filters: [
      {
        extensions: ['exe', 'lnk'],
        name: 'Applications',
      },
    ],
    properties: ['openFile'],
    title,
  };
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }

  return result.filePaths[0]!;
}

async function resolveAppCandidateIcon(candidate: InternalAppCandidate) {
  const iconSearchResult = {
    iconCandidates: candidate.iconCandidates,
    id: candidate.id,
    score: candidate.alreadyPinned ? 0 : 1,
    source: 'app',
    subtitle: candidate.subtitle,
    title: candidate.title,
  } as const;
  const resolvedIcon = await appIconResolver.resolveSearchResultIcon(
    candidate.iconPath === undefined
      ? iconSearchResult
      : {
          ...iconSearchResult,
          icon: candidate.iconPath,
        },
  );
  const publicCandidate: AppCandidate = {
    alreadyPinned: candidate.alreadyPinned,
    id: candidate.id,
    resolutionStatus: candidate.resolutionStatus,
    shortcutPath: candidate.shortcutPath,
    source: candidate.source,
    subtitle: candidate.subtitle,
    title: candidate.title,
  };

  if (candidate.executablePath !== undefined) {
    publicCandidate.executablePath = candidate.executablePath;
  }

  if (candidate.iconPath !== undefined) {
    publicCandidate.iconPath = candidate.iconPath;
  }

  if (resolvedIcon.icon !== undefined) {
    publicCandidate.icon = resolvedIcon.icon;
  }

  return publicCandidate;
}

const hasSingleInstanceLock = configureSingleInstance({
  app,
  showExistingWindow: showExistingApplicationInstance,
});

ipcMain.handle(SEARCH_COMMANDS_CHANNEL, async (_event, query: unknown) => {
  const results = await launcherCommandService.searchCommands(
    typeof query === 'string' ? query : '',
  );

  return hydrateSearchResultsWithCachedIcons(results, {
    appIconResolver,
  });
});

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

ipcMain.handle(ADD_PINNED_APP_CHANNEL, async (event) => {
  const appPath = await showPinnedAppDialog(event, 'Add application');

  if (appPath === undefined) {
    return undefined;
  }

  return launcherCommandService.addPinnedApp(await createPinnedAppInput(appPath));
});

ipcMain.handle(LIST_APP_CANDIDATES_CHANNEL, async (_event, query: unknown) =>
  Promise.all(
    (await appCandidateService.listCandidates(typeof query === 'string' ? query : '')).map(
      resolveAppCandidateIcon,
    ),
  ),
);

ipcMain.handle(ADD_PINNED_APP_CANDIDATE_CHANNEL, (_event, input: unknown) =>
  launcherCommandService.addPinnedApp(
    appCandidateService.createPinnedAppInput(parseAppCandidateAddRequest(input)),
  ),
);

ipcMain.handle(UPDATE_PINNED_APP_CHANNEL, async (event, id: unknown) => {
  const appPath = await showPinnedAppDialog(event, 'Modify application');

  if (appPath === undefined) {
    return undefined;
  }

  return launcherCommandService.updatePinnedApp(
    parseFavoriteId(id),
    await createPinnedAppInput(appPath),
  );
});

ipcMain.handle(UPDATE_FAVORITE_CHANNEL, (_event, id: unknown, input: unknown) =>
  launcherCommandService.updateFavorite(parseFavoriteId(id), parseFavoriteUpdateRequest(input)),
);

ipcMain.handle(REMOVE_FAVORITE_CHANNEL, (_event, id: unknown) =>
  launcherCommandService.removeFavorite(parseFavoriteId(id)),
);

ipcMain.handle(REMOVE_RECENT_APP_CHANNEL, (_event, commandId: unknown) =>
  launcherCommandService.removeRecentApp(typeof commandId === 'string' ? commandId : ''),
);

ipcMain.handle(CLEAR_CLIPBOARD_HISTORY_CHANNEL, () =>
  launcherCommandService.clearClipboardHistory(),
);

ipcMain.handle(GET_SETTINGS_CHANNEL, () => settingsStore.getSettings());

ipcMain.handle(GET_UPDATE_STATUS_CHANNEL, () => getUpdateController().getStatus());

ipcMain.handle(CHECK_FOR_UPDATES_CHANNEL, () => getUpdateController().checkForUpdates());

ipcMain.handle(INSTALL_UPDATE_CHANNEL, () => getUpdateController().installUpdate());

function tryRegisterPendingScreenshotHotkey(): boolean {
  return false;
}

ipcMain.handle(UPDATE_SETTINGS_CHANNEL, (_event, input: unknown) => {
  altSpaceHotkeyCapture.stop();
  const settingsPatch = parseSettingsPatch(input);
  const updatedSettings = updateSettingsWithHotkeyRegistration({
    settingsPatch,
    settingsStore,
    tryRegisterLauncherHotkey: desktopApplication.tryRegisterGlobalHotkey,
    tryRegisterScreenshotHotkey: tryRegisterPendingScreenshotHotkey,
  });

  if (settingsPatch.launchAtLogin !== undefined) {
    launchAtLoginController.sync(updatedSettings.launchAtLogin);
  }

  if (settingsPatch.language !== undefined) {
    trayController?.updateLanguage(updatedSettings.language);
  }

  return updatedSettings;
});

ipcMain.handle(START_HOTKEY_INPUT_CAPTURE_CHANNEL, (event) =>
  altSpaceHotkeyCapture.start(event.sender),
);

ipcMain.handle(STOP_HOTKEY_INPUT_CAPTURE_CHANNEL, () => {
  altSpaceHotkeyCapture.stop();
  return true;
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

if (hasSingleInstanceLock) {
  startupPromise = startApplication();
}

app.on('activate', () => {
  void desktopApplication.handleActivate();
});

app.on('window-all-closed', () => {
  if (desktopApplication.isQuitRequested() && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  desktopApplication.requestQuit();

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
  trayController?.dispose();
  trayController = undefined;
  desktopApplication.dispose();
  globalShortcut.unregisterAll();
  if (clipboardHistoryRuntime || commandCabinDatabase) {
    void stopClipboardHistoryAndCloseDatabase();
  }
});
