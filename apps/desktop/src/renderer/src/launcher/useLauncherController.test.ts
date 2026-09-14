import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../../../preload/index.js';
import {
  HOME_APP_GRID_LIMIT,
  getExecutableSelectedResult,
  getLauncherKeyIntent,
  createLauncherSearchRequestKey,
  createStartScreenshotCapture,
  getLauncherSearchRequestId,
  getPluginPageLaunchRequest,
  getSystemExecutionAction,
  isHorizontalLauncherNavigation,
  openPluginPageFromExecutionResult,
  launcherReducer,
  useLauncherController,
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
  it('reuses the current request id after search completion', () => {
    expect(getLauncherSearchRequestId(baseState)).toBe(1);
    expect(
      getLauncherSearchRequestId({
        ...baseState,
        requestId: 4,
        status: 'ready',
      }),
    ).toBe(4);
  });

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

  it('ignores repeated input events when the query value has not changed', () => {
    const ready: LauncherState = {
      ...baseState,
      query: 'settings',
      requestId: 1,
      results: [createResult('settings')],
      selectedIndex: 0,
      status: 'ready',
    };

    expect(
      launcherReducer(ready, {
        query: 'settings',
        type: 'query-changed',
      }),
    ).toBe(ready);
  });

  it('can refresh the current query without treating it as user input', () => {
    const ready: LauncherState = {
      ...baseState,
      query: 'settings',
      requestId: 1,
      results: [createResult('settings')],
      selectedIndex: 0,
      status: 'ready',
    };

    expect(
      launcherReducer(ready, {
        type: 'search-refresh-requested',
      }),
    ).toMatchObject({
      query: 'settings',
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

  it('does not update state when the pointer selects the already-selected result', () => {
    const ready: LauncherState = {
      ...baseState,
      requestId: 1,
      results: [createResult('alpha'), createResult('bravo')],
      selectedIndex: 0,
      status: 'ready',
    };

    expect(
      launcherReducer(ready, {
        index: 0,
        type: 'select-index',
      }),
    ).toBe(ready);
  });

  it('keeps blank-query app grid results within the two-row home limit', () => {
    const loading = launcherReducer(baseState, {
      requestId: 1,
      type: 'search-started',
    });
    const ready = launcherReducer(loading, {
      requestId: 1,
      results: Array.from({ length: HOME_APP_GRID_LIMIT + 1 }, (_, index) =>
        createAppResult(`app.${index + 1}`),
      ),
      type: 'search-succeeded',
    });

    expect(ready.results).toHaveLength(HOME_APP_GRID_LIMIT);
    expect(ready.results.at(-1)?.id).toBe(`app.${HOME_APP_GRID_LIMIT}`);
    expect(ready.selectedIndex).toBe(0);
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

// --- Minimal DOM shim so the debounced search effect can be mounted in the
// node-only Vitest environment (react-dom/client requires a DOM host). ---

interface FakeNodeLike {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  ownerDocument: FakeDocumentLike | null;
  parentNode: FakeNodeLike | null;
  childNodes: FakeNodeLike[];
  firstChild: FakeNodeLike | null;
  lastChild: FakeNodeLike | null;
  nextSibling: FakeNodeLike | null;
  previousSibling: FakeNodeLike | null;
  textContent: string;
  appendChild(child: FakeNodeLike): FakeNodeLike;
  insertBefore(child: FakeNodeLike, ref: FakeNodeLike | null): FakeNodeLike;
  removeChild(child: FakeNodeLike): FakeNodeLike;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
  getRootNode(): FakeNodeLike;
  contains(): boolean;
}

interface FakeElementLike extends FakeNodeLike {
  tagName: string;
  style: Record<string, unknown>;
  attributes: Record<string, string>;
  setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  focus(): void;
  blur(): void;
  click(): void;
}

interface FakeDocumentLike extends FakeNodeLike {
  documentElement: FakeElementLike;
  body: FakeElementLike;
  head: FakeElementLike;
  activeElement: FakeElementLike | null;
  createElement(tag: string): FakeElementLike;
  createTextNode(text: string): FakeNodeLike;
  createComment(text: string): FakeNodeLike;
}

interface FakeDom {
  document: FakeDocumentLike;
  window: Record<string, unknown>;
}

let installedFakeDom: FakeDom | undefined;

function installFakeDom(): FakeDom {
  if (installedFakeDom !== undefined) {
    return installedFakeDom;
  }

  const g = globalThis as Record<string, unknown>;

  function detachChild(node: FakeNodeLike): void {
    if (node.parentNode !== null) {
      node.parentNode.removeChild(node);
    }
  }

  class FakeNode implements FakeNodeLike {
    nodeType = 0;
    nodeName = '';
    nodeValue: string | null = null;
    ownerDocument: FakeDocumentLike | null = null;
    parentNode: FakeNodeLike | null = null;
    childNodes: FakeNodeLike[] = [];
    firstChild: FakeNodeLike | null = null;
    lastChild: FakeNodeLike | null = null;
    nextSibling: FakeNodeLike | null = null;
    previousSibling: FakeNodeLike | null = null;
    textContent = '';

    appendChild(child: FakeNodeLike): FakeNodeLike {
      detachChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      if (this.firstChild === null) {
        this.firstChild = child;
      }
      if (this.lastChild !== null) {
        this.lastChild.nextSibling = child;
        child.previousSibling = this.lastChild;
      }
      this.lastChild = child;
      return child;
    }

    insertBefore(child: FakeNodeLike, ref: FakeNodeLike | null): FakeNodeLike {
      detachChild(child);
      child.parentNode = this;
      if (ref === null) {
        return this.appendChild(child);
      }
      const index = this.childNodes.indexOf(ref);
      if (index < 0) {
        return this.appendChild(child);
      }
      this.childNodes.splice(index, 0, child);
      child.nextSibling = ref;
      child.previousSibling = ref.previousSibling;
      if (ref.previousSibling !== null) {
        ref.previousSibling.nextSibling = child;
      }
      ref.previousSibling = child;
      if (this.firstChild === ref) {
        this.firstChild = child;
      }
      return child;
    }

    removeChild(child: FakeNodeLike): FakeNodeLike {
      const index = this.childNodes.indexOf(child);
      if (index < 0) {
        return child;
      }
      this.childNodes.splice(index, 1);
      if (child.previousSibling !== null) {
        child.previousSibling.nextSibling = child.nextSibling;
      }
      if (child.nextSibling !== null) {
        child.nextSibling.previousSibling = child.previousSibling;
      }
      if (this.firstChild === child) {
        this.firstChild = child.nextSibling;
      }
      if (this.lastChild === child) {
        this.lastChild = child.previousSibling;
      }
      child.parentNode = null;
      child.previousSibling = null;
      child.nextSibling = null;
      return child;
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return false;
    }
    getRootNode(): FakeNodeLike {
      return this.ownerDocument ?? this;
    }
    contains(): boolean {
      return true;
    }
  }

  class FakeTextNode extends FakeNode {
    nodeType = 3;
    nodeName = '#text';
    nodeValue: string;
    textContent: string;

    constructor(text: string) {
      super();
      this.nodeValue = text;
      this.textContent = text;
    }
  }

  class FakeCommentNode extends FakeNode {
    nodeType = 8;
    nodeName = '#comment';
    nodeValue: string;
    textContent: string;

    constructor(text: string) {
      super();
      this.nodeValue = text;
      this.textContent = text;
    }
  }

  class FakeElement extends FakeNode implements FakeElementLike {
    nodeType = 1;
    nodeName: string;
    tagName: string;
    style: Record<string, unknown> = {};
    attributes: Record<string, string> = {};

    constructor(tag: string) {
      super();
      this.nodeName = tag.toUpperCase();
      this.tagName = this.nodeName;
    }

    setAttribute(name: string, value: unknown): void {
      this.attributes[name] = String(value);
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    removeAttribute(name: string): void {
      delete this.attributes[name];
    }

    hasAttribute(name: string): boolean {
      return name in this.attributes;
    }

    focus(): void {}
    blur(): void {}
    click(): void {}
  }

  const documentElement = new FakeElement('html');
  const fakeDocument = new FakeNode() as FakeDocumentLike;
  fakeDocument.nodeType = 9;
  fakeDocument.nodeName = '#document';
  fakeDocument.documentElement = documentElement;
  fakeDocument.body = new FakeElement('body');
  fakeDocument.head = new FakeElement('head');
  fakeDocument.activeElement = null;
  fakeDocument.createElement = (tag: string) => {
    const element = new FakeElement(tag);
    element.ownerDocument = fakeDocument;
    return element;
  };
  fakeDocument.createTextNode = (text: string) => {
    const node = new FakeTextNode(text);
    node.ownerDocument = fakeDocument;
    return node;
  };
  fakeDocument.createComment = (text: string) => {
    const node = new FakeCommentNode(text);
    node.ownerDocument = fakeDocument;
    return node;
  };
  documentElement.ownerDocument = fakeDocument;
  fakeDocument.body.ownerDocument = fakeDocument;
  fakeDocument.head.ownerDocument = fakeDocument;

  class FakeHTMLElement {}
  class FakeSVGElement {}
  class FakeHTMLIFrameElement {}

  const fakeWindow = {
    addEventListener(): void {},
    removeEventListener(): void {},
    dispatchEvent(): boolean {
      return false;
    },
    document: fakeDocument,
    HTMLIFrameElement: FakeHTMLIFrameElement,
    navigator: {
      userAgent: 'node',
      platform: 'linux',
    },
    devicePixelRatio: 1,
    innerWidth: 1024,
    innerHeight: 768,
  };

  const htmlElementNames = [
    'HTMLAnchorElement',
    'HTMLButtonElement',
    'HTMLCanvasElement',
    'HTMLDivElement',
    'HTMLFormElement',
    'HTMLHeadingElement',
    'HTMLIFrameElement',
    'HTMLImageElement',
    'HTMLLIElement',
    'HTMLLabelElement',
    'HTMLOptionElement',
    'HTMLParagraphElement',
    'HTMLSelectElement',
    'HTMLSpanElement',
    'HTMLTextAreaElement',
    'HTMLUListElement',
    'HTMLUnknownElement',
    'HTMLInputElement',
    'HTMLVideoElement',
    'HTMLAudioElement',
  ];

  g.window = fakeWindow;
  g.document = fakeDocument;
  g.HTMLElement = FakeHTMLElement;
  g.SVGElement = FakeSVGElement;
  for (const name of htmlElementNames) {
    g[name] = name === 'HTMLIFrameElement' ? FakeHTMLIFrameElement : FakeHTMLElement;
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  installedFakeDom = {
    document: fakeDocument,
    window: fakeWindow,
  };
  return installedFakeDom;
}

function createSearchCommandsMock() {
  return vi.fn(async (query: string): Promise<LauncherResultItem[]> => {
    return query.trim().length === 0 ? [] : [createResult(`result.${query}`)];
  });
}

function createLauncherDesktopApiMock(
  searchCommands: ReturnType<typeof createSearchCommandsMock>,
): DesktopApi {
  const desktopApi = {
    addFavorite: async () => undefined,
    addPinnedApp: async () => undefined,
    addPinnedAppCandidate: async () => undefined,
    checkForUpdates: async () => undefined,
    clearClipboardHistory: async () => 0,
    executeCommand: async () => undefined,
    getAppInfo: () => ({
      name: 'CommandCabin',
      version: '0.0.0',
      versions: {
        chrome: 'Chromium',
        electron: 'Electron',
        node: 'Node',
      },
    }),
    getDataDirectory: async () => ({ path: '' }),
    getSettings: async () => ({ preserveSearchQuery: false }),
    getUpdateStatus: async () => undefined,
    hideLauncher: async () => undefined,
    installPlugin: async () => undefined,
    installUpdate: async () => undefined,
    listAppCandidates: async () => [],
    listFavorites: async () => [],
    listPlugins: async () => [],
    onFocusSearchInput: () => () => undefined,
    onHotkeyInputCapture: () => () => undefined,
    onOpenSettings: () => () => undefined,
    onSearchResultIconsUpdated: () => () => undefined,
    onUpdateStatusChanged: () => () => undefined,
    openDataDirectory: async () => ({ path: '' }),
    openRepository: async () => false,
    pluginHost: {
      createEntry: async () => undefined,
      getBridgeInfo: () => ({ channel: '', methods: [] }),
      getPluginBridgePreloadPath: () => '',
      releaseEntry: async () => false,
    },
    removeFavorite: async () => false,
    removePlugin: async () => false,
    removeRecentApp: async () => false,
    searchCommands,
    setPluginEnabled: async () => undefined,
    startHotkeyInputCapture: async () => false,
    stopHotkeyInputCapture: async () => true,
    updatePinnedApp: async () => undefined,
    updateFavorite: async () => undefined,
    updateSettings: async () => undefined,
  };

  return desktopApi as unknown as DesktopApi;
}

describe('launcher search debounce', () => {
  let container: FakeElementLike;
  let root: Root;
  let searchCommands: ReturnType<typeof createSearchCommandsMock>;
  let harnessController: ReturnType<typeof useLauncherController> | undefined;

  function LauncherControllerHarness(): null {
    harnessController = useLauncherController();
    return null;
  }

  beforeEach(async () => {
    const dom = installFakeDom();
    searchCommands = createSearchCommandsMock();
    dom.window.desktopApi = createLauncherDesktopApiMock(searchCommands);
    const { createRoot } = await import('react-dom/client');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    container = dom.document.createElement('div');
    root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(createElement(LauncherControllerHarness));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enters the loading state immediately but does not search within 150ms of a query change', async () => {
    await act(async () => {
      harnessController!.setQuery('wps');
    });

    expect(harnessController!.state).toMatchObject({
      query: 'wps',
      status: 'loading',
    });
    expect(searchCommands).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(149);
    });
    expect(searchCommands).not.toHaveBeenCalled();
  });

  it('calls searchCommands once after the 150ms debounce window', async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(searchCommands).toHaveBeenCalledTimes(1);
    expect(searchCommands).toHaveBeenCalledWith('');
  });

  it('coalesces rapid query changes into a single search for the final query', async () => {
    await act(async () => {
      harnessController!.setQuery('a');
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      harnessController!.setQuery('ab');
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      harnessController!.setQuery('abc');
    });
    await act(async () => {
      vi.advanceTimersByTime(149);
    });
    expect(searchCommands).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(searchCommands).toHaveBeenCalledTimes(1);
    expect(searchCommands).toHaveBeenCalledWith('abc');
  });

  it('cancels the pending debounced search when the launcher unmounts', async () => {
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(searchCommands).not.toHaveBeenCalled();
  });

  it('still ignores stale search results after the debounce window', async () => {
    const pending: Array<{ query: string; resolve: (results: LauncherResultItem[]) => void }> = [];
    searchCommands.mockImplementation(
      (query: string) =>
        new Promise<LauncherResultItem[]>((resolve) => {
          pending.push({ query, resolve });
        }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(searchCommands).toHaveBeenCalledTimes(1);
    expect(searchCommands).toHaveBeenCalledWith('');

    await act(async () => {
      harnessController!.setQuery('alpha');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(searchCommands).toHaveBeenCalledTimes(2);
    expect(searchCommands).toHaveBeenCalledWith('alpha');

    await act(async () => {
      pending[0]!.resolve([createResult('stale.alpha')]);
    });
    expect(harnessController!.state).toMatchObject({
      query: 'alpha',
      results: [],
      status: 'loading',
    });

    await act(async () => {
      pending[1]!.resolve([createResult('alpha')]);
    });
    expect(harnessController!.state).toMatchObject({
      query: 'alpha',
      results: [{ id: 'alpha' }],
      status: 'ready',
    });
  });
});
