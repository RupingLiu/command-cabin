import { describe, expect, it, vi } from 'vitest';

import {
  getExecutableSelectedResult,
  getLauncherKeyIntent,
  createLauncherSearchRequestKey,
  createStartScreenshotCapture,
  getPluginPageLaunchRequest,
  getSystemExecutionAction,
  isHorizontalLauncherNavigation,
  openPluginPageFromExecutionResult,
  launcherReducer,
  type LauncherResultItem,
  type LauncherState,
} from './useLauncherController.js';

const baseState: LauncherState = {
  errorMessage: undefined,
  query: '',
  requestId: 0,
  results: [],
  selectedIndex: -1,
  status: 'idle',
};

function createResult(id: string): LauncherResultItem {
  return {
    id,
    source: 'system',
    title: `Command ${id}`,
    subtitle: 'System command',
  };
}

function createAppResult(id: string): LauncherResultItem {
  return {
    id,
    source: 'app',
    title: `App ${id}`,
  };
}

describe('launcher controller state', () => {
  it('treats a request id change as a new search even when the query is unchanged', () => {
    const firstSearch = createLauncherSearchRequestKey({
      ...baseState,
      query: '',
      requestId: 1,
    });
    const refreshedSearch = createLauncherSearchRequestKey({
      ...baseState,
      query: '',
      requestId: 2,
    });

    expect(refreshedSearch).not.toBe(firstSearch);
  });

  it('clears or preserves the query when the launcher receives focus', () => {
    const ready: LauncherState = {
      ...baseState,
      query: 'wps',
      requestId: 1,
      results: [createResult('wps')],
      selectedIndex: 0,
      status: 'ready',
    };

    const cleared = launcherReducer(ready, {
      preserveSearchQuery: false,
      type: 'launcher-focused',
    } as never);

    expect(cleared).toMatchObject({
      query: '',
      requestId: 2,
      results: [],
      selectedIndex: -1,
      status: 'loading',
    });

    const preserved = launcherReducer(ready, {
      preserveSearchQuery: true,
      type: 'launcher-focused',
    } as never);

    expect(preserved).toBe(ready);
  });

  it('clears stale results and selection while a new search is loading', () => {
    const ready: LauncherState = {
      ...baseState,
      requestId: 1,
      results: [createResult('old')],
      selectedIndex: 0,
      status: 'ready',
    };

    const queryChanged = launcherReducer(ready, {
      query: 'new query',
      type: 'query-changed',
    });

    expect(queryChanged).toMatchObject({
      query: 'new query',
      results: [],
      selectedIndex: -1,
      status: 'loading',
    });

    const loading = launcherReducer(ready, {
      requestId: 2,
      type: 'search-started',
    });

    expect(loading).toMatchObject({
      errorMessage: undefined,
      requestId: 2,
      results: [],
      selectedIndex: -1,
      status: 'loading',
    });
  });

  it('ignores stale search results', () => {
    const loading = launcherReducer(baseState, {
      requestId: 2,
      type: 'search-started',
    });

    const staleSuccess = launcherReducer(loading, {
      requestId: 1,
      results: [createResult('stale')],
      type: 'search-succeeded',
    });

    expect(staleSuccess).toBe(loading);
  });

  it('merges image icon updates into matching visible results only', () => {
    const ready: LauncherState = {
      ...baseState,
      requestId: 1,
      results: [
        createAppResult('app.wps'),
        createAppResult('app.codex'),
        createResult('system.settings'),
      ],
      selectedIndex: 1,
      status: 'ready',
    };

    const updated = launcherReducer(ready, {
      results: [
        {
          ...createAppResult('app.wps'),
          icon: 'data:image/png;base64,WPS',
        },
        {
          ...createAppResult('app.codex'),
          icon: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        },
        {
          ...createAppResult('app.missing'),
          icon: 'data:image/png;base64,MISSING',
        },
      ],
      type: 'search-result-icons-updated',
    });

    expect(updated).toMatchObject({
      selectedIndex: 1,
      status: 'ready',
    });
    expect(updated.results).toEqual([
      {
        ...ready.results[0]!,
        icon: 'data:image/png;base64,WPS',
      },
      ready.results[1]!,
      ready.results[2]!,
    ]);

    const ignored = launcherReducer(ready, {
      results: [
        {
          ...createAppResult('app.codex'),
          icon: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        },
      ],
      type: 'search-result-icons-updated',
    });

    expect(ignored).toBe(ready);
  });

  it('selects the first result after a successful search and wraps arrow navigation', () => {
    const loading = launcherReducer(baseState, {
      requestId: 1,
      type: 'search-started',
    });
    const ready = launcherReducer(loading, {
      requestId: 1,
      results: [createResult('alpha'), createResult('bravo')],
      type: 'search-succeeded',
    });

    expect(ready.status).toBe('ready');
    expect(ready.selectedIndex).toBe(0);

    const previous = launcherReducer(ready, {
      direction: 'previous',
      type: 'move-selection',
    });

    expect(previous.selectedIndex).toBe(1);

    const next = launcherReducer(previous, {
      direction: 'next',
      type: 'move-selection',
    });

    expect(next.selectedIndex).toBe(0);
  });

  it('represents empty and error states without a selected item', () => {
    const loading = launcherReducer(baseState, {
      requestId: 1,
      type: 'search-started',
    });
    const empty = launcherReducer(loading, {
      requestId: 1,
      results: [],
      type: 'search-succeeded',
    });

    expect(empty).toMatchObject({
      results: [],
      selectedIndex: -1,
      status: 'empty',
    });

    const error = launcherReducer(
      {
        ...empty,
        requestId: 2,
      },
      {
        errorMessage: 'Search failed.',
        requestId: 2,
        type: 'search-failed',
      },
    );

    expect(error).toMatchObject({
      errorMessage: 'Search failed.',
      results: [],
      selectedIndex: -1,
      status: 'error',
    });
  });
});

