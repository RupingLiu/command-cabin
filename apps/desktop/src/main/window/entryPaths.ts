import { join } from 'node:path';

export interface WindowEntryPaths {
  preloadPath: string;
  rendererIndexPath: string;
}

export function resolveWindowEntryPaths(mainDirectory: string): WindowEntryPaths {
  return {
    preloadPath: join(mainDirectory, '../preload/index.cjs'),
    rendererIndexPath: join(mainDirectory, '../renderer/index.html'),
  };
}
