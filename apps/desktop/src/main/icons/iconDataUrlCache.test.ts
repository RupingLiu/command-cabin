import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIconDataUrlCache } from './iconDataUrlCache.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  );
  tempDirectories.length = 0;
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'command-cabin-icon-cache-'));
  tempDirectories.push(directory);

  return directory;
}

interface FakeFlushScheduler {
  cancelFlush: ReturnType<typeof vi.fn>;
  fire: (handle: unknown) => void;
  latestHandle: () => unknown | undefined;
  scheduleFlush: ReturnType<typeof vi.fn>;
  scheduledDelays: () => number[];
  scheduledHandles: () => unknown[];
}

function createFakeFlushScheduler(): FakeFlushScheduler {
  const scheduled = new Map<unknown, { callback: () => void; delayMs: number }>();
  let nextHandle = 1;

  const scheduleFlush = vi.fn((callback: () => void, delayMs: number) => {
    const handle = nextHandle;
    nextHandle += 1;
    scheduled.set(handle, { callback, delayMs });

    return handle;
  });
  const cancelFlush = vi.fn((handle: unknown) => {
    scheduled.delete(handle);
  });

  return {
    cancelFlush,
    fire: (handle: unknown) => {
      const entry = scheduled.get(handle);
      scheduled.delete(handle);
      entry?.callback();
    },
    latestHandle: () => [...scheduled.keys()].pop(),
    scheduleFlush,
    scheduledDelays: () => [...scheduled.values()].map((entry) => entry.delayMs),
    scheduledHandles: () => [...scheduled.keys()],
  };
}

async function expectCacheFileToContain(cacheFilePath: string, fragment: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await readFile(cacheFilePath, 'utf8')).toContain(fragment);
  });
}

describe('createIconDataUrlCache', () => {
  it('persists resolved icons across cache instances', async () => {
    const directory = await createTempDirectory();
    const cacheFilePath = join(directory, 'app-icons.json');
    const scheduler = createFakeFlushScheduler();
    const cache = createIconDataUrlCache({ cacheFilePath, ...scheduler });

    await cache.write('app-result:app.codex:abc123', 'data:image/png;base64,CODEX');

    const handle = scheduler.latestHandle();
    expect(handle).toBeDefined();
    scheduler.fire(handle);
    await expectCacheFileToContain(cacheFilePath, 'data:image/png;base64,CODEX');

    await expect(
      createIconDataUrlCache({ cacheFilePath }).read('app-result:app.codex:abc123'),
    ).resolves.toBe('data:image/png;base64,CODEX');
  });

  it('ignores v1 caches that may contain generic shell fallback icons', async () => {
    const directory = await createTempDirectory();
    const cacheFilePath = join(directory, 'app-icons.json');

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        version: 1,
        entries: {
          'app-result:app.codex:abc123': {
            cachedAt: '2026-05-19T09:49:37.487Z',
            dataUrl: 'data:image/png;base64,GENERIC',
          },
        },
      }),
      'utf8',
    );

    await expect(
      createIconDataUrlCache({ cacheFilePath }).read('app-result:app.codex:abc123'),
    ).resolves.toBeUndefined();
  });

  it('serializes concurrent writes without losing cache entries', async () => {
    const directory = await createTempDirectory();
    const cacheFilePath = join(directory, 'app-icons.json');
    const scheduler = createFakeFlushScheduler();
    const cache = createIconDataUrlCache({ cacheFilePath, ...scheduler });

    await Promise.all([
      cache.write('first', 'data:image/png;base64,FIRST'),
      cache.write('second', 'data:image/png;base64,SECOND'),
    ]);

    const handle = scheduler.latestHandle();
    expect(handle).toBeDefined();
    scheduler.fire(handle);
    await expectCacheFileToContain(cacheFilePath, 'data:image/png;base64,SECOND');

    const reloadedCache = createIconDataUrlCache({ cacheFilePath });
    await expect(reloadedCache.read('first')).resolves.toBe('data:image/png;base64,FIRST');
    await expect(reloadedCache.read('second')).resolves.toBe('data:image/png;base64,SECOND');
  });

  it('coalesces consecutive writes into a single file write', async () => {
    const directory = await createTempDirectory();
    const cacheFilePath = join(directory, 'app-icons.json');
    const scheduler = createFakeFlushScheduler();
    const cache = createIconDataUrlCache({ cacheFilePath, ...scheduler });

    await cache.write('first', 'data:image/png;base64,FIRST');
    await cache.write('second', 'data:image/png;base64,SECOND');
    await cache.write('third', 'data:image/png;base64,THIRD');

    // Each write reschedules the debounced flush, leaving exactly one pending.
    expect(scheduler.scheduleFlush).toHaveBeenCalledTimes(3);
    expect(scheduler.cancelFlush).toHaveBeenCalledTimes(2);
    expect(scheduler.scheduledHandles()).toHaveLength(1);

    scheduler.fire(scheduler.latestHandle());
    await expectCacheFileToContain(cacheFilePath, 'data:image/png;base64,THIRD');

    const reloadedCache = createIconDataUrlCache({ cacheFilePath });
    await expect(reloadedCache.read('first')).resolves.toBe('data:image/png;base64,FIRST');
    await expect(reloadedCache.read('second')).resolves.toBe('data:image/png;base64,SECOND');
    await expect(reloadedCache.read('third')).resolves.toBe('data:image/png;base64,THIRD');
  });

  it('makes written values visible to reads before the flush lands', async () => {
    const directory = await createTempDirectory();
    const cacheFilePath = join(directory, 'app-icons.json');
    const cache = createIconDataUrlCache({ cacheFilePath });

    await cache.write('app-result:app.codex:abc123', 'data:image/png;base64,CODEX');

    await expect(cache.read('app-result:app.codex:abc123')).resolves.toBe(
      'data:image/png;base64,CODEX',
    );
  });

  it('flushes without further delay when the max wait is exceeded', async () => {
    let now = new Date('2026-05-19T09:49:37.000Z');
    const directory = await createTempDirectory();
    const cacheFilePath = join(directory, 'app-icons.json');
    const scheduler = createFakeFlushScheduler();
    const cache = createIconDataUrlCache({
      cacheFilePath,
      clock: () => now,
      flushDelayMs: 500,
      flushMaxWaitMs: 1_500,
      ...scheduler,
    });

    await cache.write('first', 'data:image/png;base64,FIRST');
    now = new Date(now.getTime() + 1_600);
    await cache.write('second', 'data:image/png;base64,SECOND');

    expect(scheduler.scheduledDelays()).toEqual([0]);

    scheduler.fire(scheduler.latestHandle());
    await expectCacheFileToContain(cacheFilePath, 'data:image/png;base64,SECOND');

    const reloadedCache = createIconDataUrlCache({ cacheFilePath });
    await expect(reloadedCache.read('first')).resolves.toBe('data:image/png;base64,FIRST');
    await expect(reloadedCache.read('second')).resolves.toBe('data:image/png;base64,SECOND');
  });
});
