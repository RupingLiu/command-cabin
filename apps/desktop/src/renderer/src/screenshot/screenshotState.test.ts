import { describe, expect, it } from 'vitest';

import {
  createInitialScreenshotState,
  isScreenshotReadyToComplete,
  screenshotReducer,
} from './screenshotState.js';

describe('screenshotReducer', () => {
  it('normalizes selection rectangles from negative drags', () => {
    const state = screenshotReducer(
      screenshotReducer(createInitialScreenshotState(), {
        point: { x: 120, y: 80 },
        type: 'selection-started',
      }),
      {
        point: { x: 20, y: 30 },
        type: 'selection-updated',
      },
    );

    expect(state.selection).toEqual({ height: 50, width: 100, x: 20, y: 30 });
    expect(isScreenshotReadyToComplete(state)).toBe(true);
  });

  it('is not ready to complete with an empty selection', () => {
    const state = screenshotReducer(createInitialScreenshotState(), {
      point: { x: 10, y: 10 },
      type: 'selection-started',
    });

    expect(isScreenshotReadyToComplete(state)).toBe(false);
  });

  it('selects annotation tools and styles', () => {
    const state = [
      { tool: 'ellipse' as const, type: 'tool-selected' as const },
      { color: '#ff3355', type: 'color-selected' as const },
      { lineWidth: 6, type: 'line-width-selected' as const },
      { fontSize: 24, type: 'font-size-selected' as const },
    ].reduce(screenshotReducer, createInitialScreenshotState());

    expect(state.tool).toBe('ellipse');
    expect(state.style).toEqual({ color: '#ff3355', fontSize: 24, lineWidth: 6 });
  });

  it('commits all annotation types without object-level edit state', () => {
    const selected = screenshotReducer(createInitialScreenshotState(), {
      rect: { height: 90, width: 120, x: 10, y: 20 },
      type: 'selection-set',
    });
    const annotations = [
      { rect: { height: 30, width: 40, x: 12, y: 24 }, type: 'rectangle' as const },
      { rect: { height: 30, width: 40, x: 14, y: 26 }, type: 'ellipse' as const },
      { from: { x: 20, y: 30 }, to: { x: 80, y: 60 }, type: 'arrow' as const },
      {
        points: [
          { x: 25, y: 35 },
          { x: 35, y: 45 },
        ],
        type: 'pen' as const,
      },
      { point: { x: 30, y: 42 }, text: 'Note', type: 'text' as const },
      { rect: { height: 18, width: 24, x: 40, y: 50 }, type: 'mosaic' as const },
    ];

    const state = annotations.reduce(
      (current, annotation) =>
        screenshotReducer(current, {
          annotation,
          type: 'annotation-committed',
        }),
      selected,
    );

    expect(state.annotations).toHaveLength(6);
    expect(state.draftAnnotation).toBeUndefined();
  });

  it('supports undo and redo and clears redo after a new annotation', () => {
    const selected = screenshotReducer(createInitialScreenshotState(), {
      rect: { height: 90, width: 120, x: 10, y: 20 },
      type: 'selection-set',
    });
    const withTwo = [
      { rect: { height: 10, width: 10, x: 12, y: 24 }, type: 'rectangle' as const },
      { rect: { height: 14, width: 16, x: 30, y: 34 }, type: 'mosaic' as const },
    ].reduce(
      (current, annotation) =>
        screenshotReducer(current, {
          annotation,
          type: 'annotation-committed',
        }),
      selected,
    );

    const undone = screenshotReducer(withTwo, { type: 'undo' });
    const redone = screenshotReducer(undone, { type: 'redo' });
    const branched = screenshotReducer(undone, {
      annotation: { point: { x: 30, y: 42 }, text: 'New', type: 'text' },
      type: 'annotation-committed',
    });

    expect(undone.annotations).toHaveLength(1);
    expect(undone.redoAnnotations).toHaveLength(1);
    expect(redone.annotations).toHaveLength(2);
    expect(branched.annotations.map((annotation) => annotation.type)).toEqual([
      'rectangle',
      'text',
    ]);
    expect(branched.redoAnnotations).toEqual([]);
  });
});