describe('launcher execution guard', () => {
  it('returns only the selected result from a ready launcher state', () => {
    const ready: LauncherState = {
      ...baseState,
      results: [createResult('alpha'), createResult('bravo')],
      selectedIndex: 1,
      status: 'ready',
    };

    expect(getExecutableSelectedResult(ready)?.id).toBe('bravo');
  });

  it('does not expose a stale executable result when Enter is pressed after the query changes', () => {
    const ready: LauncherState = {
      ...baseState,
      results: [createResult('old')],
      selectedIndex: 0,
      status: 'ready',
    };
    const loading = launcherReducer(ready, {
      query: 'new query',
      type: 'query-changed',
    });

    expect(getLauncherKeyIntent('Enter')).toBe('execute');
    expect(getExecutableSelectedResult(loading)).toBeUndefined();
  });

  it('does not expose an executable result while execution is already in progress', () => {
    const executing: LauncherState = {
      ...baseState,
      results: [createResult('alpha')],
      selectedIndex: 0,
      status: 'executing',
    };

    expect(getExecutableSelectedResult(executing)).toBeUndefined();
  });
});

describe('launcher keyboard intent', () => {
  it.each([
    ['ArrowDown', 'select-next'],
    ['ArrowUp', 'select-previous'],
    ['Enter', 'execute'],
    ['Escape', 'hide'],
  ] as const)('maps %s to %s', (key, expectedIntent) => {
    expect(getLauncherKeyIntent(key)).toBe(expectedIntent);
  });

  it('ignores unrelated keys', () => {
    expect(getLauncherKeyIntent('Tab')).toBeUndefined();
  });

  it('uses left and right arrows only for blank-query app grids', () => {
    expect(getLauncherKeyIntent('ArrowRight')).toBeUndefined();
    expect(getLauncherKeyIntent('ArrowLeft')).toBeUndefined();
    expect(getLauncherKeyIntent('ArrowRight', true)).toBe('select-next');
    expect(getLauncherKeyIntent('ArrowLeft', true)).toBe('select-previous');
  });

  it('identifies blank-query app grids as horizontal keyboard navigation', () => {
    const appGridState: LauncherState = {
      ...baseState,
      query: '',
      results: [createAppResult('wps'), createAppResult('wechat')],
      selectedIndex: 0,
      status: 'ready',
    };
    const searchedAppState: LauncherState = {
      ...appGridState,
      query: 'wps',
    };
    const systemState: LauncherState = {
      ...appGridState,
      results: [createResult('settings')],
    };

    expect(isHorizontalLauncherNavigation(appGridState)).toBe(true);
    expect(isHorizontalLauncherNavigation(searchedAppState)).toBe(false);
    expect(isHorizontalLauncherNavigation(systemState)).toBe(false);
  });
});

