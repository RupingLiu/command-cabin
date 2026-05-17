import { describe, expect, it, vi } from 'vitest';

import { startAppIndexing } from './appIndexStartup.js';

describe('startAppIndexing', () => {
  it('starts auto refresh immediately without waiting for the initial index load', async () => {
    let finishLoad: ((value: undefined) => void) | undefined;
    const refresh = vi.fn(async () => ({
      commands: [],
      failures: [],
      scannedAt: '2026-05-17T00:00:00.000Z',
      source: 'scan' as const,
    }));
    const indexer = {
      getCommands: vi.fn(() => []),
      load: vi.fn(
        () =>
          new Promise<undefined>((resolve) => {
            finishLoad = resolve;
          }),
      ),
      refresh,
      startAutoRefresh: vi.fn(),
      stopAutoRefresh: vi.fn(),
    };

    const startup = startAppIndexing({
      indexer,
      logger: {
        error: vi.fn(),
      },
    });

    expect(indexer.startAutoRefresh).toHaveBeenCalledOnce();
    expect(indexer.load).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();

    finishLoad?.(undefined);
    await startup;

    expect(refresh).toHaveBeenCalledOnce();
  });
});
