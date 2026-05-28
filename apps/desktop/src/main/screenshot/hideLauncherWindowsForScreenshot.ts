export interface ScreenshotWindowWebContentsLike {
  getURL: () => string;
}

export interface ScreenshotWindowLike {
  hide: () => void;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  off?: (eventName: 'hide', listener: () => void) => unknown;
  once: (eventName: 'hide', listener: () => void) => unknown;
  removeListener?: (eventName: 'hide', listener: () => void) => unknown;
  webContents: ScreenshotWindowWebContentsLike;
}

export interface HideLauncherWindowsForScreenshotOptions {
  getWindows: () => ScreenshotWindowLike[];
  hideEventTimeoutMs?: number | undefined;
}

const defaultHideEventTimeoutMs = 120;

export function getScreenshotRendererMode(
  window: ScreenshotWindowLike,
): 'pinned-image' | 'screenshot' | undefined {
  try {
    const mode = new URL(window.webContents.getURL()).searchParams.get('mode');

    return mode === 'screenshot' || mode === 'pinned-image' ? mode : undefined;
  } catch {
    return undefined;
  }
}

export function shouldHideWindowForScreenshot(window: ScreenshotWindowLike): boolean {
  if (window.isDestroyed() || !window.isVisible()) {
    return false;
  }

  return getScreenshotRendererMode(window) === undefined;
}

export async function hideLauncherWindowsForScreenshot({
  getWindows,
  hideEventTimeoutMs = defaultHideEventTimeoutMs,
}: HideLauncherWindowsForScreenshotOptions): Promise<boolean> {
  const windows = getWindows().filter(shouldHideWindowForScreenshot);

  await Promise.all(windows.map((window) => hideWindowAndWait(window, hideEventTimeoutMs)));

  return windows.length > 0;
}

function hideWindowAndWait(
  window: ScreenshotWindowLike,
  hideEventTimeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      if (window.off) {
        window.off('hide', finish);
      } else {
        window.removeListener?.('hide', finish);
      }
      resolve();
    };
    const timeoutId = setTimeout(finish, hideEventTimeoutMs);

    window.once('hide', finish);
    window.hide();

    if (!window.isVisible()) {
      finish();
    }
  });
}
