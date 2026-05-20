import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  ScreenshotOverlayView,
  createPendingTextAnnotationController,
  requireScreenshotApi,
} from './ScreenshotOverlay.js';
import {
  createInitialScreenshotState,
  screenshotReducer,
  type ScreenshotState,
} from './screenshotState.js';
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

  it('renders committed annotations and the current draft in a selection SVG overlay', () => {
    const initialState = withSelectionAndAnnotations();
    const markup = renderToStaticMarkup(
      createElement(ScreenshotOverlayView, { initialState, launchState }),
    );

    expect(markup).toContain('screenshot-annotation-layer');
    expect(markup).toContain('data-annotation-type="rectangle"');
    expect(markup).toContain('data-annotation-type="arrow"');
    expect(markup).toContain('data-annotation-type="pen"');
    expect(markup).toContain('data-annotation-type="text"');
    expect(markup).toContain('data-annotation-type="mosaic"');
    expect(markup).toContain('data-draft="true"');
    expect(markup).toContain('y="92"');
    expect(markup).not.toContain('y="110"');
  });

  it('throws a readable error when screenshot preload APIs are unavailable', () => {
    expect(() => requireScreenshotApi(undefined)).toThrow(
      'Screenshot controls are unavailable in this window.',
    );
  });

  it('cancels stale delayed text annotation commits', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const controller = createPendingTextAnnotationController({
      clearTimer: clearTimeout,
      delayMs: 220,
      setTimer: setTimeout,
    });

    controller.schedule(() => commit('old selection'));
    controller.cancel();
    vi.advanceTimersByTime(220);

    controller.schedule(() => commit('old text click'));
    controller.schedule(() => commit('new text click'));
    vi.advanceTimersByTime(220);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('new text click');
    vi.useRealTimers();
  });
});

function withSelectionAndAnnotations(): ScreenshotState {
  const selected = screenshotReducer(createInitialScreenshotState(), {
    rect: { height: 120, width: 160, x: 20, y: 30 },
    type: 'selection-set',
  });
  const withAnnotations = [
    { rect: { height: 20, width: 40, x: 8, y: 10 }, type: 'rectangle' as const },
    { from: { x: 10, y: 50 }, to: { x: 90, y: 70 }, type: 'arrow' as const },
    {
      points: [
        { x: 12, y: 80 },
        { x: 20, y: 84 },
      ],
      type: 'pen' as const,
    },
    { point: { x: 16, y: 92 }, text: 'Label', type: 'text' as const },
    { rect: { height: 22, width: 30, x: 100, y: 20 }, type: 'mosaic' as const },
  ].reduce(
    (current, annotation) =>
      screenshotReducer(current, {
        annotation,
        type: 'annotation-committed',
      }),
    selected,
  );

  return screenshotReducer(
    screenshotReducer(withAnnotations, { tool: 'ellipse', type: 'tool-selected' }),
    {
      point: { x: 40, y: 40 },
      type: 'annotation-started',
    },
  );
}
