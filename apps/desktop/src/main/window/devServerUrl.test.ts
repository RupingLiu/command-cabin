import { describe, expect, it } from 'vitest';

import { resolveSafeRendererDevServerUrl } from './devServerUrl.js';

describe('resolveSafeRendererDevServerUrl', () => {
  it('ignores Electron renderer URLs once the app is packaged', () => {
    expect(
      resolveSafeRendererDevServerUrl({
        isPackaged: true,
        rendererDevServerUrl: 'http://localhost:5173',
      }),
    ).toBeUndefined();
  });

  it('allows localhost HTTP dev server URLs in unpackaged runs', () => {
    expect(
      resolveSafeRendererDevServerUrl({
        isPackaged: false,
        rendererDevServerUrl: 'http://localhost:5173',
      }),
    ).toBe('http://localhost:5173');
  });

  it('rejects remote or malformed dev server URLs', () => {
    expect(
      resolveSafeRendererDevServerUrl({
        isPackaged: false,
        rendererDevServerUrl: 'https://example.com/launcher',
      }),
    ).toBeUndefined();

    expect(
      resolveSafeRendererDevServerUrl({
        isPackaged: false,
        rendererDevServerUrl: 'not a url',
      }),
    ).toBeUndefined();
  });
});
