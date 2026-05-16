import { describe, expect, it, vi } from 'vitest';

import { PLUGIN_BRIDGE_CHANNEL } from './pluginBridge.js';
import {
  attachPluginHostEventGuards,
  createPluginHostFailureHandler,
  createPluginHostSetup,
  createPluginNavigationPolicy,
  getPluginWebviewAttributes,
  isPluginNavigationAllowed,
  type PluginHostEntry,
  type PluginHostEventTarget,
} from './PluginHost.js';

class MockPluginEventTarget implements PluginHostEventTarget {
  readonly addEventListener = vi.fn((eventName: string, listener: EventListener) => {
    const listeners = this.listeners.get(eventName) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  });

  readonly removeEventListener = vi.fn((eventName: string, listener: EventListener) => {
    this.listeners.get(eventName)?.delete(listener);
  });

  private readonly listeners = new Map<string, Set<EventListener>>();

  emit(eventName: string, event: object): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event as Event);
    }
  }
}

function createPluginEntry(overrides: Partial<PluginHostEntry> = {}): PluginHostEntry {
  return {
    allowedBaseUrl: 'file:///C:/CommandCabin/plugins/text-tools/',
    entryUrl: 'file:///C:/CommandCabin/plugins/text-tools/ui/index.html',
    launchToken: 'launch-1',
    name: 'Text Tools',
    partition: 'command-cabin-plugin:com-example-text-tools:launch-1',
    pluginId: 'com.example.text-tools',
    ...overrides,
  };
}

describe('plugin host navigation policy', () => {
  it('allows only file navigation inside the plugin root', () => {
    const policy = createPluginNavigationPolicy(createPluginEntry());

    expect(
      isPluginNavigationAllowed(
        policy,
        'file:///C:/CommandCabin/plugins/text-tools/ui/settings.html',
      ),
    ).toBe(true);
    expect(
      isPluginNavigationAllowed(
        policy,
        'file:///C:/CommandCabin/plugins/text-tools/ui/index.html#section',
      ),
    ).toBe(true);
    expect(isPluginNavigationAllowed(policy, 'https://example.com/plugin')).toBe(false);
    expect(
      isPluginNavigationAllowed(policy, 'file:///C:/CommandCabin/plugins/other/ui/index.html'),
    ).toBe(false);
    expect(isPluginNavigationAllowed(policy, 'javascript:alert(1)')).toBe(false);
  });

  it('creates explicit secure webview attributes for tests and renderer use', () => {
    expect(
      getPluginWebviewAttributes(createPluginEntry(), 'C:\\CommandCabin\\out\\pluginBridge.cjs'),
    ).toEqual({
      'data-plugin-allowed-base-url': 'file:///C:/CommandCabin/plugins/text-tools/',
      'data-plugin-launch-token': 'launch-1',
      'data-plugin-id': 'com.example.text-tools',
      partition: 'command-cabin-plugin:com-example-text-tools:launch-1',
      preload: 'C:\\CommandCabin\\out\\pluginBridge.cjs',
      src: 'file:///C:/CommandCabin/plugins/text-tools/ui/index.html',
      webpreferences: 'contextIsolation=yes, nodeIntegration=no, sandbox=yes',
    });
  });

  it('rejects an initial plugin URL outside the allowed base before assigning webview src', () => {
    expect(() =>
      getPluginWebviewAttributes(
        createPluginEntry({
          entryUrl: 'file:///C:/CommandCabin/plugins/other/ui/index.html',
        }),
        'C:\\CommandCabin\\out\\pluginBridge.cjs',
      ),
    ).toThrow('Plugin entry URL must stay inside the allowed plugin base URL.');
  });
});

describe('plugin host setup fallback', () => {
  it('returns a safe failure instead of throwing for invalid plugin URL setup', () => {
    expect(
      createPluginHostSetup(
        createPluginEntry({
          entryUrl: 'https://example.com/plugin',
        }),
        'C:\\CommandCabin\\out\\pluginBridge.cjs',
      ),
    ).toEqual({
      ok: false,
      failure: {
        message: 'Plugin host entries must use file URLs.',
        reason: 'setup-failed',
      },
    });
  });
});

