export const PLUGIN_BRIDGE_CHANNEL = 'command-cabin:plugin-bridge';
export const PLUGIN_BRIDGE_VERSION = 1;
export const PLUGIN_BRIDGE_METHODS = Object.freeze(['close', 'reportError'] as const);

export type PluginBridgeMethod = (typeof PLUGIN_BRIDGE_METHODS)[number];
export type PluginBridgeCloseReason = 'user' | 'plugin';

export interface PluginBridgeCloseParams {
  reason?: PluginBridgeCloseReason;
}

export interface PluginBridgeReportErrorParams {
  message: string;
}

export type PluginBridgeRequest =
  | {
      method: 'close';
      params: PluginBridgeCloseParams;
      version: typeof PLUGIN_BRIDGE_VERSION;
    }
  | {
      method: 'reportError';
      params: PluginBridgeReportErrorParams;
      version: typeof PLUGIN_BRIDGE_VERSION;
    };

export interface PluginPageBridgeTransport {
  sendToHost: (channel: string, request: PluginBridgeRequest) => void;
}

export interface CommandCabinPluginPageBridge {
  readonly capabilities: readonly PluginBridgeMethod[];
  close: (params?: PluginBridgeCloseParams) => void;
  reportError: (params: PluginBridgeReportErrorParams) => void;
}

export interface PluginHostBridgeHandlers {
  onClose: (params: PluginBridgeCloseParams) => void;
  onError: (params: PluginBridgeReportErrorParams) => void;
}

export interface PluginHostBridge {
  dispatch: (request: unknown) => PluginBridgeRequest;
}

export interface ContextBridgeLike {
  exposeInMainWorld: (apiKey: string, api: unknown) => void;
}

export interface IpcRendererLike {
  sendToHost: (channel: string, request: PluginBridgeRequest) => void;
}

const pluginBridgeMethods = new Set<string>(PLUGIN_BRIDGE_METHODS);
const pluginBridgeCloseReasons = new Set<string>(['user', 'plugin']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseParamsRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error('Bridge params must be a plain object.');
  }

  return value;
}

function parseCloseParams(value: unknown): PluginBridgeCloseParams {
  const params = parseParamsRecord(value);
  const reason = params.reason;

  if (reason === undefined) {
    return {};
  }

  if (typeof reason !== 'string' || !pluginBridgeCloseReasons.has(reason)) {
    throw new Error('Bridge close reason must be "user" or "plugin".');
  }

  return {
    reason: reason as PluginBridgeCloseReason,
  };
}

function parseReportErrorParams(value: unknown): PluginBridgeReportErrorParams {
  const params = parseParamsRecord(value);
  const message = params.message;

  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Bridge error message must be a non-empty string.');
  }

  return {
    message: message.trim(),
  };
}

export function parsePluginBridgeRequest(value: unknown): PluginBridgeRequest {
  if (!isRecord(value)) {
    throw new Error('Plugin bridge request must be a plain object.');
  }

  if (value.version !== PLUGIN_BRIDGE_VERSION) {
    throw new Error(`Plugin bridge request version must be ${PLUGIN_BRIDGE_VERSION}.`);
  }

  if (typeof value.method !== 'string' || !pluginBridgeMethods.has(value.method)) {
    throw new Error('Unsupported plugin bridge method.');
  }

  if (value.method === 'close') {
    return {
      method: value.method,
      params: parseCloseParams(value.params),
      version: PLUGIN_BRIDGE_VERSION,
    };
  }

  return {
    method: 'reportError',
    params: parseReportErrorParams(value.params),
    version: PLUGIN_BRIDGE_VERSION,
  };
}

export function createPluginHostBridge(handlers: PluginHostBridgeHandlers): PluginHostBridge {
  return {
    dispatch: (request) => {
      const parsedRequest = parsePluginBridgeRequest(request);

      if (parsedRequest.method === 'close') {
        handlers.onClose(parsedRequest.params);
        return parsedRequest;
      }

      handlers.onError(parsedRequest.params);
      return parsedRequest;
    },
  };
}

export function createPluginPageBridge(
  transport: PluginPageBridgeTransport,
): CommandCabinPluginPageBridge {
  const sendRequest = (request: PluginBridgeRequest) => {
    transport.sendToHost(PLUGIN_BRIDGE_CHANNEL, parsePluginBridgeRequest(request));
  };

  return Object.freeze({
    capabilities: PLUGIN_BRIDGE_METHODS,
    close: (params: PluginBridgeCloseParams = {}) => {
      sendRequest({
        method: 'close',
        params: parseCloseParams(params),
        version: PLUGIN_BRIDGE_VERSION,
      });
    },
    reportError: (params: PluginBridgeReportErrorParams) => {
      sendRequest({
        method: 'reportError',
        params: parseReportErrorParams(params),
        version: PLUGIN_BRIDGE_VERSION,
      });
    },
  });
}

export function installPluginBridge(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
): void {
  contextBridge.exposeInMainWorld(
    'commandCabinPlugin',
    createPluginPageBridge({
      sendToHost: (channel, request) => {
        ipcRenderer.sendToHost(channel, request);
      },
    }),
  );
}
