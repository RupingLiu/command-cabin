import { useEffect, useMemo, useRef } from 'react';

import {
  PLUGIN_BRIDGE_CHANNEL,
  createPluginHostBridge,
  type PluginHostBridge,
} from './pluginBridge.js';

export interface PluginHostEntry {
  allowedBaseUrl: string;
  entryUrl: string;
  launchToken: string;
  name: string;
  partition: string;
  pluginId: string;
}

export const PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE = 'data-plugin-allowed-base-url';
export const PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE = 'data-plugin-launch-token';

export interface PluginHostApi {
  getPluginBridgePreloadPath: () => string;
  releaseEntry: (launchToken: string) => Promise<boolean>;
}

export type PluginHostFailureReason =
  | 'bridge-error'
  | 'load-failed'
  | 'render-process-gone'
  | 'setup-failed';

export interface PluginHostFailure {
  message: string;
  reason: PluginHostFailureReason;
  url?: string;
}

export interface PluginHostProps {
  api?: PluginHostApi;
  bridgePreloadPath?: string;
  onBlockedNavigation?: (url: string) => void;
  onClose: () => void;
  onFallbackToLauncher: (failure: PluginHostFailure) => void;
  plugin: PluginHostEntry;
}

export interface PluginNavigationPolicy {
  allowedBaseUrl: URL;
  entryUrl: URL;
}

export interface PluginWebviewAttributes {
  'data-plugin-id': string;
  [PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE]: string;
  [PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE]: string;
  partition: string;
  preload?: string;
  src: string;
  webpreferences: string;
}

export type PluginHostSetupResult =
  | {
      ok: true;
      navigationPolicy: PluginNavigationPolicy;
      webviewAttributes: PluginWebviewAttributes;
    }
  | {
      ok: false;
      failure: PluginHostFailure;
    };

export interface PluginHostEventTarget {
  addEventListener: (eventName: string, listener: EventListener) => void;
  removeEventListener: (eventName: string, listener: EventListener) => void;
}

export interface PluginHostEventGuardOptions {
  bridge: Pick<PluginHostBridge, 'dispatch'>;
  navigationPolicy: PluginNavigationPolicy;
  onBlockedNavigation: (url: string) => void;
  onFailure: (failure: PluginHostFailure) => void;
}

export interface PluginHostEventGuardController {
  dispose: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function readPreventDefault(value: unknown): (() => void) | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const preventDefault = value.preventDefault;
  return typeof preventDefault === 'function' ? () => preventDefault.call(value) : undefined;
}

function readIpcMessageArgs(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.args)) {
    return [];
  }

  return value.args;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return 'Plugin bridge request failed.';
}

function getDefaultPluginHostApi(): PluginHostApi | undefined {
  if (typeof window === 'undefined' || !('desktopApi' in window)) {
    return undefined;
  }

  return window.desktopApi.pluginHost;
}

export function createPluginNavigationPolicy(plugin: PluginHostEntry): PluginNavigationPolicy {
  const entryUrl = new URL(plugin.entryUrl);
  const allowedBaseUrl = new URL(plugin.allowedBaseUrl);

  if (entryUrl.protocol !== 'file:' || allowedBaseUrl.protocol !== 'file:') {
    throw new Error('Plugin host entries must use file URLs.');
  }

  if (!allowedBaseUrl.pathname.endsWith('/')) {
    throw new Error('Plugin host allowed base URL must end with a slash.');
  }

  if (!entryUrl.pathname.startsWith(allowedBaseUrl.pathname)) {
    throw new Error('Plugin entry URL must stay inside the allowed plugin base URL.');
  }

  return {
    allowedBaseUrl,
    entryUrl,
  };
}

export function isPluginNavigationAllowed(
  policy: PluginNavigationPolicy,
  requestedUrl: string,
): boolean {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(requestedUrl);
  } catch {
    return false;
  }

  if (parsedUrl.protocol !== 'file:') {
    return false;
  }

  return parsedUrl.pathname.startsWith(policy.allowedBaseUrl.pathname);
}

export function getPluginWebviewAttributes(
  plugin: PluginHostEntry,
  bridgePreloadPath?: string,
): PluginWebviewAttributes {
  createPluginNavigationPolicy(plugin);

  const baseAttributes = {
    'data-plugin-id': plugin.pluginId,
    [PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE]: plugin.allowedBaseUrl,
    [PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE]: plugin.launchToken,
    partition: plugin.partition,
    src: plugin.entryUrl,
    webpreferences: 'contextIsolation=yes, nodeIntegration=no, sandbox=yes',
  };

  if (bridgePreloadPath === undefined) {
    return baseAttributes;
  }

  return {
    ...baseAttributes,
    preload: bridgePreloadPath,
  };
}

export function createPluginHostSetup(
  plugin: PluginHostEntry,
  bridgePreloadPath?: string,
): PluginHostSetupResult {
  try {
    return {
      ok: true,
      navigationPolicy: createPluginNavigationPolicy(plugin),
      webviewAttributes: getPluginWebviewAttributes(plugin, bridgePreloadPath),
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        message: formatUnknownError(error),
        reason: 'setup-failed',
      },
    };
  }
}

