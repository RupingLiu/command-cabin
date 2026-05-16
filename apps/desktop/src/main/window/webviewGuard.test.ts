import { describe, expect, it, vi } from 'vitest';

import {
  PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE,
  PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE,
  attachPluginWebviewGuard,
  createPluginWebviewPolicyStore,
  getPluginBridgePreloadPath,
  guardPluginWebviewAttachment,
} from './webviewGuard.js';

class MockHostWebContents {
  readonly on = vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
    this.listeners.set(eventName, listener);
  });

  private readonly listeners = new Map<string, (...args: unknown[]) => void>();

  emit(eventName: string, ...args: unknown[]): void {
    this.listeners.get(eventName)?.(...args);
  }
}

class MockGuestSession {
  readonly on = vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
    this.listeners.set(eventName, listener);
  });
  readonly removeListener = vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
    if (this.listeners.get(eventName) === listener) {
      this.listeners.delete(eventName);
    }
  });

  private readonly listeners = new Map<string, (...args: unknown[]) => void>();

  emit(eventName: string, ...args: unknown[]): void {
    this.listeners.get(eventName)?.(...args);
  }
}

class MockGuestWebContents {
  readonly session = new MockGuestSession();
  readonly on = vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
    this.listeners.set(eventName, listener);
  });
  readonly setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => unknown) => {
    this.windowOpenHandler = handler;
  });

  private readonly listeners = new Map<string, (...args: unknown[]) => void>();
  private windowOpenHandler?: (details: { url: string }) => unknown;

  emit(eventName: string, ...args: unknown[]): void {
    this.listeners.get(eventName)?.(...args);
  }

  openWindow(url: string): unknown {
    return this.windowOpenHandler?.({ url });
  }
}

function createAttachEvent() {
  return {
    preventDefault: vi.fn(),
  };
}

const expectedPreloadPath = 'C:\\CommandCabin\\out\\preload\\pluginBridge.cjs';

function createPolicyStore() {
  return createPluginWebviewPolicyStore({
    expectedPreloadPath,
    generateLaunchToken: () => 'launch-1',
  });
}

function registerPluginPolicy() {
  const store = createPolicyStore();
  const entry = store.register({
    name: 'Text Tools',
    pluginId: 'com.example.text-tools',
    pluginRoot: 'C:\\CommandCabin\\plugins\\text-tools',
    uiPath: 'ui/index.html',
  });

  return {
    entry,
    store,
  };
}

function createAllowedParams(entry: ReturnType<ReturnType<typeof createPolicyStore>['register']>) {
  return {
    [PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE]: entry.allowedBaseUrl,
    [PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE]: entry.launchToken,
    'data-plugin-id': entry.pluginId,
    partition: entry.partition,
    preload: expectedPreloadPath,
    src: entry.entryUrl,
  };
}

