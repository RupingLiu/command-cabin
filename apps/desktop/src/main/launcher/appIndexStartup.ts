import type { AppIndexer } from '@command-cabin/core';

export interface StartAppIndexingOptions {
  indexer: AppIndexer;
  logger: Pick<Console, 'error'>;
}

export async function startAppIndexing({
  indexer,
  logger,
}: StartAppIndexingOptions): Promise<void> {
  indexer.startAutoRefresh();

  try {
    if (!(await indexer.load())) {
      await indexer.refresh();
    }
  } catch (error) {
    logger.error('Initial app indexing failed.', error);
  }
}
