import { describe, expect, it, vi } from 'vitest';

import {
  PLUGIN_BRIDGE_CHANNEL,
  PLUGIN_BRIDGE_METHODS,
  createPluginHostBridge,
  createPluginPageBridge,
  parsePluginBridgeRequest,
} from './pluginBridge.js';

describe('plugin bridge validation', () => {
  it('accepts only whitelisted bridge methods', () => {
    expect(
      parsePluginBridgeRequest({
        method: 'close',
        params: {
          reason: 'plugin',
        },
        version: 1,
      }),
    ).toEqual({
      method: 'close',
      params: {
        reason: 'plugin',
      },
      version: 1,
    });

    expect(
      parsePluginBridgeRequest({
        method: 'reportError',
        params: {
          message: 'Plugin UI crashed.',
        },
        version: 1,
      }),
    ).toEqual({
      method: 'reportError',
      params: {
        message: 'Plugin UI crashed.',
      },
      version: 1,
    });

    expect(() =>
      parsePluginBridgeRequest({
        method: 'openExternal',
        params: {
          url: 'https://example.com',
        },
        version: 1,
      }),
    ).toThrow('Unsupported plugin bridge method');
  });

  it('rejects malformed bridge params before dispatching to host handlers', () => {
    const onClose = vi.fn();
    const onError = vi.fn();
    const bridge = createPluginHostBridge({
      onClose,
      onError,
    });

    expect(() =>
      bridge.dispatch({
        method: 'reportError',
        params: {
          message: '',
        },
        version: 1,
      }),
    ).toThrow('Bridge error message must be a non-empty string.');
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('plugin page bridge', () => {
  it('exposes a small capability list and sends validated requests to the host', () => {
    const sendToHost = vi.fn();
    const bridge = createPluginPageBridge({
      sendToHost,
    });

    expect(bridge.capabilities).toEqual(PLUGIN_BRIDGE_METHODS);

    bridge.close({
      reason: 'user',
    });
    bridge.reportError({
      message: 'Render failed.',
    });

    expect(sendToHost).toHaveBeenNthCalledWith(1, PLUGIN_BRIDGE_CHANNEL, {
      method: 'close',
      params: {
        reason: 'user',
      },
      version: 1,
    });
    expect(sendToHost).toHaveBeenNthCalledWith(2, PLUGIN_BRIDGE_CHANNEL, {
      method: 'reportError',
      params: {
        message: 'Render failed.',
      },
      version: 1,
    });
  });

  it('validates page bridge calls before crossing into the host', () => {
    const sendToHost = vi.fn();
    const bridge = createPluginPageBridge({
      sendToHost,
    });

    expect(() =>
      bridge.reportError({
        message: '   ',
      }),
    ).toThrow('Bridge error message must be a non-empty string.');
    expect(sendToHost).not.toHaveBeenCalled();
  });
});