describe('plugin webview attachment guard', () => {
  it('allows local plugin pages inside the declared base and enforces restrictive preferences', () => {
    const { entry, store } = registerPluginPolicy();
    const event = createAttachEvent();
    const webPreferences = {
      contextIsolation: true,
      nodeIntegration: false,
      partition: entry.partition,
      preload: expectedPreloadPath,
      sandbox: true,
    };

    const allowed = guardPluginWebviewAttachment(
      event,
      webPreferences,
      createAllowedParams(entry),
      {
        policyStore: store,
      },
    );

    expect(allowed).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'command-cabin-plugin:com-example-text-tools:launch-1',
      preload: expectedPreloadPath,
      sandbox: true,
    });
  });

  it('prevents webviews with remote src values', () => {
    const { entry, store } = registerPluginPolicy();
    const event = createAttachEvent();

    const allowed = guardPluginWebviewAttachment(
      event,
      {
        contextIsolation: true,
        nodeIntegration: false,
        partition: entry.partition,
        preload: expectedPreloadPath,
        sandbox: true,
      },
      {
        ...createAllowedParams(entry),
        src: 'https://example.com/plugin',
      },
      {
        policyStore: store,
      },
    );

    expect(allowed).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('prevents webviews with a src outside the declared plugin base', () => {
    const { entry, store } = registerPluginPolicy();
    const event = createAttachEvent();

    const allowed = guardPluginWebviewAttachment(
      event,
      {
        contextIsolation: true,
        nodeIntegration: false,
        partition: entry.partition,
        preload: expectedPreloadPath,
        sandbox: true,
      },
      {
        ...createAllowedParams(entry),
        src: 'file:///C:/CommandCabin/plugins/other/ui/index.html',
      },
      {
        policyStore: store,
      },
    );

    expect(allowed).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('prevents webviews with unexpected preload or dangerous preferences', () => {
    const first = registerPluginPolicy();
    const second = registerPluginPolicy();
    const unexpectedPreloadEvent = createAttachEvent();
    const dangerousPreferencesEvent = createAttachEvent();

    expect(
      guardPluginWebviewAttachment(
        unexpectedPreloadEvent,
        {
          contextIsolation: true,
          nodeIntegration: false,
          partition: first.entry.partition,
          preload: 'C:\\CommandCabin\\out\\preload\\other.cjs',
          sandbox: true,
        },
        {
          ...createAllowedParams(first.entry),
          preload: 'C:\\CommandCabin\\out\\preload\\other.cjs',
        },
        {
          policyStore: first.store,
        },
      ),
    ).toBe(false);
    expect(unexpectedPreloadEvent.preventDefault).toHaveBeenCalledOnce();

    expect(
      guardPluginWebviewAttachment(
        dangerousPreferencesEvent,
        {
          contextIsolation: false,
          nodeIntegration: true,
          partition: second.entry.partition,
          preload: expectedPreloadPath,
          sandbox: false,
        },
        createAllowedParams(second.entry),
        {
          policyStore: second.store,
        },
      ),
    ).toBe(false);
    expect(dangerousPreferencesEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('prevents missing, unknown, mismatched, or persistent partitions', () => {
    const { entry, store } = registerPluginPolicy();

    for (const partition of [undefined, 'command-cabin-plugin:unknown', 'persist:plugin']) {
      const event = createAttachEvent();
      const params = createAllowedParams(entry);
      if (partition === undefined) {
        delete params.partition;
      } else {
        params.partition = partition;
      }

      expect(
        guardPluginWebviewAttachment(
          event,
          {
            contextIsolation: true,
            nodeIntegration: false,
            partition,
            preload: expectedPreloadPath,
            sandbox: true,
          },
          params,
          {
            policyStore: store,
          },
        ),
      ).toBe(false);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('rejects renderer-spoofed plugin metadata even when the launch token is valid', () => {
    const { entry, store } = registerPluginPolicy();
    const event = createAttachEvent();

    expect(
      guardPluginWebviewAttachment(
        event,
        {
          contextIsolation: true,
          nodeIntegration: false,
          partition: entry.partition,
          preload: expectedPreloadPath,
          sandbox: true,
        },
        {
          ...createAllowedParams(entry),
          [PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE]: 'file:///C:/CommandCabin/plugins/other/',
          'data-plugin-id': 'com.example.other',
        },
        {
          policyStore: store,
        },
      ),
    ).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('enforces guest navigation, window-open, and download blocking after attach', () => {
    const { entry, store } = registerPluginPolicy();
    const host = new MockHostWebContents();
    const guest = new MockGuestWebContents();
    attachPluginWebviewGuard(host, {
      policyStore: store,
    });
    const attachEvent = createAttachEvent();

    host.emit(
      'will-attach-webview',
      attachEvent,
      {
        contextIsolation: true,
        nodeIntegration: false,
        partition: entry.partition,
        preload: expectedPreloadPath,
        sandbox: true,
      },
      createAllowedParams(entry),
    );
    host.emit('did-attach-webview', createAttachEvent(), guest);

    const navigateEvent = createAttachEvent();
    const frameNavigateEvent = createAttachEvent();
    const downloadEvent = createAttachEvent();

    guest.emit('will-navigate', navigateEvent, 'https://example.com/plugin');
    guest.emit(
      'will-frame-navigate',
      frameNavigateEvent,
      'file:///C:/CommandCabin/plugins/other/frame.html',
    );
    guest.session.emit('will-download', downloadEvent, {}, guest);

    expect(navigateEvent.preventDefault).toHaveBeenCalledOnce();
    expect(frameNavigateEvent.preventDefault).toHaveBeenCalledOnce();
    expect(guest.openWindow('file:///C:/CommandCabin/plugins/text-tools/popup.html')).toEqual({
      action: 'deny',
    });
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('attaches the guard to main window webContents', () => {
    const webContents = new MockHostWebContents();

    attachPluginWebviewGuard(webContents, {
      policyStore: createPolicyStore(),
    });

    expect(webContents.on).toHaveBeenCalledWith('will-attach-webview', expect.any(Function));
    expect(webContents.on).toHaveBeenCalledWith('did-attach-webview', expect.any(Function));
  });

  it('derives the plugin bridge preload path next to the main preload bundle', () => {
    expect(getPluginBridgePreloadPath('C:\\CommandCabin\\out\\preload\\index.cjs')).toBe(
      'C:\\CommandCabin\\out\\preload\\pluginBridge.cjs',
    );
  });
});
