import { mkdtemp, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

describe('createIconDataUrlCache', () => {
  it('persists resolved icons across cache instances', async () => {
    const directory = await createTempDirectory();
    const cacheFilePath = join(directory, 'app-icons.json');

    await createIconDataUrlCache({ cacheFilePath }).write(
      'app-result:app.codex:abc123',
      'data:image/png;base64,CODEX',
    );

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
    const cache = createIconDataUrlCache({ cacheFilePath });

    await Promise.all([
      cache.write('first', 'data:image/png;base64,FIRST'),
      cache.write('second', 'data:image/png;base64,SECOND'),
    ]);

    const reloadedCache = createIconDataUrlCache({ cacheFilePath });
    await expect(reloadedCache.read('first')).resolves.toBe('data:image/png;base64,FIRST');
    await expect(reloadedCache.read('second')).resolves.toBe('data:image/png;base64,SECOND');
  });
});
