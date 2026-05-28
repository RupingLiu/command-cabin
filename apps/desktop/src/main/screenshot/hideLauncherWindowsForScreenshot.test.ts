import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getScreenshotRendererMode,
  hideLauncherWindowsForScreenshot,
  shouldHideWindowForScreenshot,
  type ScreenshotWindowLike,
} from './hideLauncherWindowsForScreenshot.js';

function createWindow({
  url = 'file:///app/index.html',
  visible = true,
  destroyed = false,
}: {
  destroyed?: boolean | undefined;
  url?: string | undefined;
  visible?: boolean | undefined;
} = {}): ScreenshotWindowLike & { emitHide: () => void } {
  let isVisible = visible;
  let hideListener: (() => void) | undefined;

  return {
    hide: vi.fn(() => {
      isVisible = false;
      hideListener?.();
    }),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => isVisible),
    off: vi.fn((_eventName: 'hide', listener: () => void) => {
      if (hideListener === listener) {
        hideListener = undefined;
      }
    }),
    once: vi.fn((_eventName: 'hide', listener: () => void) => {
      hideListener = listener;
    }),
    webContents: {
      getURL: vi.fn(() => url),
    },
    emitHide: () => {
      isVisible = false;
      hideListener?.();
    },
  };
}

describe('hideLauncherWindowsForScreenshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('detects utility renderer modes by URL query', () => {
    expect(
      getScreenshotRendererMode(createWindow({ url: 'file:///app/index.html?mode=screenshot' })),
    ).toBe('screenshot');
    expect(
      getScreenshotRendererMode(createWindow({ url: 'file:///app/index.html?mode=pinned-image' })),
    ).toBe('pinned-image');
    expect(getScreenshotRendererMode(createWindow({ url: 'file:///app/index.html' }))).toBe(
      undefined,
    );
  });

  it('hides visible launcher windows and leaves screenshot utility windows visible', async () => {
    const launcherWindow = createWindow();
    const overlayWindow = createWindow({ url: 'file:///app/index.html?mode=screenshot' });
    const pinnedImageWindow = createWindow({ url: 'file:///app/index.html?mode=pinned-image' });
    const hiddenWindow = createWindow({ visible: false });

    await expect(
      hideLauncherWindowsForScreenshot({
        getWindows: () => [launcherWindow, overlayWindow, pinnedImageWindow, hiddenWindow],
      }),
    ).resolves.toBe(true);

    expect(launcherWindow.hide).toHaveBeenCalledOnce();
    expect(overlayWindow.hide).not.toHaveBeenCalled();
    expect(pinnedImageWindow.hide).not.toHaveBeenCalled();
    expect(hiddenWindow.hide).not.toHaveBeenCalled();
  });

  it('reports false when there is no visible launcher window to hide', async () => {
    await expect(
      hideLauncherWindowsForScreenshot({
        getWindows: () => [
          createWindow({ url: 'file:///app/index.html?mode=screenshot' }),
          createWindow({ destroyed: true }),
          createWindow({ visible: false }),
        ],
      }),
    ).resolves.toBe(false);
  });

  it('waits for the hide timeout if a window does not emit hide promptly', async () => {
    const window = createWindow();
    vi.mocked(window.hide).mockImplementation(() => undefined);

    const result = hideLauncherWindowsForScreenshot({
      getWindows: () => [window],
      hideEventTimeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(24);
    await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(true);
  });

  it('keeps destroyed, hidden, and utility windows out of screenshot hiding', () => {
    expect(shouldHideWindowForScreenshot(createWindow())).toBe(true);
    expect(shouldHideWindowForScreenshot(createWindow({ destroyed: true }))).toBe(false);
    expect(shouldHideWindowForScreenshot(createWindow({ visible: false }))).toBe(false);
    expect(
      shouldHideWindowForScreenshot(
        createWindow({ url: 'file:///app/index.html?mode=screenshot' }),
      ),
    ).toBe(false);
  });
});
