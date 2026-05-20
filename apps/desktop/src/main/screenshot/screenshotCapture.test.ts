import { describe, expect, it, vi } from 'vitest';

import { captureDisplays } from './screenshotCapture.js';

describe('captureDisplays', () => {
  it('captures every display at scaled thumbnail size and matches sources by display id', async () => {
    const getAllDisplays = vi.fn(() => [
      { bounds: { height: 1080, width: 1920, x: 0, y: 0 }, id: 10, scaleFactor: 1 },
      { bounds: { height: 900, width: 1440, x: 1920, y: 0 }, id: 20, scaleFactor: 1.5 },
    ]);
    const getSources = vi.fn(async () => [
      {
        display_id: '20',
        id: 'screen:20',
        thumbnail: { toDataURL: () => 'data:image/png;base64,TWENTY' },
      },
      {
        display_id: '10',
        id: 'screen:10',
        thumbnail: { toDataURL: () => 'data:image/png;base64,TEN' },
      },
    ]);

    await expect(captureDisplays({ getAllDisplays, getSources })).resolves.toEqual({
      displays: [
        {
          bounds: { height: 1080, width: 1920, x: 0, y: 0 },
          id: 10,
          imageDataUrl: 'data:image/png;base64,TEN',
          scaleFactor: 1,
          sourceId: 'screen:10',
        },
        {
          bounds: { height: 900, width: 1440, x: 1920, y: 0 },
          id: 20,
          imageDataUrl: 'data:image/png;base64,TWENTY',
          scaleFactor: 1.5,
          sourceId: 'screen:20',
        },
      ],
      virtualBounds: { height: 1080, width: 3360, x: 0, y: 0 },
    });
    expect(getSources).toHaveBeenCalledWith({
      thumbnailSize: { height: 1350, width: 2160 },
      types: ['screen'],
    });
  });

  it('falls back to deterministic source order when display ids are unavailable', async () => {
    const getAllDisplays = vi.fn(() => [
      { bounds: { height: 100, width: 100, x: -100, y: 0 }, id: 1, scaleFactor: 1 },
      { bounds: { height: 100, width: 200, x: 0, y: 0 }, id: 2, scaleFactor: 1 },
    ]);
    const getSources = vi.fn(async () => [
      { id: 'first', thumbnail: { toDataURL: () => 'data:image/png;base64,FIRST' } },
      { id: 'second', thumbnail: { toDataURL: () => 'data:image/png;base64,SECOND' } },
    ]);

    const capture = await captureDisplays({ getAllDisplays, getSources });

    expect(capture.displays.map((display) => display.sourceId)).toEqual(['first', 'second']);
    expect(capture.virtualBounds).toEqual({ height: 100, width: 300, x: -100, y: 0 });
  });
});
