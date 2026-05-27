import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';
import type { AppIconResolver } from './appIconResolver.js';

export interface SearchResultIconHydrationOptions {
  appIconResolver: Pick<
    AppIconResolver,
    'resolveCachedSearchResultIcon' | 'resolveSearchResultIcon'
  >;
  logger?: Pick<Console, 'warn'> | undefined;
  onIconsResolved?: ((results: LauncherCommandSearchResult[]) => void) | undefined;
}

function isImageDataUrl(icon: string | undefined): icon is string {
  return typeof icon === 'string' && icon.startsWith('data:image/');
}

export async function hydrateSearchResultsWithCachedIcons(
  results: readonly LauncherCommandSearchResult[],
  { appIconResolver, logger = console, onIconsResolved }: SearchResultIconHydrationOptions,
): Promise<LauncherCommandSearchResult[]> {
  const publicResults = await Promise.all(
    results.map((result) => appIconResolver.resolveCachedSearchResultIcon(result)),
  );

  void Promise.allSettled(
    results
      .filter((result) => result.source === 'app')
      .map((result) => appIconResolver.resolveSearchResultIcon(result)),
  )
    .then((resolvedResults) => {
      const imageResults: LauncherCommandSearchResult[] = [];

      for (const resolvedResult of resolvedResults) {
        if (resolvedResult.status === 'rejected') {
          logger.warn('Failed to resolve search result icons.', resolvedResult.reason);
          continue;
        }

        if (isImageDataUrl(resolvedResult.value.icon)) {
          imageResults.push(resolvedResult.value);
        }
      }

      if (imageResults.length > 0) {
        onIconsResolved?.(imageResults);
      }
    })
    .catch((error: unknown) => {
      logger.warn('Failed to resolve search result icons.', error);
    });

  return publicResults;
}
