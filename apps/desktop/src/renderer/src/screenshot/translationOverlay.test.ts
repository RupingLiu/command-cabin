import { describe, expect, it } from 'vitest';

import {
  createTranslationOverlayAnnotation,
  wrapTranslationOverlayText,
} from './translationOverlay.js';

describe('createTranslationOverlayAnnotation', () => {
  it('covers the full selection with translated text', () => {
    expect(
      createTranslationOverlayAnnotation(
        { height: 80, width: 220, x: 100, y: 50 },
        'Translated text',
      ),
    ).toMatchObject({
      rect: { height: 80, width: 220, x: 0, y: 0 },
      style: { color: '#111827', lineWidth: 1 },
      text: 'Translated text',
      type: 'translation',
    });
  });

  it('returns undefined for empty translation text', () => {
    expect(
      createTranslationOverlayAnnotation({ height: 80, width: 220, x: 100, y: 50 }, '   '),
    ).toBeUndefined();
  });
});

describe('wrapTranslationOverlayText', () => {
  it('wraps translated text to the overlay width', () => {
    expect(
      wrapTranslationOverlayText(
        'This is a longer translation that should wrap',
        { height: 120, width: 90, x: 0, y: 0 },
        16,
      ).length,
    ).toBeGreaterThan(1);
  });
});
