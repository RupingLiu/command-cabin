import type {
  ScreenshotBounds,
  ScreenshotDisplaySnapshot,
  ScreenshotLaunchState,
} from '../../shared/screenshotApi.js';

export interface ScreenshotDisplay {
  bounds: ScreenshotBounds;
  id: number;
  scaleFactor: number;
}

export interface ScreenshotSource {
  display_id?: string;
  id: string;
  thumbnail: {
    toDataURL: () => string;
  };
}

export interface ScreenshotSourceRequest {
  thumbnailSize: {
    height: number;
    width: number;
  };
  types: ['screen'];
}

export interface CaptureDisplaysOptions {
  getAllDisplays: () => ScreenshotDisplay[];
  getSources: (request: ScreenshotSourceRequest) => Promise<ScreenshotSource[]>;
}

export type ScreenshotDisplayCapture = Omit<ScreenshotLaunchState, 'mode'>;

function calculateVirtualBounds(displays: ScreenshotDisplay[]): ScreenshotBounds {
  if (displays.length === 0) {
    return { height: 0, width: 0, x: 0, y: 0 };
  }

  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));

  return {
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  };
}

function calculateThumbnailSize(displays: ScreenshotDisplay[]): { height: number; width: number } {
  return displays.reduce(
    (size, display) => ({
      height: Math.max(size.height, Math.round(display.bounds.height * display.scaleFactor)),
      width: Math.max(size.width, Math.round(display.bounds.width * display.scaleFactor)),
    }),
    { height: 0, width: 0 },
  );
}

function findSourceForDisplay(
  display: ScreenshotDisplay,
  displayIndex: number,
  sources: ScreenshotSource[],
): ScreenshotSource {
  const sourceByDisplayId = sources.find((source) => source.display_id === String(display.id));

  if (sourceByDisplayId) {
    return sourceByDisplayId;
  }

  const sourceByOrder = sources[displayIndex];

  if (!sourceByOrder) {
    throw new Error(`No screenshot source available for display ${display.id}.`);
  }

  return sourceByOrder;
}

export async function captureDisplays({
  getAllDisplays,
  getSources,
}: CaptureDisplaysOptions): Promise<ScreenshotDisplayCapture> {
  const displays = getAllDisplays();
  const sources = await getSources({
    thumbnailSize: calculateThumbnailSize(displays),
    types: ['screen'],
  });

  return {
    displays: displays.map<ScreenshotDisplaySnapshot>((display, index) => {
      const source = findSourceForDisplay(display, index, sources);

      return {
        bounds: display.bounds,
        id: display.id,
        imageDataUrl: source.thumbnail.toDataURL(),
        scaleFactor: display.scaleFactor,
        sourceId: source.id,
      };
    }),
    virtualBounds: calculateVirtualBounds(displays),
  };
}
