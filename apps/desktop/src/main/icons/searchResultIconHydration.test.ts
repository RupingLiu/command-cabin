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
  it('returns cached search results before background icon resolution settles', async () => {
    let resolveIcon: ((result: LauncherCommandSearchResult) => void) | undefined;
    const appIconResolver = {
      resolveCachedSearchResultIcon: vi.fn(async (result: LauncherCommandSearchResult) => ({
        id: result.id,
        score: result.score,
        source: result.source,
        title: result.title,
      })),
      resolveSearchResultIcon: vi.fn(
        () =>
          new Promise<LauncherCommandSearchResult>((resolve) => {
            resolveIcon = resolve;
          }),
      ),
    };
    const onIconsResolved = vi.fn();

    await expect(
      hydrateSearchResultsWithCachedIcons([createAppResult('wps')], {
        appIconResolver,
        onIconsResolved,
      }),
    ).resolves.toEqual([
      {
        id: 'app.wps',
        score: 1,
        source: 'app',
        title: 'wps',
      },
    ]);

    expect(appIconResolver.resolveSearchResultIcon).toHaveBeenCalledOnce();
    expect(onIconsResolved).not.toHaveBeenCalled();

    resolveIcon?.({
      icon: 'data:image/png;base64,WPS',
      id: 'app.wps',
      score: 1,
      source: 'app',
      title: 'wps',
    });

    await vi.waitFor(() => {
      expect(onIconsResolved).toHaveBeenCalledWith([
        {
          icon: 'data:image/png;base64,WPS',
          id: 'app.wps',
          score: 1,
          source: 'app',
          title: 'wps',
        },
      ]);
    });
  });

  it('logs background icon resolution failures without failing search results', async () => {
    const logger = { warn: vi.fn() };
    const iconError = new Error('icon unavailable');
    const appIconResolver = {
      resolveCachedSearchResultIcon: vi.fn(async (result: LauncherCommandSearchResult) => result),
      resolveSearchResultIcon: vi.fn(async () => {
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
      expect(logger.warn).toHaveBeenCalledWith('Failed to resolve search result icons.', iconError);
    });
  });

  it('does not emit updates for non-app results or non-image icons', async () => {
    const onIconsResolved = vi.fn();
    const systemResult: LauncherCommandSearchResult = {
      id: 'system.settings',
      score: 1,
      source: 'system',
      title: 'Open Settings',
    };
    const appIconResolver = {
      resolveCachedSearchResultIcon: vi.fn(async (result: LauncherCommandSearchResult) => result),
      resolveSearchResultIcon: vi.fn(async (result: LauncherCommandSearchResult) => ({
        ...result,
        icon: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
      })),
    };

    await hydrateSearchResultsWithCachedIcons([systemResult, createAppResult('wps')], {
      appIconResolver,
      onIconsResolved,
    });

    await vi.waitFor(() => {
      expect(appIconResolver.resolveSearchResultIcon).toHaveBeenCalledOnce();
    });
    expect(onIconsResolved).not.toHaveBeenCalled();
  });
});
