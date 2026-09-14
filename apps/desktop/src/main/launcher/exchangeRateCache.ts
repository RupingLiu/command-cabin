import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const FRANKFURTER_USD_CNY_ENDPOINT = 'https://api.frankfurter.dev/v2/rate/USD/CNY';
const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface ExchangeRateFetchResponse {
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
}

export type ExchangeRateFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<ExchangeRateFetchResponse>;

export interface UsdToCnyExchangeRate {
  fetchedAt: string;
  provider: string;
  rate: number;
  source: 'cache' | 'live';
  updatedAt: string;
}

export interface ExchangeRateCache {
  getUsdToCnyRate: () => Promise<UsdToCnyExchangeRate | undefined>;
}

export interface ExchangeRateCacheOptions {
  cacheFilePath: string;
  fetch?: ExchangeRateFetch | undefined;
  logger?: Pick<Console, 'warn'> | undefined;
  timeoutMs?: number | undefined;
  ttlMs?: number | undefined;
  clock?: (() => Date) | undefined;
}

interface CachedUsdToCnyExchangeRate {
  fetchedAt: string;
  provider: string;
  rate: number;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseCachedRate(value: unknown): CachedUsdToCnyExchangeRate | undefined {
  if (!isRecord(value) || !isPositiveFiniteNumber(value.rate)) {
    return undefined;
  }

  const fetchedAt = readStringField(value, 'fetchedAt');
  const provider = readStringField(value, 'provider');
  const updatedAt = readStringField(value, 'updatedAt');

  if (fetchedAt === undefined || provider === undefined || updatedAt === undefined) {
    return undefined;
  }

  return {
    fetchedAt,
    provider,
    rate: value.rate,
    updatedAt,
  };
}

function parseFrankfurterRate(value: unknown): CachedUsdToCnyExchangeRate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const base = readStringField(value, 'base')?.toUpperCase();
  const quote = readStringField(value, 'quote')?.toUpperCase();
  const updatedAt = readStringField(value, 'date');
  const rate =
    quote === 'CNY' && isPositiveFiniteNumber(value.rate) ? value.rate : readNestedCnyRate(value);

  if (base !== 'USD' || updatedAt === undefined || !isPositiveFiniteNumber(rate)) {
    return undefined;
  }

  return {
    fetchedAt: new Date().toISOString(),
    provider: 'Frankfurter',
    rate,
    updatedAt,
  };
}

function readNestedCnyRate(value: Record<string, unknown>): number | undefined {
  const rates = value.rates;

  if (!isRecord(rates) || !isPositiveFiniteNumber(rates.CNY)) {
    return undefined;
  }

  return rates.CNY;
}

async function readCacheFile(
  cacheFilePath: string,
  logger: ExchangeRateCacheOptions['logger'],
): Promise<CachedUsdToCnyExchangeRate | undefined> {
  try {
    return parseCachedRate(JSON.parse(await readFile(cacheFilePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn('Exchange rate cache read failed.', error);
    }

    return undefined;
  }
}

async function writeCacheFile(
  cacheFilePath: string,
  rate: CachedUsdToCnyExchangeRate,
): Promise<void> {
  await mkdir(dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, `${JSON.stringify(rate, null, 2)}\n`);
}

function toResult(
  rate: CachedUsdToCnyExchangeRate,
  source: UsdToCnyExchangeRate['source'],
): UsdToCnyExchangeRate {
  return {
    ...rate,
    source,
  };
}

async function fetchLiveRate({
  fetchRate,
  timeoutMs,
}: {
  fetchRate: ExchangeRateFetch;
  timeoutMs: number;
}): Promise<CachedUsdToCnyExchangeRate | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchRate(FRANKFURTER_USD_CNY_ENDPOINT, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return undefined;
    }

    return parseFrankfurterRate(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function isFresh(rate: CachedUsdToCnyExchangeRate, ttlMs: number, clock: () => Date): boolean {
  const fetchedAtTime = Date.parse(rate.fetchedAt);

  return !Number.isNaN(fetchedAtTime) && clock().getTime() - fetchedAtTime < ttlMs;
}

export function createExchangeRateCache({
  cacheFilePath,
  fetch: fetchRate = globalThis.fetch as ExchangeRateFetch,
  logger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  clock = () => new Date(),
}: ExchangeRateCacheOptions): ExchangeRateCache {
  let cachedRatePromise: Promise<CachedUsdToCnyExchangeRate | undefined> | undefined;
  let refreshInFlight: Promise<CachedUsdToCnyExchangeRate | undefined> | undefined;

  async function getCachedRate(): Promise<CachedUsdToCnyExchangeRate | undefined> {
    cachedRatePromise ??= readCacheFile(cacheFilePath, logger);

    return cachedRatePromise;
  }

  async function refreshRate(): Promise<CachedUsdToCnyExchangeRate | undefined> {
    refreshInFlight ??= (async () => {
      try {
        const liveRate = await fetchLiveRate({
          fetchRate,
          timeoutMs,
        });

        if (liveRate !== undefined) {
          await writeCacheFile(cacheFilePath, liveRate);
          cachedRatePromise = Promise.resolve(liveRate);

          return liveRate;
        }

        return undefined;
      } catch (error) {
        logger?.warn('Exchange rate refresh failed.', error);

        return undefined;
      }
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = undefined;
    }
  }

  return {
    getUsdToCnyRate: async () => {
      const cachedRate = await getCachedRate();

      if (cachedRate !== undefined && isFresh(cachedRate, ttlMs, clock)) {
        return toResult(cachedRate, 'cache');
      }

      if (cachedRate !== undefined) {
        void refreshRate();

        return toResult(cachedRate, 'cache');
      }

      const liveRate = await refreshRate();

      return liveRate === undefined ? undefined : toResult(liveRate, 'live');
    },
  };
}
