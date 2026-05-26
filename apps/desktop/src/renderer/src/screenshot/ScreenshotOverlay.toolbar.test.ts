import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ScreenshotOverlayView, getScreenshotToolbarPlacement } from './ScreenshotOverlay.js';
import { createInitialScreenshotState, screenshotReducer } from './screenshotState.js';
import { getUiStrings } from '../i18n.js';
import type { ScreenshotLaunchState } from '../../../shared/screenshotApi.js';

const launchState: ScreenshotLaunchState = {
  displays: [
    {
      bounds: { height: 600, width: 800, x: 0, y: 0 },
      id: 1,
      imageDataUrl: 'data:image/png;base64,AAAA',
      scaleFactor: 1,
      sourceId: 'screen:1',
    },
  ],
  mode: 'capture',
  virtualBounds: { height: 600, width: 800, x: 0, y: 0 },
};

describe('getScreenshotToolbarPlacement', () => {
  it('places the toolbar below the selection when there is room', () => {
    expect(
      getScreenshotToolbarPlacement({
        selection: { height: 80, width: 180, x: 200, y: 120 },
        toolbar: { height: 48, width: 220 },
        viewport: { height: 600, width: 800 },
      }),
    ).toEqual({ x: 180, y: 212 });
  });

  it('places the toolbar above the selection when below would overflow', () => {
    expect(
      getScreenshotToolbarPlacement({
        selection: { height: 90, width: 160, x: 300, y: 520 },
        toolbar: { height: 54, width: 240 },
        viewport: { height: 640, width: 800 },
      }),
    ).toEqual({ x: 260, y: 454 });
  });

  it('clamps the toolbar horizontally within the viewport', () => {
    expect(
      getScreenshotToolbarPlacement({
        selection: { height: 80, width: 80, x: 4, y: 100 },
        toolbar: { height: 50, width: 180 },
        viewport: { height: 500, width: 320 },
      }).x,
    ).toBe(0);

    expect(
      getScreenshotToolbarPlacement({
        selection: { height: 80, width: 80, x: 280, y: 100 },
        toolbar: { height: 50, width: 180 },
        viewport: { height: 500, width: 320 },
      }).x,
    ).toBe(140);
  });
});

describe('ScreenshotOverlayView toolbar', () => {
  it('renders primary toolbar buttons with accessible labels and titles', () => {
    const selectedState = screenshotReducer(createInitialScreenshotState(), {
      rect: { height: 160, width: 220, x: 120, y: 120 },
      type: 'selection-set',
    });
    const markup = renderToStaticMarkup(
      createElement(ScreenshotOverlayView, {
        initialState: selectedState,
        launchState,
        strings: getUiStrings('en-US').screenshot,
      }),
    );

    for (const label of ['Rectangle', 'Arrow', 'Text', 'OCR', 'Pin', 'Save', 'Done', 'Cancel']) {
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(`title="${label}"`);
    }

    expect(markup).toContain('class="screenshot-action-button screenshot-action-button--done"');
    expect(markup).toContain('class="screenshot-action-button screenshot-action-button--cancel"');
  });
});
