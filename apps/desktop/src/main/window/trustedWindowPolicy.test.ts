import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertTrustedIpcSender,
  attachTrustedWindowPolicy,
  clearTrustedWindowPoliciesForTesting,
  createTrustedRendererUrlPredicate,
  denyAllSessionPermissions,
} from './trustedWindowPolicy.js';

class MockWebContents {
  readonly listeners = new Map<string, (...args: unknown[]) => void>();
  readonly mainFrame = {
    url: 'http://localhost:5173/',
  };
  readonly setWindowOpenHandler = vi.fn();

  constructor(readonly id: number) {}

  on(eventName: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(eventName, listener);
  }

  emit(eventName: string, ...args: unknown[]): void {
    this.listeners.get(eventName)?.(...args);
  }
}

describe('trusted window policy', () => {
  beforeEach(() => {
    clearTrustedWindowPoliciesForTesting();
  });

  it('allows only the exact renderer entry and role-specific query', () => {
    const screenshotPolicy = createTrustedRendererUrlPredicate({
      isPackaged: false,
      rendererDevServerUrl: 'http://localhost:5173/',
      rendererIndexPath: 'C:\\CommandCabin\\out\\renderer\\index.html',
      role: 'screenshot',
    });

    expect(screenshotPolicy('http://localhost:5173/?mode=screenshot')).toBe(true);
    expect(screenshotPolicy('http://127.0.0.1:5173/?mode=screenshot')).toBe(false);
    expect(screenshotPolicy('http://localhost:5173/?mode=pinned-image&token=pin-1')).toBe(false);
    expect(screenshotPolicy('https://example.com/?mode=screenshot')).toBe(false);
  });

  it('blocks navigation, redirects, and new windows outside the trusted entry', () => {
    const webContents = new MockWebContents(1);

    attachTrustedWindowPolicy(
      { webContents },
      {
        isPackaged: false,
        rendererDevServerUrl: 'http://localhost:5173/',
        rendererIndexPath: 'C:\\CommandCabin\\out\\renderer\\index.html',
        role: 'launcher',
      },
    );

    const navigationEvent = { preventDefault: vi.fn() };
    const redirectEvent = { preventDefault: vi.fn() };

    webContents.emit('will-navigate', navigationEvent, 'https://example.com/');
    webContents.emit('will-redirect', redirectEvent, 'http://localhost:5173/?mode=screenshot');

    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();
    expect(webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(
      webContents.setWindowOpenHandler.mock.calls[0]?.[0]({ url: 'https://example.com' }),
    ).toEqual({ action: 'deny' });
  });

  it('accepts IPC only from the registered role, URL, and main frame', () => {
    const webContents = new MockWebContents(2);

    attachTrustedWindowPolicy(
      { webContents },
      {
        isPackaged: false,
        rendererDevServerUrl: 'http://localhost:5173/',
        rendererIndexPath: 'C:\\CommandCabin\\out\\renderer\\index.html',
        role: 'launcher',
      },
    );

    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    };

    expect(assertTrustedIpcSender(event as never, ['launcher'])).toBe('launcher');
    expect(() => assertTrustedIpcSender(event as never, ['screenshot'])).toThrow(/window role/i);

    expect(() =>
      assertTrustedIpcSender(
        {
          sender: webContents,
          senderFrame: { url: webContents.mainFrame.url },
        } as never,
        ['launcher'],
      ),
    ).toThrow(/main frame/i);

    webContents.mainFrame.url = 'https://example.com/';
    expect(() => assertTrustedIpcSender(event as never, ['launcher'])).toThrow(/untrusted/i);
  });

  it('removes trust registration when the web contents is destroyed', () => {
    const webContents = new MockWebContents(3);

    attachTrustedWindowPolicy(
      { webContents },
      {
        isPackaged: false,
        rendererDevServerUrl: 'http://localhost:5173/',
        rendererIndexPath: 'C:\\CommandCabin\\out\\renderer\\index.html',
        role: 'launcher',
      },
    );
    webContents.emit('destroyed');

    expect(() =>
      assertTrustedIpcSender(
        {
          sender: webContents,
          senderFrame: webContents.mainFrame,
        } as never,
        ['launcher'],
      ),
    ).toThrow(/window role/i);
  });

  it('denies permission checks and permission requests by default', () => {
    const session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };

    denyAllSessionPermissions(session);

    const checkHandler = session.setPermissionCheckHandler.mock.calls[0]?.[0];
    const requestHandler = session.setPermissionRequestHandler.mock.calls[0]?.[0];
    const callback = vi.fn();

    expect(checkHandler?.()).toBe(false);
    requestHandler?.({}, 'media', callback, {});
    expect(callback).toHaveBeenCalledWith(false);
  });
});
