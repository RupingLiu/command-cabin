import type { PluginRecord, PluginRepository, PluginRuntime } from '@command-cabin/core';

export interface DesktopPluginService {
  installPlugin: (pluginRoot: string) => Promise<PluginRecord>;
  listPlugins: () => PluginRecord[];
  loadEnabledPlugins: () => Promise<void>;
  removePlugin: (id: string) => Promise<boolean>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<PluginRecord | undefined>;
}

export interface DesktopPluginServiceOptions {
  onPluginLoadError?: (plugin: PluginRecord, error: unknown) => void;
  repository: PluginRepository;
  runtime: PluginRuntime;
}

function normalizePluginRoot(pluginRoot: string): string {
  const normalizedPluginRoot = pluginRoot.trim();

  if (normalizedPluginRoot.length === 0) {
    throw new Error('Plugin folder path must be a non-empty string.');
  }

  return normalizedPluginRoot;
}

function formatRuntimeErrorMessage(prefix: string, message: string): string {
  return `${prefix}: ${message}`;
}

export function createDesktopPluginService(
  options: DesktopPluginServiceOptions,
): DesktopPluginService {
  async function enablePluginRoot(pluginRoot: string): Promise<PluginRecord> {
    const normalizedPluginRoot = normalizePluginRoot(pluginRoot);
    const enableResult = await options.runtime.enablePlugin(normalizedPluginRoot);

    if (!enableResult.ok) {
      throw new Error(
        formatRuntimeErrorMessage('Plugin could not be enabled', enableResult.error.message),
      );
    }

    const { manifest } = enableResult.value;

    return options.repository.upsertPlugin({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      main: manifest.main,
      pluginRoot: normalizedPluginRoot,
      enabled: true,
      permissions: manifest.permissions,
      ...(manifest.ui === undefined ? {} : { ui: manifest.ui }),
    });
  }

  return {
    installPlugin: (pluginRoot) => enablePluginRoot(pluginRoot),
    listPlugins: () => options.repository.listPlugins(),
    loadEnabledPlugins: async () => {
      for (const plugin of options.repository.listPlugins()) {
        if (!plugin.enabled || plugin.pluginRoot === undefined) {
          continue;
        }

        try {
          await enablePluginRoot(plugin.pluginRoot);
        } catch (error) {
          options.repository.setPluginEnabled(plugin.id, false);
          options.onPluginLoadError?.(plugin, error);
        }
      }
    },
    removePlugin: async (id) => {
      const plugin = options.repository.getPlugin(id);

      if (!plugin) {
        return false;
      }

      if (options.runtime.getPlugin(id)?.status === 'enabled') {
        await options.runtime.disablePlugin(id);
      }

      return options.repository.removePlugin(id);
    },
    setPluginEnabled: async (id, enabled) => {
      const plugin = options.repository.getPlugin(id);

      if (!plugin) {
        return undefined;
      }

      if (!enabled) {
        if (options.runtime.getPlugin(id) !== undefined) {
          await options.runtime.disablePlugin(id);
        }

        return options.repository.setPluginEnabled(id, false);
      }

      if (plugin.pluginRoot === undefined) {
        throw new Error(`Plugin "${id}" has no installed folder path.`);
      }

      return enablePluginRoot(plugin.pluginRoot);
    },
  };
}
