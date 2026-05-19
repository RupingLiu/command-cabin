import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';
import type { AppIconResolver } from './appIconResolver.js';

export interface SearchResultIconHydrationOptions {
  appIconResolver: Pick<AppIconResolver, 'resolveCachedSearchResultIcon' | 'warmSearchResultIcon'>;
  logger?: Pick<Console, 'warn'> | undefined;
}

export async function hydrateSearchResultsWithCachedIcons(
  results: readonly LauncherCommandSearchResult[],
  { appIconResolver, logger = console }: SearchResultIconHydrationOptions,
): Promise<LauncherCommandSearchResult[]> {
  const publicResults = await Promise.all(
    results.map((result) => appIconResolver.resolveCachedSearchResultIcon(result)),
  );

  void Promise.all(results.map((result) => appIconResolver.warmSearchResultIcon(result))).catch(
    (error: unknown) => {
      logger.warn('Failed to warm search result icons.', error);
    },
  );

  return publicResults;
}