describe('launcher plugin page launch requests', () => {
  it('extracts a validated plugin page request from a successful plugin execution result', () => {
    expect(
      getPluginPageLaunchRequest({
        status: 'success',
        actionType: 'run-plugin',
        commandId: 'com.example.text-tools.open-ui',
        metadata: {
          pluginPage: {
            name: 'Text Tools',
            pluginId: 'com.example.text-tools',
            pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
            uiPath: 'ui/index.html',
          },
        },
      }),
    ).toEqual({
      name: 'Text Tools',
      pluginId: 'com.example.text-tools',
      pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
      uiPath: 'ui/index.html',
    });
  });

  it('ignores non-plugin executions and malformed plugin page metadata', () => {
    expect(
      getPluginPageLaunchRequest({
        status: 'success',
        actionType: 'copy-text',
        commandId: 'system.copy-version',
        metadata: {
          pluginPage: {
            name: 'Text Tools',
          },
        },
      }),
    ).toBeUndefined();

    expect(
      getPluginPageLaunchRequest({
        status: 'success',
        actionType: 'run-plugin',
        commandId: 'com.example.text-tools.open-ui',
        metadata: {
          pluginPage: {
            name: 'Text Tools',
            pluginId: '',
            pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
            uiPath: 'ui/index.html',
          },
        },
      }),
    ).toBeUndefined();
  });

  it('turns plugin execution metadata into a PluginHost entry through the preload API', async () => {
    const createEntry = vi.fn(async () => ({
      allowedBaseUrl: 'file:///C:/CommandCabin/plugins/text-tools/',
      entryUrl: 'file:///C:/CommandCabin/plugins/text-tools/ui/index.html',
      launchToken: 'launch-1',
      name: 'Text Tools',
      partition: 'command-cabin-plugin:com-example-text-tools:launch-1',
      pluginId: 'com.example.text-tools',
    }));
    const onOpenPluginPage = vi.fn();

    await expect(
      openPluginPageFromExecutionResult(
        {
          status: 'success',
          actionType: 'run-plugin',
          commandId: 'com.example.text-tools.open-ui',
          metadata: {
            pluginPage: {
              name: 'Text Tools',
              pluginId: 'com.example.text-tools',
              pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
              uiPath: 'ui/index.html',
            },
          },
        },
        {
          createEntry,
        },
        onOpenPluginPage,
      ),
    ).resolves.toBe(true);

    expect(createEntry).toHaveBeenCalledWith({
      name: 'Text Tools',
      pluginId: 'com.example.text-tools',
      pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
      uiPath: 'ui/index.html',
    });
    expect(onOpenPluginPage).toHaveBeenCalledWith({
      allowedBaseUrl: 'file:///C:/CommandCabin/plugins/text-tools/',
      entryUrl: 'file:///C:/CommandCabin/plugins/text-tools/ui/index.html',
      launchToken: 'launch-1',
      name: 'Text Tools',
      partition: 'command-cabin-plugin:com-example-text-tools:launch-1',
      pluginId: 'com.example.text-tools',
    });
  });
});

describe('launcher system execution actions', () => {
  it('maps open-settings execution metadata to a renderer settings action', () => {
    expect(
      getSystemExecutionAction({
        status: 'success',
        actionType: 'run-system',
        commandId: 'system.open-settings',
        metadata: {
          systemCommand: 'open-settings',
        },
      }),
    ).toBe('open-settings');
  });

  it('ignores unrelated system execution metadata', () => {
    expect(
      getSystemExecutionAction({
        status: 'success',
        actionType: 'run-system',
        commandId: 'system.reload-launcher',
        metadata: {
          systemCommand: 'reload-launcher',
        },
      }),
    ).toBeUndefined();
  });
});

describe('launcher screenshot capture action', () => {
  it('executes the screenshot capture command and hides the launcher', async () => {
    const executeCommand = vi.fn(async () => ({
      status: 'success' as const,
      actionType: 'run-system' as const,
      commandId: 'system.screenshot.capture',
      metadata: {},
    }));
    const hideLauncher = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    const startScreenshotCapture = createStartScreenshotCapture(
      {
        executeCommand,
        hideLauncher,
      },
      dispatch,
    );

    await startScreenshotCapture();

    expect(executeCommand).toHaveBeenCalledWith('system.screenshot.capture');
    expect(hideLauncher).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'execution-started',
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'execution-succeeded',
    });
  });

  it('reports execution failure when screenshot capture fails', async () => {
    const executeCommand = vi.fn(async () => ({
      status: 'failure' as const,
      actionType: 'run-system' as const,
      commandId: 'system.screenshot.capture',
      error: {
        code: 'handler-error' as const,
        message: 'Capture failed.',
      },
    }));
    const hideLauncher = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    const startScreenshotCapture = createStartScreenshotCapture(
      {
        executeCommand,
        hideLauncher,
      },
      dispatch,
    );

    await startScreenshotCapture();

    expect(hideLauncher).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      errorMessage: 'Capture failed.',
      type: 'execution-failed',
    });
  });
});
