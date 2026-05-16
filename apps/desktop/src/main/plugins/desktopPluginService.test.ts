import { describe, expect, it } from 'vitest';

import {
  createCommandRegistry,
  createPluginRepository,
  createPluginRuntime,
  openInMemoryCommandCabinDatabase,
  runMigrations,
} from '@command-cabin/core';

import { createDesktopPluginService } from './desktopPluginService.js';

describe('desktop plugin service', () => {
  it('installs, enables, disables, and removes a local plugin through the runtime', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      const registry = createCommandRegistry();
      const runtime = createPluginRuntime({
        commandRegistry: registry,
        readManifest: () => ({
          id: 'com.example.echo',
          name: 'Echo Plugin',
          version: '0.1.0',
          description: 'Echoes a test command',
          main: 'dist/main.js',
          permissions: [],
          commands: [
            {
              id: 'ping',
              title: 'Ping Plugin',
              keywords: ['ping'],
            },
          ],
        }),
        resolveMainPath: () => ({
          ok: true,
          path: 'C:\\Plugins\\Echo\\dist\\main.js',
        }),
        moduleLoader: () => ({
          activate: () => undefined,
          deactivate: () => undefined,
          commands: {
            ping: () => ({
              metadata: {
                pong: true,
              },
            }),
          },
        }),
      });
      const service = createDesktopPluginService({ repository, runtime });

      await expect(service.installPlugin('C:\\Plugins\\Echo')).resolves.toMatchObject({
        enabled: true,
        id: 'com.example.echo',
        main: 'dist/main.js',
        name: 'Echo Plugin',
        pluginRoot: 'C:\\Plugins\\Echo',
      });
      expect(registry.get('com.example.echo.ping')).toBeDefined();

      await expect(service.setPluginEnabled('com.example.echo', false)).resolves.toMatchObject({
        enabled: false,
        id: 'com.example.echo',
      });
      expect(registry.get('com.example.echo.ping')).toBeUndefined();

      await expect(service.setPluginEnabled('com.example.echo', true)).resolves.toMatchObject({
        enabled: true,
        id: 'com.example.echo',
      });
      expect(registry.get('com.example.echo.ping')).toBeDefined();

      await expect(service.removePlugin('com.example.echo')).resolves.toBe(true);
      expect(repository.getPlugin('com.example.echo')).toBeUndefined();
      expect(registry.get('com.example.echo.ping')).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
