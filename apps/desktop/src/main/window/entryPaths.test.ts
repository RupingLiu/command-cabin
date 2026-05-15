import { describe, expect, it } from 'vitest';

import { resolveWindowEntryPaths } from './entryPaths.js';

describe('resolveWindowEntryPaths', () => {
  it('points the main process at electron-vite window entry outputs', () => {
    expect(resolveWindowEntryPaths('C:\\CommandCabin\\out\\main')).toEqual({
      preloadPath: 'C:\\CommandCabin\\out\\preload\\index.cjs',
      rendererIndexPath: 'C:\\CommandCabin\\out\\renderer\\index.html',
    });
  });
});