describe('plugin host event guards', () => {
  it('prevents disallowed navigation and leaves allowed navigation alone', () => {
    const eventTarget = new MockPluginEventTarget();
    const onBlockedNavigation = vi.fn();
    const onFailure = vi.fn();
    const controller = attachPluginHostEventGuards(eventTarget, {
      bridge: {
        dispatch: vi.fn(),
      },
      navigationPolicy: createPluginNavigationPolicy(createPluginEntry()),
      onBlockedNavigation,
      onFailure,
    });
    const allowedPreventDefault = vi.fn();
    const blockedPreventDefault = vi.fn();

    eventTarget.emit('will-navigate', {
      preventDefault: allowedPreventDefault,
      url: 'file:///C:/CommandCabin/plugins/text-tools/ui/settings.html',
    });
    eventTarget.emit('will-navigate', {
      preventDefault: blockedPreventDefault,
      url: 'https://example.com/plugin',
    });

    expect(allowedPreventDefault).not.toHaveBeenCalled();
    expect(blockedPreventDefault).toHaveBeenCalledOnce();
    expect(onBlockedNavigation).toHaveBeenCalledWith('https://example.com/plugin');

    controller.dispose();
  });

  it('routes whitelisted bridge messages and removes every listener during cleanup', () => {
    const eventTarget = new MockPluginEventTarget();
    const dispatch = vi.fn();
    const controller = attachPluginHostEventGuards(eventTarget, {
      bridge: {
        dispatch,
      },
      navigationPolicy: createPluginNavigationPolicy(createPluginEntry()),
      onBlockedNavigation: vi.fn(),
      onFailure: vi.fn(),
    });

    eventTarget.emit('ipc-message', {
      args: [
        {
          method: 'close',
          params: {
            reason: 'plugin',
          },
          version: 1,
        },
      ],
      channel: PLUGIN_BRIDGE_CHANNEL,
    });

    expect(dispatch).toHaveBeenCalledWith({
      method: 'close',
      params: {
        reason: 'plugin',
      },
      version: 1,
    });

    controller.dispose();

    expect(eventTarget.removeEventListener).toHaveBeenCalledTimes(
      eventTarget.addEventListener.mock.calls.length,
    );

    eventTarget.emit('ipc-message', {
      args: [
        {
          method: 'close',
          params: {
            reason: 'plugin',
          },
          version: 1,
        },
      ],
      channel: PLUGIN_BRIDGE_CHANNEL,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('reports plugin page failures so the shell can fall back to the launcher', () => {
    const eventTarget = new MockPluginEventTarget();
    const onFailure = vi.fn();

    attachPluginHostEventGuards(eventTarget, {
      bridge: {
        dispatch: vi.fn(),
      },
      navigationPolicy: createPluginNavigationPolicy(createPluginEntry()),
      onBlockedNavigation: vi.fn(),
      onFailure,
    });

    eventTarget.emit('did-fail-load', {
      errorDescription: 'ERR_FILE_NOT_FOUND',
      validatedURL: 'file:///C:/CommandCabin/plugins/text-tools/ui/index.html',
    });

    expect(onFailure).toHaveBeenCalledWith({
      message: 'Plugin page failed to load: ERR_FILE_NOT_FOUND',
      reason: 'load-failed',
      url: 'file:///C:/CommandCabin/plugins/text-tools/ui/index.html',
    });
  });
});

describe('plugin host fallback behavior', () => {
  it('falls back to the launcher once when a plugin page fails', () => {
    const onClose = vi.fn();
    const onFallbackToLauncher = vi.fn();
    const handleFailure = createPluginHostFailureHandler({
      onClose,
      onFallbackToLauncher,
    });
    const failure = {
      message: 'Plugin page crashed.',
      reason: 'render-process-gone' as const,
    };

    handleFailure(failure);
    handleFailure(failure);

    expect(onFallbackToLauncher).toHaveBeenCalledOnce();
    expect(onFallbackToLauncher).toHaveBeenCalledWith(failure);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
