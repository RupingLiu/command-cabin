import { describe, expect, it, vi } from 'vitest';

import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';
import { hydrateSearchResultsWithCachedIcons } from './searchResultIconHydration.js';

function createAppResult(id: string): LauncherCommandSearchResult {
  return {
    iconCandidates: [`C:\\Program Files\\${id}\\${id}.exe`],
    id: `app.${id}`,
    score: 1,
    source: 'app',
    title: id,
  };
}

describe('hydrateSearchResultsWithCachedIcons', () => {
  it('returns cached search results before background icon warming settles', async () => {
    let resolveWarm: (() => void) | undefined;
    const appIconResolver = {
      resolveCachedSearchResultIcon: vi.fn(async (result: LauncherCommandSearchResult) => ({
        id: result.id,
        score: result.score,
        source: result.source,
        title: result.title,
      })),
      warmSearchResultIcon: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWarm = resolve;
          }),
      ),
    };

    await expect(
      hydrateSearchResultsWithCachedIcons([createAppResult('wps')], {
        appIconResolver,
      }),
    ).resolves.toEqual([
      {
        id: 'app.wps',
        score: 1,
        source: 'app',
        title: 'wps',
      },
    ]);

    expect(appIconResolver.warmSearchResultIcon).toHaveBeenCalledOnce();
    resolveWarm?.();
  });

  it('logs background icon warming failures without failing search results', async () => {
    const logger = { warn: vi.fn() };
    const iconError = new Error('icon unavailable');
    const appIconResolver = {
      resolveCachedSearchResultIcon: vi.fn(async (result: LauncherCommandSearchResult) => result),
      warmSearchResultIcon: vi.fn(async () => {
        throw iconError;
      }),
    };

    await expect(
      hydrateSearchResultsWithCachedIcons([createAppResult('wps')], {
        appIconResolver,
        logger,
      }),
    ).resolves.toMatchObject([
      {
        id: 'app.wps',
      },
    ]);

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith('Failed to warm search result icons.', iconError);
    });
  });
});
