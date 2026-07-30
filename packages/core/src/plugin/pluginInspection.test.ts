import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectPluginDirectory } from './pluginInspection.js';

const temporaryPluginRoots: string[] = [];

async function createPluginDirectory({
  mainSource = 'throw new Error("must not execute during inspection");',
  manifest = {
    id: 'com.example.safe-inspection',
    name: 'Safe inspection',
    version: '1.0.0',
    description: 'Validates a plugin without executing it.',
    main: 'main.js',
    permissions: [],
    commands: [],
  },
}: {
  mainSource?: string;
  manifest?: unknown;
} = {}): Promise<string> {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'command-cabin-plugin-inspection-'));
  temporaryPluginRoots.push(pluginRoot);
  await writeFile(join(pluginRoot, 'plugin.json'), JSON.stringify(manifest), 'utf8');
  await writeFile(join(pluginRoot, 'main.js'), mainSource, 'utf8');
  return pluginRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryPluginRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('inspectPluginDirectory', () => {
  it('validates and resolves a plugin without executing its main module', async () => {
    const pluginRoot = await createPluginDirectory();
    const mainPath = await realpath(join(pluginRoot, 'main.js'));

    await expect(inspectPluginDirectory(pluginRoot)).resolves.toMatchObject({
      mainPath,
      manifest: {
        id: 'com.example.safe-inspection',
        version: '1.0.0',
      },
      pluginRoot,
    });
  });

  it('rejects a missing main entry file', async () => {
    const pluginRoot = await createPluginDirectory({
      manifest: {
        id: 'com.example.missing-entry',
        name: 'Missing entry',
        version: '1.0.0',
        description: 'The main file is absent.',
        main: 'missing.js',
        permissions: [],
        commands: [],
      },
    });

    await expect(inspectPluginDirectory(pluginRoot)).rejects.toThrow(
      'Plugin main entry file must exist inside the plugin folder.',
    );
  });

  it('rejects an invalid manifest before resolving entry files', async () => {
    const pluginRoot = await createPluginDirectory({ manifest: {} });

    await expect(inspectPluginDirectory(pluginRoot)).rejects.toThrow(
      'Plugin manifest is invalid: id: Plugin ID is required.',
    );
  });
});
