import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DataSettings } from './DataSettings.js';

describe('DataSettings', () => {
  it('renders the data directory path and open action', () => {
    const markup = renderToStaticMarkup(
      createElement(DataSettings, {
        state: {
          errorMessage: undefined,
          isLoading: false,
          isOpening: false,
          path: 'C:\\Users\\Ruping\\AppData\\CommandCabin',
        },
      }),
    );

    expect(markup).toContain('Data Directory');
    expect(markup).toContain('C:\\Users\\Ruping\\AppData\\CommandCabin');
    expect(markup).toContain('Open');
  });

  it('disables the open action while loading', () => {
    const markup = renderToStaticMarkup(
      createElement(DataSettings, {
        state: {
          errorMessage: undefined,
          isLoading: true,
          isOpening: false,
          path: undefined,
        },
      }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
  });
});
