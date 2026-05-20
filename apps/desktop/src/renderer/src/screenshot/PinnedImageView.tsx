import { useEffect, useState } from 'react';

import type { ScreenshotPinnedImageState } from '../../../shared/screenshotApi.js';

type ScreenshotApi = NonNullable<Window['desktopApi']['screenshot']>;

export interface PinnedImageFrameProps {
  imageDataUrl: string;
  onClose?: (() => void) | undefined;
}

export function getPinnedImageTokenFromHref(href: string): string | undefined {
  try {
    const token = new URL(href).searchParams.get('token')?.trim();

    return token && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function requireScreenshotApi(
  screenshotApi: Window['desktopApi']['screenshot'] | undefined,
): ScreenshotApi {
  if (!screenshotApi) {
    throw new Error('Pinned screenshot controls are unavailable in this window.');
  }

  return screenshotApi;
}

export function PinnedImageFrame({ imageDataUrl, onClose }: PinnedImageFrameProps) {
  return (
    <div className="pinned-image-shell">
      <div className="pinned-image-titlebar">
        <button
          aria-label="Close pinned screenshot"
          className="pinned-image-close"
          onClick={() => {
            if (onClose) {
              onClose();
            } else if (typeof window !== 'undefined') {
              window.close();
            }
          }}
          type="button"
        >
          X
        </button>
      </div>
      <img alt="Pinned screenshot" className="pinned-image" draggable={false} src={imageDataUrl} />
    </div>
  );
}

export function PinnedImageView() {
  const [state, setState] = useState<ScreenshotPinnedImageState | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const token =
      typeof window === 'undefined' ? undefined : getPinnedImageTokenFromHref(window.location.href);

    if (!token) {
      setError('Pinned screenshot token is missing.');
      return;
    }

    let screenshotApi: ScreenshotApi;

    try {
      screenshotApi = requireScreenshotApi(
        typeof window !== 'undefined' && 'desktopApi' in window
          ? window.desktopApi.screenshot
          : undefined,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load pinned screenshot.');
      return;
    }

    void screenshotApi
      .getPinnedImageState(token)
      .then(setState)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Unable to load pinned screenshot.');
      });
  }, []);

  if (error) {
    return <div className="pinned-image-shell pinned-image-shell--empty">{error}</div>;
  }

  if (!state) {
    return (
      <div className="pinned-image-shell pinned-image-shell--empty">
        Loading pinned screenshot...
      </div>
    );
  }

  return <PinnedImageFrame imageDataUrl={state.imageDataUrl} />;
}