export function attachPluginHostEventGuards(
  eventTarget: PluginHostEventTarget,
  options: PluginHostEventGuardOptions,
): PluginHostEventGuardController {
  const removeListeners: (() => void)[] = [];
  const addGuardedListener = (eventName: string, listener: EventListener) => {
    eventTarget.addEventListener(eventName, listener);
    removeListeners.push(() => eventTarget.removeEventListener(eventName, listener));
  };

  const handleNavigation: EventListener = (event) => {
    const requestedUrl = readStringField(event, 'url');

    if (requestedUrl && isPluginNavigationAllowed(options.navigationPolicy, requestedUrl)) {
      return;
    }

    readPreventDefault(event)?.();
    options.onBlockedNavigation(requestedUrl ?? 'unknown');
  };

  const handleIpcMessage: EventListener = (event) => {
    if (readStringField(event, 'channel') !== PLUGIN_BRIDGE_CHANNEL) {
      return;
    }

    try {
      options.bridge.dispatch(readIpcMessageArgs(event)[0]);
    } catch (error) {
      options.onFailure({
        message: formatUnknownError(error),
        reason: 'bridge-error',
      });
    }
  };

  const handleDidFailLoad: EventListener = (event) => {
    const description = readStringField(event, 'errorDescription') ?? 'unknown load error';
    const validatedURL = readStringField(event, 'validatedURL');
    const failure: PluginHostFailure = {
      message: `Plugin page failed to load: ${description}`,
      reason: 'load-failed',
    };

    if (validatedURL !== undefined) {
      failure.url = validatedURL;
    }

    options.onFailure(failure);
  };

  const handleRenderProcessGone: EventListener = (event) => {
    const reason = readStringField(event, 'reason') ?? 'unknown reason';

    options.onFailure({
      message: `Plugin page stopped unexpectedly: ${reason}`,
      reason: 'render-process-gone',
    });
  };

  addGuardedListener('will-navigate', handleNavigation);
  addGuardedListener('will-frame-navigate', handleNavigation);
  addGuardedListener('new-window', handleNavigation);
  addGuardedListener('ipc-message', handleIpcMessage);
  addGuardedListener('did-fail-load', handleDidFailLoad);
  addGuardedListener('render-process-gone', handleRenderProcessGone);

  return {
    dispose: () => {
      for (const removeListener of removeListeners) {
        removeListener();
      }
    },
  };
}

export function createPluginHostFailureHandler({
  onClose,
  onFallbackToLauncher,
}: Pick<PluginHostProps, 'onClose' | 'onFallbackToLauncher'>): (
  failure: PluginHostFailure,
) => void {
  let handled = false;

  return (failure) => {
    if (handled) {
      return;
    }

    handled = true;
    onFallbackToLauncher(failure);
    onClose();
  };
}

export function PluginHost({
  api,
  bridgePreloadPath,
  onBlockedNavigation = () => undefined,
  onClose,
  onFallbackToLauncher,
  plugin,
}: PluginHostProps) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const pluginHostApi = api ?? getDefaultPluginHostApi();
  const resolvedBridgePreloadPath =
    bridgePreloadPath ?? pluginHostApi?.getPluginBridgePreloadPath();
  const handleFailure = useMemo(
    () =>
      createPluginHostFailureHandler({
        onClose,
        onFallbackToLauncher,
      }),
    [onClose, onFallbackToLauncher],
  );
  const bridge = useMemo(
    () =>
      createPluginHostBridge({
        onClose,
        onError: ({ message }) =>
          handleFailure({
            message,
            reason: 'bridge-error',
          }),
      }),
    [handleFailure, onClose],
  );
  const setup = useMemo(
    () => createPluginHostSetup(plugin, resolvedBridgePreloadPath),
    [plugin, resolvedBridgePreloadPath],
  );

  useEffect(() => {
    if (!setup.ok) {
      handleFailure(setup.failure);
      return undefined;
    }

    if (!webviewRef.current) {
      return undefined;
    }

    const controller = attachPluginHostEventGuards(webviewRef.current, {
      bridge,
      navigationPolicy: setup.navigationPolicy,
      onBlockedNavigation,
      onFailure: handleFailure,
    });

    return () => controller.dispose();
  }, [bridge, handleFailure, onBlockedNavigation, setup]);

  useEffect(() => {
    return () => {
      void pluginHostApi?.releaseEntry(plugin.launchToken);
    };
  }, [plugin.launchToken, pluginHostApi]);

  if (!setup.ok) {
    return (
      <main className="plugin-host-shell">
        <section className="plugin-host-frame" aria-label={`${plugin.name} plugin page`}>
          <header className="plugin-host-titlebar">
            <div className="plugin-host-title">
              <p className="launcher-kicker">Plugin</p>
              <h1>{plugin.name}</h1>
            </div>
            <button className="plugin-host-close" type="button" onClick={onClose}>
              Close
            </button>
          </header>

          <div className="plugin-host-fallback" role="alert">
            <p>Plugin unavailable</p>
            <span>{setup.failure.message}</span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="plugin-host-shell">
      <section className="plugin-host-frame" aria-label={`${plugin.name} plugin page`}>
        <header className="plugin-host-titlebar">
          <div className="plugin-host-title">
            <p className="launcher-kicker">Plugin</p>
            <h1>{plugin.name}</h1>
          </div>
          <button className="plugin-host-close" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <webview
          ref={webviewRef}
          className="plugin-host-webview"
          {...setup.webviewAttributes}
        ></webview>
      </section>
    </main>
  );
}
