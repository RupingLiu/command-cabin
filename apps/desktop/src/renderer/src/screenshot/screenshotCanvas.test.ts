import { describe, expect, it, vi } from 'vitest';

import { composeScreenshotSelection, loadBrowserImage } from './screenshotCanvas.js';
import type { ScreenshotAnnotation } from './screenshotState.js';
import type { ScreenshotLaunchState } from '../../../shared/screenshotApi.js';

function createMockCanvas() {
  const drawImageCalls: { args: unknown[] }[] = [];
  const operations: string[] = [];
  const context = {
    beginPath: vi.fn(() => operations.push('beginPath')),
    closePath: vi.fn(() => operations.push('closePath')),
    drawImage: vi.fn((...args: unknown[]) => drawImageCalls.push({ args })),
    ellipse: vi.fn(() => operations.push('ellipse')),
    fillRect: vi.fn((x: number, y: number, width: number, height: number) =>
      operations.push(`fillRect:${x}:${y}:${width}:${height}`),
    ),
    fillText: vi.fn((text: string, x: number, y: number) =>
      operations.push(`fillText:${text}:${x}:${Number(y.toFixed(1))}`),
    ),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16), height: 2, width: 2 })),
    lineTo: vi.fn(() => operations.push('lineTo')),
    moveTo: vi.fn(() => operations.push('moveTo')),
    putImageData: vi.fn(() => operations.push('putImageData')),
    rect: vi.fn(() => operations.push('rect')),
    restore: vi.fn(() => operations.push('restore')),
    save: vi.fn(() => operations.push('save')),
    stroke: vi.fn(() => operations.push('stroke')),
  };
  const canvas = {
    height: 0,
    getContext: vi.fn(() => context),
    toDataURL: vi.fn((mimeType: string, quality?: number) => `${mimeType}:${quality ?? 'none'}`),
    width: 0,
  };

  return { canvas, drawImageCalls, operations };
}

const launchState: ScreenshotLaunchState = {
  displays: [
    {
      bounds: { height: 200, width: 300, x: -100, y: 0 },
      id: 1,
      imageDataUrl: 'data:image/png;base64,AAAA',
      scaleFactor: 1,
      sourceId: 'screen:1',
    },
  ],
  mode: 'capture',
  virtualBounds: { height: 200, width: 300, x: -100, y: 0 },
};

