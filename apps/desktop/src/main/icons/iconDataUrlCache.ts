import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CACHE_VERSION = 2;
const DEFAULT_MAX_ENTRIES = 256;

export interface IconDataUrlCache {
  read: (key: string) => Promise<string | undefined>;
  write: (key: string, dataUrl: string) => Promise<void>;
}

export interface IconDataUrlCacheOptions {
  cacheFilePath: string;
  clock?: (() => Date) | undefined;
  logger?: Pick<Console, 'warn'> | undefined;
  maxEntries?: number | undefined;
}

interface CachedIconEntry {
  cachedAt: string;
  dataUrl: string;
}

interface IconDataUrlCacheFile {
  entries: Record<string, CachedIconEntry>;
  version: typeof CACHE_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/');
}

function parseCacheFile(value: unknown): Map<string, CachedIconEntry> {
  if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.entries)) {
    return new Map();
  }

  const entries = new Map<string, CachedIconEntry>();

  for (const [key, entry] of Object.entries(value.entries)) {
    if (!isRecord(entry) || !isImageDataUrl(entry.dataUrl) || typeof entry.cachedAt !== 'string') {
      continue;
    }

    entries.set(key, {
      cachedAt: entry.cachedAt,
      dataUrl: entry.dataUrl,
    });
  }

  return entries;
}

async function readCacheFile({
  cacheFilePath,
  logger,
}: {
  cacheFilePath: string;
  logger?: Pick<Console, 'warn'> | undefined;
}): Promise<Map<string, CachedIconEntry>> {
  try {
    return parseCacheFile(JSON.parse(await readFile(cacheFilePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn('Failed to read app icon cache.', error);
    }

    return new Map();
  }
}

function trimEntries(entries: Map<string, CachedIconEntry>, maxEntries: number): void {
  if (entries.size <= maxEntries) {
    return;
  }

  const sortedEntries = [...entries.entries()].sort((left, right) =>
    left[1].cachedAt.localeCompare(right[1].cachedAt),
  );
  const entriesToDelete = entries.size - maxEntries;

  for (let index = 0; index < entriesToDelete; index += 1) {
    const entry = sortedEntries[index];

    if (entry !== undefined) {
      entries.delete(entry[0]);
    }
  }
}

async function writeCacheFile({
  cacheFilePath,
  entries,
}: {
  cacheFilePath: string;
  entries: Map<string, CachedIconEntry>;
}): Promise<void> {
  const snapshot: IconDataUrlCacheFile = {
    entries: Object.fromEntries(entries),
    version: CACHE_VERSION,
  };

  await mkdir(dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export function createIconDataUrlCache({
  cacheFilePath,
  clock = () => new Date(),
  logger,
  maxEntries = DEFAULT_MAX_ENTRIES,
}: IconDataUrlCacheOptions): IconDataUrlCache {
  let entriesPromise: Promise<Map<string, CachedIconEntry>> | undefined;

  async function getEntries(): Promise<Map<string, CachedIconEntry>> {
    entriesPromise ??= readCacheFile({
      cacheFilePath,
      logger,
    });

    return entriesPromise;
  }

  return {
    read: async (key) => {
      const entries = await getEntries();

      return entries.get(key)?.dataUrl;
    },
    write: async (key, dataUrl) => {
      if (!isImageDataUrl(dataUrl)) {
        return;
      }

      const entries = await getEntries();

      entries.set(key, {
        cachedAt: clock().toISOString(),
        dataUrl,
      });
      trimEntries(entries, maxEntries);
      await writeCacheFile({
        cacheFilePath,
        entries,
      });
    },
  };
}
