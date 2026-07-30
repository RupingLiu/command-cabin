import { describe, expect, it } from 'vitest';

import {
  createCommandRegistry,
  createPluginRepository,
  createPluginRuntime,
  openInMemoryCommandCabinDatabase,
  runMigrations,
  type PluginInspection,
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

  it('inspects and records third-party plugins without executing them in safe mode', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      const runtime = createPluginRuntime({
        commandRegistry: createCommandRegistry(),
        moduleLoader: () => {
          throw new Error('plugin code must not execute');
        },
      });
      const inspection: PluginInspection = {
        mainPath: 'C:\\Plugins\\Echo\\dist\\main.js',
        manifest: {
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
        },
        pluginRoot: 'C:\\Plugins\\Echo',
      };
      const service = createDesktopPluginService({
        allowUnsafePluginExecution: false,
        inspectPlugin: async () => inspection,
        repository,
        runtime,
      });

      await expect(service.installPlugin('C:\\Plugins\\Echo')).resolves.toMatchObject({
        enabled: false,
        id: 'com.example.echo',
        pluginRoot: 'C:\\Plugins\\Echo',
      });
      expect(runtime.listPlugins()).toEqual([]);
      await expect(service.setPluginEnabled('com.example.echo', true)).rejects.toThrow(
        /isolated plugin runtime/,
      );
    } finally {
      database.close();
    }
  });

  it('disables persisted enabled plugins without loading their code in safe mode', async () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      runMigrations(database);
      const repository = createPluginRepository(database);
      repository.upsertPlugin({
        id: 'com.example.echo',
        name: 'Echo Plugin',
        version: '0.1.0',
        description: 'Echoes a test command',
        main: 'dist/main.js',
        pluginRoot: 'C:\\Plugins\\Echo',
        enabled: true,
        permissions: [],
      });
      const runtime = createPluginRuntime({
        commandRegistry: createCommandRegistry(),
        moduleLoader: () => {
          throw new Error('plugin code must not execute');
        },
      });
      const service = createDesktopPluginService({
        allowUnsafePluginExecution: false,
        repository,
        runtime,
      });

      await service.loadEnabledPlugins();

      expect(repository.getPlugin('com.example.echo')?.enabled).toBe(false);
      expect(runtime.listPlugins()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