describe('composeScreenshotSelection', () => {
  it('crops the selected virtual rect and returns a PNG data URL', async () => {
    const mock = createMockCanvas();

    const result = await composeScreenshotSelection({
      createCanvas: () => mock.canvas,
      format: 'png',
      launchState,
      loadImage: async (source) => ({ source }),
      selection: { height: 50, width: 80, x: -20, y: 30 },
    });

    expect(result).toBe('image/png:none');
    expect(mock.canvas.width).toBe(80);
    expect(mock.canvas.height).toBe(50);
    expect(mock.drawImageCalls[0]?.args.slice(1)).toEqual([-80, -30, 300, 200]);
  });

  it('uses JPEG encoding quality for JPG output', async () => {
    const mock = createMockCanvas();

    await composeScreenshotSelection({
      createCanvas: () => mock.canvas,
      format: 'jpg',
      jpegQuality: 0.82,
      launchState,
      loadImage: async (source) => ({ source }),
      selection: { height: 50, width: 80, x: -20, y: 30 },
    });

    expect(mock.canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.82);
  });

  it('exports high-DPI selections at the display scale factor', async () => {
    const mock = createMockCanvas();

    await composeScreenshotSelection({
      createCanvas: () => mock.canvas,
      format: 'png',
      launchState: {
        ...launchState,
        displays: [{ ...launchState.displays[0]!, scaleFactor: 2 }],
      },
      loadImage: async (source) => ({ source }),
      selection: { height: 50, width: 80, x: -20, y: 30 },
    });

    expect(mock.canvas.width).toBe(160);
    expect(mock.canvas.height).toBe(100);
    expect(mock.drawImageCalls[0]?.args.slice(1)).toEqual([-160, -60, 600, 400]);
  });

  it('draws shape, text, pen, arrow, and mosaic annotations after the background', async () => {
    const mock = createMockCanvas();
    const annotations: ScreenshotAnnotation[] = [
      { rect: { height: 10, width: 20, x: 0, y: 0 }, style: baseStyle(), type: 'rectangle' },
      { rect: { height: 10, width: 20, x: 24, y: 0 }, style: baseStyle(), type: 'ellipse' },
      { from: { x: 0, y: 20 }, style: baseStyle(), to: { x: 30, y: 30 }, type: 'arrow' },
      {
        points: [
          { x: 0, y: 34 },
          { x: 20, y: 40 },
        ],
        style: baseStyle(),
        type: 'pen',
      },
      { point: { x: 4, y: 48 }, style: baseStyle(), text: 'OCR', type: 'text' },
      { rect: { height: 12, width: 12, x: 36, y: 36 }, style: baseStyle(), type: 'mosaic' },
      {
        rect: { height: 26, width: 80, x: 0, y: 0 },
        style: { color: '#111827', fontSize: 16, lineWidth: 1 },
        text: 'translated',
        type: 'translation',
      },
    ];

    await composeScreenshotSelection({
      annotations,
      createCanvas: () => mock.canvas,
      format: 'png',
      launchState,
      loadImage: async (source) => ({ source }),
      selection: { height: 70, width: 90, x: -20, y: 30 },
    });

    expect(mock.operations).toContain('rect');
    expect(mock.operations).toContain('ellipse');
    expect(mock.operations).toContain('lineTo');
    expect(mock.operations).toContain('fillText:OCR:4:48');
    expect(mock.operations).toContain('putImageData');
    expect(mock.operations).toContain('fillRect:0:0:80:26');
    expect(
      mock.operations.some(
        (operation) => operation.startsWith('fillText:') && operation.endsWith(':9:9'),
      ),
    ).toBe(true);
  });

  it('draws multiline text annotations one canvas line at a time', async () => {
    const mock = createMockCanvas();

    await composeScreenshotSelection({
      annotations: [
        {
          point: { x: 4, y: 8 },
          style: baseStyle(),
          text: 'first\nsecond',
          type: 'text',
        },
      ],
      createCanvas: () => mock.canvas,
      format: 'png',
      launchState,
      loadImage: async (source) => ({ source }),
      selection: { height: 70, width: 90, x: -20, y: 30 },
    });

    expect(mock.operations).toContain('fillText:first:4:8');
    expect(mock.operations).toContain('fillText:second:4:29.6');
  });

  it('draws a display image already decoded in the DOM without decoding it again', async () => {
    const mock = createMockCanvas();
    const existing = { complete: true, src: 'data:image/png;base64,AAAA' };

    const result = await composeScreenshotSelection({
      createCanvas: () => mock.canvas,
      decodedImages: new Map<string, unknown>([['data:image/png;base64,AAAA', existing]]),
      format: 'png',
      launchState,
      selection: { height: 50, width: 80, x: -20, y: 30 },
    });

    expect(result).toBe('image/png:none');
    expect(mock.drawImageCalls[0]?.args[0]).toBe(existing);
  });
});

describe('loadBrowserImage', () => {
  it('reuses a complete image element whose source already matches', async () => {
    const existing = { complete: true, src: 'data:image/png;base64,AAAA' };
    const createImage = vi.fn();

    const result = await loadBrowserImage(
      'data:image/png;base64,AAAA',
      existing as unknown as HTMLImageElement,
      createImage as unknown as () => HTMLImageElement,
    );

    expect(result).toBe(existing);
    expect(createImage).not.toHaveBeenCalled();
  });

  it('falls back to a fresh decode when the existing image is incomplete or mismatched', async () => {
    for (const existing of [
      { complete: false, src: 'data:image/png;base64,AAAA' },
      { complete: true, src: 'data:image/png;base64,BBBB' },
    ]) {
      const created = {} as unknown as HTMLImageElement;
      const createImage = vi.fn(() => {
        queueMicrotask(() => {
          (created as { onload?: () => void }).onload?.();
        });
        return created;
      });

      const result = await loadBrowserImage(
        'data:image/png;base64,AAAA',
        existing as unknown as HTMLImageElement,
        createImage as unknown as () => HTMLImageElement,
      );

      expect(result).toBe(created);
      expect(createImage).toHaveBeenCalledTimes(1);
    }
  });
});

function baseStyle() {
  return { color: '#ff3355', fontSize: 18, lineWidth: 3 };
}
