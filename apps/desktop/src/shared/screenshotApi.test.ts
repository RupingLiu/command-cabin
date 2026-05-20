import { describe, expect, it } from 'vitest';

import {
  parseScreenshotCopyImageRequest,
  parseScreenshotLaunchMode,
  parseScreenshotLaunchState,
  parseScreenshotOcrRequest,
  parseScreenshotPinImageRequest,
  parseScreenshotSaveImageRequest,
  parseScreenshotSaveImageResult,
} from './screenshotApi.js';

const pngDataUrl = 'data:image/png;base64,AAAA';
const jpgDataUrl = 'data:image/jpeg;base64,BBBB';

describe('screenshotApi parsers', () => {
  it('parses launch modes and launch state snapshots', () => {
    expect(parseScreenshotLaunchMode('capture-delay-3')).toBe('capture-delay-3');

    expect(
      parseScreenshotLaunchState({
        mode: 'ocr',
        displays: [
          {
            bounds: { height: 1080, width: 1920, x: 0, y: 0 },
            id: 1,
            imageDataUrl: pngDataUrl,
            scaleFactor: 1.25,
            sourceId: 'screen:1',
          },
        ],
        virtualBounds: { height: 1080, width: 1920, x: 0, y: 0 },
      }),
    ).toEqual({
      mode: 'ocr',
      displays: [
        {
          bounds: { height: 1080, width: 1920, x: 0, y: 0 },
          id: 1,
          imageDataUrl: pngDataUrl,
          scaleFactor: 1.25,
          sourceId: 'screen:1',
        },
      ],
      virtualBounds: { height: 1080, width: 1920, x: 0, y: 0 },
    });
  });

  it('rejects malformed launch state values and unknown keys', () => {
    expect(() => parseScreenshotLaunchMode('capture-delay-9')).toThrow(/launch mode/i);
    expect(() =>
      parseScreenshotLaunchState({
        mode: 'capture',
        displays: [],
        virtualBounds: { height: 100, width: 100, x: 0, y: 0 },
        unknown: true,
      }),
    ).toThrow(/unknown/i);
    expect(() =>
      parseScreenshotLaunchState({
        mode: 'capture',
        displays: [
          {
            bounds: { height: 100, width: 100, x: 0, y: 0 },
            id: 1,
            imageDataUrl: 'data:image/gif;base64,AAAA',
            scaleFactor: 1,
            sourceId: 'screen:1',
          },
        ],
        virtualBounds: { height: 100, width: 100, x: 0, y: 0 },
      }),
    ).toThrow(/image data url/i);
  });

  it('parses image operation requests and constrained values', () => {
    expect(parseScreenshotCopyImageRequest({ imageDataUrl: pngDataUrl })).toEqual({
      imageDataUrl: pngDataUrl,
    });
    expect(parseScreenshotPinImageRequest({ imageDataUrl: jpgDataUrl })).toEqual({
      imageDataUrl: jpgDataUrl,
    });
    expect(
      parseScreenshotSaveImageRequest({
        defaultPath: 'C:\\Users\\Ruping\\Desktop\\capture.png',
        format: 'png',
        imageDataUrl: pngDataUrl,
      }),
    ).toEqual({
      defaultPath: 'C:\\Users\\Ruping\\Desktop\\capture.png',
      format: 'png',
      imageDataUrl: pngDataUrl,
    });
    expect(parseScreenshotOcrRequest({ imageDataUrl: pngDataUrl, language: 'zh-CN' })).toEqual({
      imageDataUrl: pngDataUrl,
      language: 'zh-CN',
    });
    expect(
      parseScreenshotSaveImageResult({ canceled: false, filePath: 'C:\\capture.png' }),
    ).toEqual({
      canceled: false,
      filePath: 'C:\\capture.png',
    });
  });

  it('rejects unknown image request keys and unsupported formats or OCR languages', () => {
    expect(() =>
      parseScreenshotCopyImageRequest({ imageDataUrl: pngDataUrl, extra: true }),
    ).toThrow(/unknown/i);
    expect(() =>
      parseScreenshotSaveImageRequest({ format: 'webp', imageDataUrl: pngDataUrl }),
    ).toThrow(/save format/i);
    expect(() =>
      parseScreenshotOcrRequest({ imageDataUrl: pngDataUrl, language: 'ja-JP' }),
    ).toThrow(/ocr language/i);
  });
});
