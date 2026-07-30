import {
  inspectPluginDirectory,
  type PluginInspection,
  type PluginRecord,
  type PluginRepository,
  type PluginRuntime,
} from '@command-cabin/core';

export interface DesktopPluginService {
  installPlugin: (pluginRoot: string) => Promise<PluginRecord>;
  listPlugins: () => PluginRecord[];
  loadEnabledPlugins: () => Promise<void>;
  removePlugin: (id: string) => Promise<boolean>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<PluginRecord | undefined>;
}

export interface DesktopPluginServiceOptions {
  allowUnsafePluginExecution?: boolean | undefined;
  inspectPlugin?: ((pluginRoot: string) => Promise<PluginInspection>) | undefined;
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
  const allowUnsafePluginExecution = options.allowUnsafePluginExecution ?? true;
  const inspectPlugin = options.inspectPlugin ?? inspectPluginDirectory;
  let operationQueue = Promise.resolve();

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function saveInspectedPlugin(inspection: PluginInspection): PluginRecord {
    const { manifest } = inspection;

    return options.repository.upsertPlugin({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      main: manifest.main,
      pluginRoot: inspection.pluginRoot,
      enabled: false,
      permissions: manifest.permissions,
      ...(manifest.ui === undefined ? {} : { ui: manifest.ui }),
    });
  }

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
    installPlugin: (pluginRoot) =>
      runExclusive(async () => {
        if (!allowUnsafePluginExecution) {
          return saveInspectedPlugin(await inspectPlugin(normalizePluginRoot(pluginRoot)));
        }

        return enablePluginRoot(pluginRoot);
      }),
    listPlugins: () => options.repository.listPlugins(),
    loadEnabledPlugins: () =>
      runExclusive(async () => {
        for (const plugin of options.repository.listPlugins()) {
          if (!plugin.enabled || plugin.pluginRoot === undefined) {
            continue;
          }

          if (!allowUnsafePluginExecution) {
            options.repository.setPluginEnabled(plugin.id, false);
            continue;
          }

          try {
            await enablePluginRoot(plugin.pluginRoot);
          } catch (error) {
            options.repository.setPluginEnabled(plugin.id, false);
            options.onPluginLoadError?.(plugin, error);
          }
        }
      }),
    removePlugin: (id) =>
      runExclusive(async () => {
        const plugin = options.repository.getPlugin(id);

        if (!plugin) {
          return false;
        }

        if (options.runtime.getPlugin(id)?.status === 'enabled') {
          await options.runtime.disablePlugin(id);
        }

        return options.repository.removePlugin(id);
      }),
    setPluginEnabled: (id, enabled) =>
      runExclusive(async () => {
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

        if (!allowUnsafePluginExecution) {
          throw new Error(
            'Third-party plugin execution is disabled until an isolated plugin runtime is available.',
          );
        }

        if (plugin.pluginRoot === undefined) {
          throw new Error(`Plugin "${id}" has no installed folder path.`);
        }

        return enablePluginRoot(plugin.pluginRoot);
      }),
  };
}
