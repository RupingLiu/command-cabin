import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  OcrPanel,
  ScreenshotOverlayView,
  TextAnnotationInput,
  createPendingTextAnnotationController,
  getPendingTextPointerAction,
  getScreenshotCompletionAction,
  getTextAnnotationKeyAction,
  requireScreenshotApi,
} from './ScreenshotOverlay.js';
import {
  createInitialScreenshotState,
  screenshotReducer,
  type ScreenshotState,
} from './screenshotState.js';
import { getUiStrings } from '../i18n.js';
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
    const markup = renderToStaticMarkup(
      createElement(ScreenshotOverlayView, {
        launchState,
        strings: getUiStrings('en-US').screenshot,
      }),
    );

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

  it('renders screenshot toolbar strings in Simplified and Traditional Chinese', () => {
    const simplified = renderToStaticMarkup(
      createElement(ScreenshotOverlayView, {
        launchState,
        strings: getUiStrings('zh-CN').screenshot,
      }),
    );
    const traditional = renderToStaticMarkup(
      createElement(ScreenshotOverlayView, {
        launchState,
        strings: getUiStrings('zh-TW').screenshot,
      }),
    );

    expect(simplified).toContain('矩形');
    expect(simplified).toContain('颜色');
    expect(simplified).toContain('置顶');
    expect(simplified).toContain('完成');
    expect(traditional).toContain('橢圓');
    expect(traditional).toContain('顏色');
    expect(traditional).toContain('置頂');
    expect(traditional).toContain('儲存');
  });

  it('renders OCR progress, recognized text, unavailable, and error panel states', () => {
    const running = renderToStaticMarkup(
      createElement(OcrPanel, {
        onCopyAll: vi.fn(),
        strings: getUiStrings('en-US').screenshot,
        state: { status: 'running' },
      }),
    );
    const success = renderToStaticMarkup(
      createElement(OcrPanel, {
        onCopyAll: vi.fn(),
        strings: getUiStrings('en-US').screenshot,
        state: {
          language: 'en-US',
          lines: ['first line', 'second line'],
          status: 'success',
          text: 'first line\nsecond line',
        },
      }),
    );
    const unavailable = renderToStaticMarkup(
      createElement(OcrPanel, {
        onCopyAll: vi.fn(),
        strings: getUiStrings('en-US').screenshot,
        state: {
          language: 'zh-CN',
          message: 'Windows OCR is unavailable.',
          status: 'unavailable',
        },
      }),
    );
    const error = renderToStaticMarkup(
      createElement(OcrPanel, {
        onCopyAll: vi.fn(),
        strings: getUiStrings('en-US').screenshot,
        state: {
          language: 'en-US',
          message: 'OCR failed.',
          status: 'error',
        },
      }),
    );

    expect(running).toContain('Recognizing text...');
    expect(success).toContain('first line');
    expect(success).toContain('second line');
    expect(success).toContain('Copy All');
    expect(unavailable).toContain('Windows OCR is unavailable.');
    expect(error).toContain('OCR failed.');
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
    expect(markup).toContain('screenshot-mosaic-preview');
    expect(markup).toContain('data-draft="true"');
    expect(markup).toContain('y="92"');
    expect(markup).not.toContain('y="110"');
  });

  it('renders an inline multiline text editor with commit and cancel controls', () => {
    const markup = renderToStaticMarkup(
      createElement(TextAnnotationInput, {
        cancelLabel: 'Cancel',
        commitLabel: 'Done',
        fontSize: 18,
        placeholder: '文字',
        point: { x: 12, y: 24 },
        value: 'Hello\nworld',
        onCancel: vi.fn(),
        onChange: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    expect(markup).toContain('<textarea');
    expect(markup).toContain('screenshot-text-input');
    expect(markup).toContain('aria-label="文字"');
    expect(markup).toContain('Hello\nworld');
    expect(markup).toContain('screenshot-text-actions');
    expect(markup).toContain('aria-label="Done"');
    expect(markup).toContain('aria-label="Cancel"');
  });

  it('keeps Enter for editing but commits or cancels explicit text editor shortcuts', () => {
    expect(getTextAnnotationKeyAction({ key: 'Enter' })).toBe('edit');
    expect(getTextAnnotationKeyAction({ ctrlKey: true, key: 'Enter' })).toBe('commit');
    expect(getTextAnnotationKeyAction({ key: 'Enter', metaKey: true })).toBe('commit');
    expect(getTextAnnotationKeyAction({ key: 'Escape' })).toBe('cancel');
  });

  it('commits pending text before handling an outside pointer interaction', () => {
    expect(getPendingTextPointerAction(true)).toBe('commit');
    expect(getPendingTextPointerAction(false)).toBe('none');
  });

  it('throws a readable error when screenshot preload APIs are unavailable', () => {
    expect(() => requireScreenshotApi(undefined)).toThrow('截图控制不可用。');
    expect(() =>
      requireScreenshotApi(undefined, getUiStrings('en-US').screenshot.controlsUnavailable),
    ).toThrow('Screenshot controls are unavailable in this window.');
  });

  it('uses OCR as the default completion action only for OCR launch mode', () => {
    expect(getScreenshotCompletionAction({ mode: 'ocr' })).toBe('ocr');
    expect(getScreenshotCompletionAction({ mode: 'capture' })).toBe('copy');
    expect(getScreenshotCompletionAction({ mode: 'capture-delay-3' })).toBe('copy');
    expect(getScreenshotCompletionAction({ mode: 'capture-delay-5' })).toBe('copy');
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
