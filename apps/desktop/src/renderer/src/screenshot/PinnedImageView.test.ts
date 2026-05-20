import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PinnedImageFrame, getPinnedImageTokenFromHref } from './PinnedImageView.js';

describe('PinnedImageView', () => {
  it('renders the pinned image full-window with a draggable strip and no-drag close button', () => {
    const markup = renderToStaticMarkup(
      createElement(PinnedImageFrame, {
        imageDataUrl: 'data:image/png;base64,AAAA',
      }),
    );

    expect(markup).toContain('pinned-image-shell');
    expect(markup).toContain('pinned-image-titlebar');
    expect(markup).toContain('pinned-image-close');
    expect(markup).toContain('src="data:image/png;base64,AAAA"');
    expect(markup).toContain('alt="Pinned screenshot"');
  });

  it('reads the pinned image token from renderer URL query parameters', () => {
    expect(
      getPinnedImageTokenFromHref('https://command-cabin.local/?mode=pinned-image&token=abc-123'),
    ).toBe('abc-123');
    expect(getPinnedImageTokenFromHref('https://command-cabin.local/?mode=pinned-image')).toBe(
      undefined,
    );
    expect(getPinnedImageTokenFromHref('not a url')).toBeUndefined();
  });
});
