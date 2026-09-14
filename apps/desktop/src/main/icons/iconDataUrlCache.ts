import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CACHE_VERSION = 2;
const DEFAULT_FLUSH_DELAY_MS = 500;
const DEFAULT_FLUSH_MAX_WAIT_MS = 1_500;
const DEFAULT_MAX_ENTRIES = 256;
let temporaryFileSequence = 0;

export interface IconDataUrlCache {
  read: (key: string) => Promise<string | undefined>;
  write: (key: string, dataUrl: string) => Promise<void>;
}

export interface IconDataUrlCacheOptions {
  cacheFilePath: string;
  cancelFlush?: ((handle: unknown) => void) | undefined;
  clock?: (() => Date) | undefined;
  flushDelayMs?: number | undefined;
  flushMaxWaitMs?: number | undefined;
  logger?: Pick<Console, 'warn'> | undefined;
  maxEntries?: number | undefined;
  scheduleFlush?: ((callback: () => void, delayMs: number) => unknown) | undefined;
}

function defaultScheduleFlush(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultCancelFlush(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
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
  const temporaryFilePath = `${cacheFilePath}.${process.pid}.${temporaryFileSequence++}.tmp`;

  await mkdir(dirname(cacheFilePath), { recursive: true });
  try {
    await writeFile(temporaryFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(temporaryFilePath, cacheFilePath);
  } catch (error) {
    await rm(temporaryFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createIconDataUrlCache({
  cacheFilePath,
  cancelFlush = defaultCancelFlush,
  clock = () => new Date(),
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  flushMaxWaitMs = DEFAULT_FLUSH_MAX_WAIT_MS,
  logger,
  maxEntries = DEFAULT_MAX_ENTRIES,
  scheduleFlush = defaultScheduleFlush,
}: IconDataUrlCacheOptions): IconDataUrlCache {
  let entriesPromise: Promise<Map<string, CachedIconEntry>> | undefined;
  let firstDirtyAt: number | undefined;
  let flushQueue = Promise.resolve();
  let flushTimer: unknown | undefined;
  let isDirty = false;

  async function getEntries(): Promise<Map<string, CachedIconEntry>> {
    entriesPromise ??= readCacheFile({
      cacheFilePath,
      logger,
    });

    return entriesPromise;
  }

  async function flushEntries(): Promise<void> {
    if (!isDirty) {
      return;
    }

    isDirty = false;

    try {
      const entries = await getEntries();
      await writeCacheFile({
        cacheFilePath,
        entries,
      });
    } catch (error) {
      logger?.warn('Failed to write app icon cache.', error);
    }
  }

  function queueFlush(): void {
    flushQueue = flushQueue.then(() => flushEntries()).catch(() => undefined);
  }

  function scheduleFlushOnce(delayMs: number): void {
    if (flushTimer !== undefined) {
      cancelFlush(flushTimer);
      flushTimer = undefined;
    }

    flushTimer = scheduleFlush(() => {
      flushTimer = undefined;
      queueFlush();
    }, delayMs);
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
      isDirty = true;

      const now = clock().getTime();

      if (firstDirtyAt === undefined) {
        firstDirtyAt = now;
        scheduleFlushOnce(flushDelayMs);
      } else if (now - firstDirtyAt >= flushMaxWaitMs) {
        firstDirtyAt = undefined;
        scheduleFlushOnce(0);
      } else {
        scheduleFlushOnce(flushDelayMs);
      }
    },
  };
}
