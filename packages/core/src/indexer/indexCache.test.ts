import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIndexCache } from './indexCache.js';

const VALID_CACHED_COMMAND = {
  id: 'app.notepad',
  source: 'app',
  title: 'Notepad',
  subtitle: 'C:\\Windows\\System32\\notepad.exe',
  keywords: ['notepad'],
  action: {
    type: 'open-app',
    payload: {
      executablePath: 'C:\\Windows\\System32\\notepad.exe',
    },
  },
};

function createCacheWithContents(contents: string) {
  return createIndexCache({
    cacheFilePath: 'apps.json',
    fileSystem: {
      readFile: async () => contents,
      writeFile: async () => undefined,
      makeDirectory: async () => undefined,
    },
  });
}

function createCachedSnapshot(command: unknown): string {
  return JSON.stringify({
    version: 2,
    scannedAt: '2026-05-16T01:00:00.000Z',
    commands: [command],
  });
}

describe('app index cache', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes and reads command snapshots from a local JSON cache file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'command-cabin-app-cache-'));
    tempDirectories.push(directory);
    const cache = createIndexCache({
      cacheFilePath: join(directory, 'nested', 'apps.json'),
      now: () => new Date('2026-05-16T01:00:00.000Z'),
    });

    await cache.write([
      {
        id: 'app.notepad',
        source: 'app',
        title: 'Notepad',
        subtitle: 'C:\\Windows\\System32\\notepad.exe',
        keywords: ['notepad'],
        action: {
          type: 'open-app',
          payload: {
            executablePath: 'C:\\Windows\\System32\\notepad.exe',
          },
        },
      },
    ]);

    const snapshot = await cache.read();

    expect(snapshot).toEqual({
      version: 2,
      scannedAt: '2026-05-16T01:00:00.000Z',
      commands: [
        {
          id: 'app.notepad',
          source: 'app',
          title: 'Notepad',
          subtitle: 'C:\\Windows\\System32\\notepad.exe',
          keywords: ['notepad'],
          action: {
            type: 'open-app',
            payload: {
              executablePath: 'C:\\Windows\\System32\\notepad.exe',
            },
          },
        },
      ],
    });
  });

  it('reports missing cache files as empty snapshots', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'command-cabin-app-cache-'));
    tempDirectories.push(directory);
    const cache = createIndexCache({
      cacheFilePath: join(directory, 'missing.json'),
    });

    await expect(cache.read()).resolves.toBeUndefined();
  });

  it('detects stale snapshots from the configured cache age', async () => {
    const cache = createIndexCache({
      cacheFilePath: 'unused.json',
      maxAgeMs: 60_000,
      now: () => new Date('2026-05-16T01:02:00.000Z'),
    });

    expect(
      cache.isStale({
        version: 2,
        scannedAt: '2026-05-16T01:00:59.999Z',
        commands: [],
      }),
    ).toBe(true);
    expect(
      cache.isStale({
        version: 2,
        scannedAt: '2026-05-16T01:01:00.000Z',
        commands: [],
      }),
    ).toBe(false);
  });

  it('rejects legacy cache versions so scanner capability changes rebuild the index', async () => {
    const cache = createCacheWithContents(
      JSON.stringify({
        version: 1,
        scannedAt: '2026-05-16T01:00:00.000Z',
        commands: [VALID_CACHED_COMMAND],
      }),
    );

    await expect(cache.read()).rejects.toThrow('version must be 2');
  });

  it.each([
    [
      'bad source',
      {
        ...VALID_CACHED_COMMAND,
        source: 'favorite',
      },
      /commands\[0\]\.source must be "app"/,
    ],
    [
      'plugin source',
      {
        ...VALID_CACHED_COMMAND,
        source: 'plugin',
        pluginId: 'plugin.notes',
        action: {
          type: 'run-plugin',
          payload: {},
        },
      },
      /commands\[0\]\.source must be "app"/,
    ],
    [
      'system source',
      {
        ...VALID_CACHED_COMMAND,
        source: 'system',
        action: {
          type: 'run-system',
          payload: {},
        },
      },
      /commands\[0\]\.source must be "app"/,
    ],
    [
      'bad action',
      {
        ...VALID_CACHED_COMMAND,
        action: {
          type: 'delete-app',
          payload: {},
        },
      },
      /commands\[0\]\.action\.type must be one of/,
    ],
    [
      'unsupported app-index action',
      {
        ...VALID_CACHED_COMMAND,
        action: {
          type: 'open-url',
          payload: {},
        },
      },
      /commands\[0\]\.action\.type must be one of/,
    ],
    [
      'non-string fields',
      {
        ...VALID_CACHED_COMMAND,
        title: 42,
      },
      /commands\[0\]\.title must be a string/,
    ],
    [
      'non-string keywords',
      {
        ...VALID_CACHED_COMMAND,
        keywords: ['notepad', 42],
      },
      /commands\[0\]\.keywords\[1\] must be a string/,
    ],
    [
      'non-string optional fields',
      {
        ...VALID_CACHED_COMMAND,
        icon: 42,
      },
      /commands\[0\]\.icon must be a string/,
    ],
  ])('rejects cached command records with %s', async (_name, command, expectedError) => {
    const cache = createCacheWithContents(createCachedSnapshot(command));

    await expect(cache.read()).rejects.toThrow(expectedError);
  });
});
