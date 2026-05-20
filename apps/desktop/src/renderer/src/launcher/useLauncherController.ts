import { type KeyboardEvent, useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import type { DesktopApi } from '../../../preload/index.js';
import type { FavoriteCreateRequest, FavoriteListRecord } from '../../../shared/favoritesApi.js';
import type {
  LauncherCommandExecutionResult,
  LauncherCommandSearchResult,
} from '../../../shared/launcherApi.js';
import type { PluginHostEntry } from '../plugin-host/PluginHost.js';

export type LauncherResultItem = LauncherCommandSearchResult;
export type LauncherStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'executing';
export type LauncherSelectionDirection = 'next' | 'previous';
export type LauncherKeyIntent = 'select-next' | 'select-previous' | 'execute' | 'hide';

export interface PluginPageLaunchRequest {
  name: string;
  pluginId: string;
  pluginRoot: string;
  uiPath: string;
}

export interface PluginPageLaunchApi {
  createEntry: (input: PluginPageLaunchRequest) => Promise<PluginHostEntry>;
}

export interface LauncherControllerOptions {
  onOpenPluginPage?: ((plugin: PluginHostEntry) => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
}

export const LAUNCHER_SEARCH_INPUT_ID = 'launcher-search-input';
export const LAUNCHER_RESULT_LISTBOX_ID = 'launcher-results-listbox';

export interface LauncherState {
  errorMessage: string | undefined;
  query: string;
  requestId: number;
  results: LauncherResultItem[];
  selectedIndex: number;
  status: LauncherStatus;
}

type LauncherAction =
  | {
      query: string;
      type: 'query-changed';
    }
  | {
      requestId: number;
      type: 'search-started';
    }
  | {
      requestId: number;
      results: LauncherResultItem[];
      type: 'search-succeeded';
    }
  | {
      errorMessage: string;
      requestId: number;
      type: 'search-failed';
    }
  | {
      direction: LauncherSelectionDirection;
      type: 'move-selection';
    }
  | {
      index: number;
      type: 'select-index';
    }
  | {
      type: 'execution-started';
    }
  | {
      type: 'execution-succeeded';
    }
  | {
      errorMessage: string;
      type: 'execution-failed';
    }
  | {
      preserveSearchQuery: boolean;
      type: 'launcher-focused';
    };

const fallbackResults: LauncherResultItem[] = [
  {
    id: 'fallback.open-settings',
    score: 1,
    source: 'system',
    title: 'Open Settings',
    subtitle: 'CommandCabin preferences',
  },
  {
    id: 'fallback.reload-launcher',
    score: 0.95,
    source: 'system',
    title: 'Reload Launcher',
    subtitle: 'Refresh the desktop shell',
  },
  {
    id: 'fallback.copy-version',
    score: 0.9,
    source: 'system',
    title: 'Copy Version Info',
    subtitle: 'Copy runtime details for diagnostics',
  },
];

function createFallbackFavoriteRecord(input: FavoriteCreateRequest): FavoriteListRecord {
  const timestamp = new Date(0).toISOString();
  const baseRecord = {
    id: `fallback.favorite.${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title: input.title,
    keywords: [...input.keywords],
    metadata: input.metadata ?? {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  if (input.kind === 'url') {
    return {
      ...baseRecord,
      kind: input.kind,
      url: input.url,
    };
  }

  return {
    ...baseRecord,
    kind: input.kind,
    path: input.path,
  };
}

const fallbackDesktopApi: DesktopApi = {
  addFavorite: async (input) => createFallbackFavoriteRecord(input),
  addPinnedApp: async () => undefined,
  addPinnedAppCandidate: async (candidate) =>
    createFallbackFavoriteRecord({
      kind: 'file',
      keywords: [candidate.title],
      metadata: {
        launcherPinnedApp: true,
      },
      path: candidate.shortcutPath,
      title: candidate.title,
    }),
  clearClipboardHistory: async () => 0,
  checkForUpdates: async () => ({
    canCheck: false,
    canInstall: false,
    phase: 'unavailable',
  }),
  executeCommand: async (commandId) => ({
    status: 'success',
    actionType: 'run-system',
    commandId,
    metadata: {
      handled: true,
    },
  }),
  getAppInfo: () => ({
    name: 'CommandCabin',
    version: '0.0.0',
    versions: {
      chrome: 'Chromium',
      electron: 'Electron',
      node: 'Node',
    },
  }),
  getDataDirectory: async () => ({
    path: '',
  }),
  getSettings: async () => ({
    hideOnBlur: true,
    hotkey: 'Alt+Space',
    screenshotHotkey: 'Ctrl+Alt+A',
    language: 'zh-CN',
    launchAtLogin: false,
    preserveSearchQuery: false,
    search: {
      appBoost: 1.2,
      fileBoost: 0.9,
      historyBoost: 1.4,
      maxResults: 20,
      pluginBoost: 1,
    },
    theme: 'system',
  }),
  getUpdateStatus: async () => ({
    canCheck: false,
    canInstall: false,
    phase: 'unavailable',
  }),
  hideLauncher: async () => undefined,
  installPlugin: async (pluginRoot) => {
    const timestamp = new Date(0).toISOString();

    return {
      enabled: true,
      id: 'com.example.fallback',
      installedAt: timestamp,
      main: 'dist/main.js',
      name: 'Fallback Plugin',
      permissions: [],
      pluginRoot,
      updatedAt: timestamp,
      version: '0.1.0',
    };
  },
  installUpdate: async () => ({
    error: 'Update is not ready to install.',
    ok: false,
  }),
  listFavorites: async () => [],
  listAppCandidates: async () => [],
  listPlugins: async () => [],
  onFocusSearchInput: () => () => undefined,
  onHotkeyInputCapture: () => () => undefined,
  onOpenSettings: () => () => undefined,
  onUpdateStatusChanged: () => () => undefined,
  openDataDirectory: async () => ({
    path: '',
  }),
  pluginHost: {
    createEntry: async (input) => {
      const pluginRootPath = input.pluginRoot.replace(/\\/g, '/');
      const normalizedRootPath = pluginRootPath.startsWith('/')
        ? pluginRootPath
        : `/${pluginRootPath}`;
      const allowedBaseUrl = `file://${
        normalizedRootPath.endsWith('/') ? normalizedRootPath : `${normalizedRootPath}/`
      }`;
      const uiPath = input.uiPath.replace(/\\/g, '/').replace(/^\/+/, '');

      return {
        allowedBaseUrl,
        entryUrl: `${allowedBaseUrl}${uiPath}`,
        launchToken: 'fallback-launch-token',
        name: input.name,
        partition: `command-cabin-plugin:${input.pluginId.replace(/[^a-zA-Z0-9_-]/g, '-')}:fallback-launch-token`,
        pluginId: input.pluginId,
      };
    },
    getBridgeInfo: () => ({
      channel: 'command-cabin:plugin-bridge',
      methods: ['close', 'reportError'],
    }),
    getPluginBridgePreloadPath: () => '',
    releaseEntry: async () => false,
  },
  removeFavorite: async () => false,
  removePlugin: async () => false,
  removeRecentApp: async () => false,
  searchCommands: async (query) => {
    const normalizedQuery = query.trim().toLowerCase();

    if (normalizedQuery.length === 0) {
      return fallbackResults;
    }

    return fallbackResults.filter((result) => {
      const subtitle = result.subtitle ?? '';
      return `${result.title} ${subtitle}`.toLowerCase().includes(normalizedQuery);
    });
  },
  setPluginEnabled: async () => undefined,
  startHotkeyInputCapture: async () => false,
  stopHotkeyInputCapture: async () => true,
  updatePinnedApp: async () => undefined,
  updateFavorite: async () => undefined,
  updateSettings: async (patch) => ({
    hideOnBlur: patch.hideOnBlur ?? true,
    hotkey: patch.hotkey ?? 'Alt+Space',
    screenshotHotkey: patch.screenshotHotkey ?? 'Ctrl+Alt+A',
    language: patch.language ?? 'zh-CN',
    launchAtLogin: patch.launchAtLogin ?? false,
    preserveSearchQuery: patch.preserveSearchQuery ?? false,
    search: {
      appBoost: patch.search?.appBoost ?? 1.2,
      fileBoost: patch.search?.fileBoost ?? 0.9,
      historyBoost: patch.search?.historyBoost ?? 1.4,
      maxResults: patch.search?.maxResults ?? 20,
      pluginBoost: patch.search?.pluginBoost ?? 1,
    },
    theme: patch.theme ?? 'system',
  }),
};

export const initialLauncherState: LauncherState = {
  errorMessage: undefined,
  query: '',
  requestId: 0,
  results: [],
  selectedIndex: -1,
  status: 'idle',
};

function getDesktopApi(): DesktopApi {
  if (typeof window !== 'undefined' && 'desktopApi' in window) {
    return window.desktopApi;
  }

  return fallbackDesktopApi;
}

function formatUnknownError(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return fallbackMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const stringValue = value.trim();

  return stringValue.length > 0 ? stringValue : undefined;
}

function getSelectedIndexForResults(results: readonly LauncherResultItem[]): number {
  return results.length > 0 ? 0 : -1;
}

function moveSelectedIndex(
  selectedIndex: number,
  itemCount: number,
  direction: LauncherSelectionDirection,
): number {
  if (itemCount <= 0) {
    return -1;
  }

  const delta = direction === 'next' ? 1 : -1;
  const baseIndex = selectedIndex < 0 ? 0 : selectedIndex;

  return (baseIndex + delta + itemCount) % itemCount;
}

function clampSelectedIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) {
    return -1;
  }

  return Math.max(0, Math.min(index, itemCount - 1));
}

function statusForResults(results: readonly LauncherResultItem[]): LauncherStatus {
  return results.length > 0 ? 'ready' : 'empty';
}

export function getLauncherOptionId(commandId: string): string {
  return `launcher-option-${commandId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function createLauncherSearchRequestKey(state: LauncherState): string {
  return `${state.requestId}\u0000${state.query}`;
}

export function getExecutableSelectedResult(state: LauncherState): LauncherResultItem | undefined {
  if (state.status !== 'ready') {
    return undefined;
  }

  if (state.selectedIndex < 0) {
    return undefined;
  }

  return state.results[state.selectedIndex];
}

export function isHorizontalLauncherNavigation(state: LauncherState): boolean {
  return (
    state.status === 'ready' &&
    state.query.trim().length === 0 &&
    state.results.length > 0 &&
    state.results.every((result) => result.source === 'app')
  );
}

export function getLauncherKeyIntent(
  key: string,
  useHorizontalNavigation = false,
): LauncherKeyIntent | undefined {
  switch (key) {
    case 'ArrowDown':
      return 'select-next';
    case 'ArrowUp':
      return 'select-previous';
    case 'ArrowRight':
      return useHorizontalNavigation ? 'select-next' : undefined;
    case 'ArrowLeft':
      return useHorizontalNavigation ? 'select-previous' : undefined;
    case 'Enter':
      return 'execute';
    case 'Escape':
      return 'hide';
    default:
      return undefined;
  }
}

export function getPluginPageLaunchRequest(
  result: LauncherCommandExecutionResult,
): PluginPageLaunchRequest | undefined {
  if (result.status !== 'success' || result.actionType !== 'run-plugin') {
    return undefined;
  }

  const pluginPage = result.metadata.pluginPage;

  if (!isRecord(pluginPage)) {
    return undefined;
  }

  const name = parseNonEmptyString(pluginPage.name);
  const pluginId = parseNonEmptyString(pluginPage.pluginId);
  const pluginRoot = parseNonEmptyString(pluginPage.pluginRoot);
  const uiPath = parseNonEmptyString(pluginPage.uiPath);

  if (!name || !pluginId || !pluginRoot || !uiPath) {
    return undefined;
  }

  return {
    name,
    pluginId,
    pluginRoot,
    uiPath,
  };
}

export function openPluginPageFromExecutionResult(
  result: LauncherCommandExecutionResult,
  pluginHost: PluginPageLaunchApi,
  onOpenPluginPage: ((plugin: PluginHostEntry) => void) | undefined,
): Promise<boolean> {
  if (!onOpenPluginPage) {
    return Promise.resolve(false);
  }

  const launchRequest = getPluginPageLaunchRequest(result);

  if (!launchRequest) {
    return Promise.resolve(false);
  }

  return pluginHost.createEntry(launchRequest).then((entry) => {
    onOpenPluginPage(entry);
    return true;
  });
}

export type SystemExecutionAction = 'open-settings';

export function getSystemExecutionAction(
  result: LauncherCommandExecutionResult,
): SystemExecutionAction | undefined {
  if (result.status !== 'success' || result.actionType !== 'run-system') {
    return undefined;
  }

  return result.metadata.systemCommand === 'open-settings' ? 'open-settings' : undefined;
}

export function launcherReducer(state: LauncherState, action: LauncherAction): LauncherState {
  switch (action.type) {
    case 'query-changed':
      return {
        ...state,
        errorMessage: undefined,
        query: action.query,
        requestId: state.requestId + 1,
        results: [],
        selectedIndex: -1,
        status: 'loading',
      };
    case 'launcher-focused':
      if (action.preserveSearchQuery || state.query.length === 0) {
        return state;
      }

      return {
        ...state,
        errorMessage: undefined,
        query: '',
        requestId: state.requestId + 1,
        results: [],
        selectedIndex: -1,
        status: 'loading',
      };
    case 'search-started':
      return {
        ...state,
        errorMessage: undefined,
        requestId: action.requestId,
        results: [],
        selectedIndex: -1,
        status: 'loading',
      };
    case 'search-succeeded':
      if (action.requestId !== state.requestId) {
        return state;
      }

      return {
        ...state,
        errorMessage: undefined,
        results: action.results,
        selectedIndex: getSelectedIndexForResults(action.results),
        status: statusForResults(action.results),
      };
    case 'search-failed':
      if (action.requestId !== state.requestId) {
        return state;
      }

      return {
        ...state,
        errorMessage: action.errorMessage,
        results: [],
        selectedIndex: -1,
        status: 'error',
      };
    case 'move-selection':
      if (state.status !== 'ready') {
        return state;
      }

      return {
        ...state,
        selectedIndex: moveSelectedIndex(
          state.selectedIndex,
          state.results.length,
          action.direction,
        ),
      };
    case 'select-index':
      if (state.status === 'executing') {
        return state;
      }

      return {
        ...state,
        selectedIndex: clampSelectedIndex(action.index, state.results.length),
      };
    case 'execution-started':
      return {
        ...state,
        errorMessage: undefined,
        status: 'executing',
      };
    case 'execution-succeeded':
      return {
        ...state,
        status: statusForResults(state.results),
      };
    case 'execution-failed':
      return {
        ...state,
        errorMessage: action.errorMessage,
        results: [],
        selectedIndex: -1,
        status: 'error',
      };
  }
}

function getExecutionErrorMessage(result: LauncherCommandExecutionResult): string | undefined {
  if (result.status === 'success') {
    return undefined;
  }

  return result.error.message;
}

export function useLauncherController(options: LauncherControllerOptions = {}) {
  const { onOpenPluginPage, onOpenSettings } = options;
  const desktopApi = useMemo(getDesktopApi, []);
  const [state, dispatch] = useReducer(launcherReducer, initialLauncherState);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastStartedSearchKeyRef = useRef<string | undefined>(undefined);
  const nextRequestIdRef = useRef(0);
  const executionInFlightRef = useRef(false);
  const isMountedRef = useRef(false);
  const preserveSearchQueryRef = useRef(false);

  const selectedResult = state.selectedIndex >= 0 ? state.results[state.selectedIndex] : undefined;
  const executableSelectedResult = getExecutableSelectedResult(state);
  const searchRequestKey = createLauncherSearchRequestKey(state);

  const focusSearchInput = useCallback(() => {
    dispatch({
      preserveSearchQuery: preserveSearchQueryRef.current,
      type: 'launcher-focused',
    });
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const setQuery = useCallback((query: string) => {
    dispatch({
      query,
      type: 'query-changed',
    });
  }, []);

  const selectResult = useCallback((index: number) => {
    dispatch({
      index,
      type: 'select-index',
    });
  }, []);

  const hideLauncher = useCallback(async () => {
    try {
      await desktopApi.hideLauncher();
    } catch (error) {
      dispatch({
        errorMessage: formatUnknownError(error, 'Launcher could not be hidden.'),
        type: 'execution-failed',
      });
    }
  }, [desktopApi]);

  const executeSelectedCommand = useCallback(async () => {
    if (!executableSelectedResult || executionInFlightRef.current) {
      return;
    }

    executionInFlightRef.current = true;
    dispatch({
      type: 'execution-started',
    });

    try {
      const executionResult = await desktopApi.executeCommand(executableSelectedResult.id);
      const executionErrorMessage = getExecutionErrorMessage(executionResult);

      if (executionErrorMessage) {
        dispatch({
          errorMessage: executionErrorMessage,
          type: 'execution-failed',
        });
        return;
      }

      dispatch({
        type: 'execution-succeeded',
      });
      if (getSystemExecutionAction(executionResult) === 'open-settings') {
        onOpenSettings?.();
        return;
      }

      if (
        await openPluginPageFromExecutionResult(
          executionResult,
          desktopApi.pluginHost,
          onOpenPluginPage,
        )
      ) {
        return;
      }

      await desktopApi.hideLauncher();
    } catch (error) {
      dispatch({
        errorMessage: formatUnknownError(error, 'Command execution failed.'),
        type: 'execution-failed',
      });
    } finally {
      executionInFlightRef.current = false;
    }
  }, [desktopApi, executableSelectedResult, onOpenPluginPage, onOpenSettings]);

  const refreshCurrentQuery = useCallback(() => {
    dispatch({
      query: state.query,
      type: 'query-changed',
    });
    focusSearchInput();
  }, [focusSearchInput, state.query]);

  const addPinnedApp = useCallback(async () => {
    try {
      const favorite = await desktopApi.addPinnedApp();

      if (favorite === undefined) {
        focusSearchInput();
        return;
      }

      refreshCurrentQuery();
    } catch (error) {
      dispatch({
        errorMessage: formatUnknownError(error, 'Pinned app could not be added.'),
        type: 'execution-failed',
      });
    }
  }, [desktopApi, focusSearchInput, refreshCurrentQuery]);

  const editPinnedApp = useCallback(
    async (favoriteId: string) => {
      try {
        const favorite = await desktopApi.updatePinnedApp(favoriteId);

        if (favorite === undefined) {
          focusSearchInput();
          return;
        }

        refreshCurrentQuery();
      } catch (error) {
        dispatch({
          errorMessage: formatUnknownError(error, 'Pinned app could not be updated.'),
          type: 'execution-failed',
        });
      }
    },
    [desktopApi, focusSearchInput, refreshCurrentQuery],
  );

  const removePinnedApp = useCallback(
    async (favoriteId: string) => {
      try {
        await desktopApi.removeFavorite(favoriteId);
        refreshCurrentQuery();
      } catch (error) {
        dispatch({
          errorMessage: formatUnknownError(error, 'Pinned app could not be removed.'),
          type: 'execution-failed',
        });
      }
    },
    [desktopApi, refreshCurrentQuery],
  );

  const removeRecentApp = useCallback(
    async (commandId: string) => {
      try {
        await desktopApi.removeRecentApp(commandId);
        refreshCurrentQuery();
      } catch (error) {
        dispatch({
          errorMessage: formatUnknownError(error, 'Recent app could not be removed.'),
          type: 'execution-failed',
        });
      }
    },
    [desktopApi, refreshCurrentQuery],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const intent = getLauncherKeyIntent(event.key, isHorizontalLauncherNavigation(state));

      if (!intent) {
        return;
      }

      event.preventDefault();

      if (intent === 'select-next') {
        dispatch({
          direction: 'next',
          type: 'move-selection',
        });
        return;
      }

      if (intent === 'select-previous') {
        dispatch({
          direction: 'previous',
          type: 'move-selection',
        });
        return;
      }

      if (intent === 'execute') {
        void executeSelectedCommand();
        return;
      }

      void hideLauncher();
    },
    [executeSelectedCommand, hideLauncher, state],
  );

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let isCurrent = true;

    desktopApi
      .getSettings()
      .then((settings) => {
        if (isCurrent) {
          preserveSearchQueryRef.current = settings.preserveSearchQuery;
        }
      })
      .catch(() => {
        if (isCurrent) {
          preserveSearchQueryRef.current = false;
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [desktopApi]);

  useEffect(() => {
    focusSearchInput();
    return desktopApi.onFocusSearchInput(focusSearchInput);
  }, [desktopApi, focusSearchInput]);

  useEffect(() => {
    const requestId =
      state.status === 'loading' && state.requestId > 0
        ? state.requestId
        : nextRequestIdRef.current + 1;
    const nextSearchKey = createLauncherSearchRequestKey({
      ...state,
      requestId,
    });

    if (lastStartedSearchKeyRef.current === nextSearchKey) {
      return;
    }

    lastStartedSearchKeyRef.current = nextSearchKey;
    nextRequestIdRef.current = requestId;

    dispatch({
      requestId,
      type: 'search-started',
    });

    desktopApi
      .searchCommands(state.query)
      .then((results) => {
        if (!isMountedRef.current) {
          return;
        }

        dispatch({
          requestId,
          results,
          type: 'search-succeeded',
        });
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current) {
          return;
        }

        dispatch({
          errorMessage: formatUnknownError(error, 'Search failed.'),
          requestId,
          type: 'search-failed',
        });
      });
  }, [desktopApi, searchRequestKey, state.query]);

  return {
    activeDescendantId: selectedResult ? getLauncherOptionId(selectedResult.id) : undefined,
    addPinnedApp,
    appInfo: desktopApi.getAppInfo(),
    editPinnedApp,
    executeSelectedCommand,
    handleKeyDown,
    inputRef,
    isExecutionDisabled: state.status !== 'ready',
    isExpanded: state.status !== 'idle',
    refreshCurrentQuery,
    resultListboxId: LAUNCHER_RESULT_LISTBOX_ID,
    searchInputId: LAUNCHER_SEARCH_INPUT_ID,
    selectedResult,
    selectResult,
    setQuery,
    removePinnedApp,
    removeRecentApp,
    state,
  };
}
