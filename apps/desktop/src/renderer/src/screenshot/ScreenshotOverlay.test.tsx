import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ScreenshotOverlayView } from './ScreenshotOverlay.js';
import type { ScreenshotLaunchState } from '../../../shared/screenshotApi.js';

const launchState: ScreenshotLaunchState = {
  displays: [
    {
      bounds: { height: 200, width: 300, x: 0, y: 0 },
      id: 1,
      imageDataUrl: 'data:image/png;base64,AAAA',
      scaleFactor: 1,
      sourceId: 'screen:1',
    },
  ],
  mode: 'ocr',
  virtualBounds: { height: 200, width: 300, x: 0, y: 0 },
};

describe('ScreenshotOverlayView', () => {
  it('renders display backgrounds, tools, output actions, and style controls', () => {
    const markup = renderToStaticMarkup(createElement(ScreenshotOverlayView, { launchState }));

    expect(markup).toContain('screenshot-overlay');
    expect(markup).toContain('data-source-id="screen:1"');
    expect(markup).toContain('Rectangle');
    expect(markup).toContain('Ellipse');
    expect(markup).toContain('Arrow');
    expect(markup).toContain('Pen');
    expect(markup).toContain('Text');
    expect(markup).toContain('Mosaic');
    expect(markup).toContain('OCR');
    expect(markup).toContain('Pin');
    expect(markup).toContain('Save');
    expect(markup).toContain('Done');
    expect(markup).toContain('PNG');
    expect(markup).toContain('JPG');
    expect(markup).toContain('screenshot-magnifier');
  });
});
