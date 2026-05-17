import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createExchangeRateCache, type ExchangeRateFetch } from './exchangeRateCache.js';

async function createTempCacheFile(): Promise<{ cacheFilePath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'command-cabin-rate-'));

  return {
    cacheFilePath: join(root, 'exchange-rates.json'),
    root,
  };
}

function createJsonResponse(body: unknown, ok = true, status = 200) {
  return {
    json: async () => body,
    ok,
    status,
  };
}

describe('exchange rate cache', () => {
  it('fetches the live USD to CNY rate and writes it to cache', async () => {
    const { cacheFilePath, root } = await createTempCacheFile();

    try {
      const fetchRate = vi.fn<ExchangeRateFetch>(async () =>
        createJsonResponse({
          base: 'USD',
          date: '2026-05-18',
          quote: 'CNY',
          rate: 7.1234,
        }),
      );
      const cache = createExchangeRateCache({
        cacheFilePath,
        fetch: fetchRate,
      });

      await expect(cache.getUsdToCnyRate()).resolves.toMatchObject({
        provider: 'Frankfurter',
        rate: 7.1234,
        source: 'live',
        updatedAt: '2026-05-18',
      });
      await expect(readFile(cacheFilePath, 'utf8')).resolves.toContain('"rate": 7.1234');
      expect(fetchRate).toHaveBeenCalledWith(
        'https://api.frankfurter.dev/v2/rate/USD/CNY',
        expect.objectContaining({
          signal: expect.any(AbortSignal) as AbortSignal,
        }),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('returns the cached rate when the live request fails', async () => {
    const { cacheFilePath, root } = await createTempCacheFile();

    try {
      await writeFile(
        cacheFilePath,
        JSON.stringify({
          fetchedAt: '2026-05-17T12:00:00.000Z',
          provider: 'Frankfurter',
          rate: 7.1,
          updatedAt: '2026-05-17',
        }),
      );
      const cache = createExchangeRateCache({
        cacheFilePath,
        fetch: vi.fn<ExchangeRateFetch>(async () => {
          throw new Error('network unavailable');
        }),
      });

      await expect(cache.getUsdToCnyRate()).resolves.toEqual({
        fetchedAt: '2026-05-17T12:00:00.000Z',
        provider: 'Frankfurter',
        rate: 7.1,
        source: 'cache',
        updatedAt: '2026-05-17',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('returns undefined when neither live nor cached rates are available', async () => {
    const { cacheFilePath, root } = await createTempCacheFile();

    try {
      const cache = createExchangeRateCache({
        cacheFilePath,
        fetch: vi.fn<ExchangeRateFetch>(async () => createJsonResponse({}, false, 503)),
      });

      await expect(cache.getUsdToCnyRate()).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('uses the cached rate when the live request times out', async () => {
    const { cacheFilePath, root } = await createTempCacheFile();

    try {
      await writeFile(
        cacheFilePath,
        JSON.stringify({
          fetchedAt: '2026-05-17T12:00:00.000Z',
          provider: 'Frankfurter',
          rate: 7.1,
          updatedAt: '2026-05-17',
        }),
      );
      const cache = createExchangeRateCache({
        cacheFilePath,
        fetch: vi.fn<ExchangeRateFetch>(
          (_url, init) =>
            new Promise((resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
              setTimeout(() => {
                resolve(createJsonResponse({}));
              }, 25);
            }),
        ),
        timeoutMs: 1,
      });

      await expect(cache.getUsdToCnyRate()).resolves.toMatchObject({
        rate: 7.1,
        source: 'cache',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
