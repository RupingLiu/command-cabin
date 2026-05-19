import { mkdtemp, rm } from 'node:fs/promises';
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
});
