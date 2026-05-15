import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  CommandCabinPluginContext,
  PluginClipboardCapability,
} from '@command-cabin/plugin-api';

import { createCommandExecutor } from '../command/commandExecutor.js';
import { createCommandRegistry } from '../command/commandRegistry.js';
import { createPluginRuntime } from './pluginRuntime.js';
import type { Command } from '../command/types.js';
import type { PluginManifest } from './pluginManifest.js';
import type { PluginRuntimeResult } from './pluginRuntime.js';

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'com.example.text-tools',
    name: 'Text Tools',
    version: '0.1.0',
    description: 'Common text transformations',
    main: 'dist/main.js',
    permissions: ['clipboard.read'],
    commands: [
      {
        id: 'uppercase',
        title: 'Uppercase',
        keywords: ['uppercase', 'text'],
      },
    ],
    ...overrides,
  };
}

function createRuntime(overrides: Partial<Parameters<typeof createPluginRuntime>[0]> = {}) {
  const registry = createCommandRegistry();
  const logSink = vi.fn();
  const moduleLoader = vi.fn(() => ({
    activate: vi.fn(),
    deactivate: vi.fn(),
    commands: {
      uppercase: vi.fn(() => ({
        metadata: {
          transformed: true,
        },
      })),
    },
  }));
  const runtime = createPluginRuntime({
    commandRegistry: registry,
    readManifest: vi.fn(() => createManifest()),
    resolveMainPath: vi.fn(() => ({
      ok: true,
      path: resolve('plugins', 'text-tools', 'dist', 'main.js'),
    })),
    moduleLoader,
    logSink,
    clock: () => new Date('2026-05-15T10:00:00.000Z'),
    ...overrides,
  });

  return {
    registry,
    runtime,
    moduleLoader,
    logSink,
  };
}

function expectFailure<T>(result: PluginRuntimeResult<T>) {
  expect(result.ok).toBe(false);

  if (result.ok) {
    throw new Error('Expected operation to fail');
  }

  return result;
}

function createHostileThrownValue(): object {
  return {
    toString() {
      throw new Error('toString exploded');
    },
  };
}

describe('plugin runtime', () => {
  it('loads a valid plugin, activates it, and registers manifest commands', async () => {
    const { registry, runtime, moduleLoader } = createRuntime();

    await expect(runtime.enablePlugin(resolve('plugins', 'text-tools'))).resolves.toMatchObject({
      ok: true,
      value: {
        pluginId: 'com.example.text-tools',
        status: 'enabled',
      },
    });

    expect(moduleLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginRoot: resolve('plugins', 'text-tools'),
        mainPath: resolve('plugins', 'text-tools', 'dist', 'main.js'),
        manifest: createManifest(),
      }),
    );
    expect(registry.get('com.example.text-tools.uppercase')).toEqual({
      id: 'com.example.text-tools.uppercase',
      source: 'plugin',
      pluginId: 'com.example.text-tools',
      title: 'Uppercase',
      subtitle: 'Text Tools',
      keywords: ['uppercase', 'text'],
      action: {
        type: 'run-plugin',
        payload: {
          pluginId: 'com.example.text-tools',
          commandId: 'uppercase',
        },
      },
    });
  });

  it('returns manifest validation failures without loading plugin modules', async () => {
    const moduleLoader = vi.fn();
    const { registry, runtime, logSink } = createRuntime({
      readManifest: vi.fn(() => ({
        id: 'Bad Plugin',
        name: 'Broken',
      })),
      moduleLoader,
    });

    const failure = expectFailure(await runtime.enablePlugin(resolve('plugins', 'broken')));

    expect(failure.error).toMatchObject({
      code: 'invalid-manifest',
      pluginId: undefined,
    });
    expect(failure.error.validationErrors).toContainEqual({
      field: 'id',
      message:
        'Plugin ID must use lowercase reverse-domain format, for example "com.example.text-tools".',
    });
    expect(moduleLoader).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('Plugin manifest is invalid'),
      }),
    );
  });

  it('rejects load-time context command registration and leaves no registered commands on load failure', async () => {
    let registrationError: unknown;
    const { registry, runtime } = createRuntime({
      moduleLoader: vi.fn(({ context }) => {
        try {
          context.registerCommand(
            {
              id: 'during-load',
              title: 'During Load',
              keywords: ['load'],
            },
            vi.fn(),
          );
        } catch (error) {
          registrationError = error;
        }

        throw new Error('module exploded');
      }),
    });

    const failure = expectFailure(await runtime.loadPlugin(resolve('plugins', 'text-tools')));

    expect(failure.error).toMatchObject({
      code: 'load-error',
      message: 'module exploded',
      pluginId: 'com.example.text-tools',
    });
    expect(registrationError).toEqual(expect.any(Error));
    expect(registrationError).toMatchObject({
      message: expect.stringContaining('registration is not allowed'),
    });
    expect(registry.list()).toEqual([]);
  });

  it('cleans up plugin commands when disabling a plugin', async () => {
    const { registry, runtime } = createRuntime();
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    await expect(runtime.disablePlugin('com.example.text-tools')).resolves.toEqual({
      ok: true,
      value: {
        pluginId: 'com.example.text-tools',
        removedCommands: 1,
        status: 'disabled',
      },
    });

    expect(registry.get('com.example.text-tools.uppercase')).toBeUndefined();
    expect(runtime.getPlugin('com.example.text-tools')?.status).toBe('disabled');
  });

  it('treats disabling an already disabled plugin as a no-op success', async () => {
    const deactivate = vi.fn();
    const { registry, runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        deactivate,
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    await runtime.disablePlugin('com.example.text-tools');

    await expect(runtime.disablePlugin('com.example.text-tools')).resolves.toEqual({
      ok: true,
      value: {
        pluginId: 'com.example.text-tools',
        removedCommands: 0,
        status: 'disabled',
      },
    });

    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });

  it('does not deactivate a plugin that was loaded but never enabled', async () => {
    const deactivate = vi.fn();
    const { registry, runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        deactivate,
      })),
    });
    await runtime.loadPlugin(resolve('plugins', 'text-tools'));

    await expect(runtime.disablePlugin('com.example.text-tools')).resolves.toEqual({
      ok: true,
      value: {
        pluginId: 'com.example.text-tools',
        removedCommands: 0,
        status: 'disabled',
      },
    });

    expect(deactivate).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });

  it('rejects context command registration after a plugin is disabled', async () => {
    let pluginContext: CommandCabinPluginContext | undefined;
    const { registry, runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          pluginContext = context;
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    await runtime.disablePlugin('com.example.text-tools');

    expect(() =>
      pluginContext!.registerCommand(
        {
          id: 'after-disable',
          title: 'After Disable',
          keywords: ['disable'],
        },
        vi.fn(),
      ),
    ).toThrow(/registration is not allowed/);
    expect(registry.list()).toEqual([]);
  });

  it('rejects async delayed context command registration after disable', async () => {
    let releaseDelayedRegistration: (() => void) | undefined;
    let delayedRegistration: Promise<void> | undefined;
    const { registry, runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          delayedRegistration = new Promise<void>((resolveDelayedRegistration) => {
            releaseDelayedRegistration = resolveDelayedRegistration;
          }).then(() => {
            context.registerCommand(
              {
                id: 'delayed',
                title: 'Delayed',
                keywords: ['delayed'],
              },
              vi.fn(),
            );
          });
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    await runtime.disablePlugin('com.example.text-tools');

    releaseDelayedRegistration!();

    await expect(delayedRegistration).rejects.toThrow(/registration is not allowed/);
    expect(registry.list()).toEqual([]);
  });

  it('treats enabling an already enabled plugin root as idempotent', async () => {
    const { registry, runtime, moduleLoader } = createRuntime();
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    await expect(runtime.enablePlugin(resolve('plugins', 'text-tools'))).resolves.toMatchObject({
      ok: true,
      value: {
        pluginId: 'com.example.text-tools',
        status: 'enabled',
      },
    });

    expect(moduleLoader).toHaveBeenCalledTimes(1);
    expect(registry.list().map((command) => command.id)).toEqual([
      'com.example.text-tools.uppercase',
    ]);
  });

  it('rolls back partial command registration when plugin command ids collide', async () => {
    const { registry, runtime, logSink } = createRuntime({
      readManifest: vi.fn(() =>
        createManifest({
          commands: [
            {
              id: 'uppercase',
              title: 'Uppercase',
              keywords: ['uppercase'],
            },
            {
              id: 'lowercase',
              title: 'Lowercase',
              keywords: ['lowercase'],
            },
          ],
        }),
      ),
    });
    registry.register({
      id: 'com.example.text-tools.lowercase',
      source: 'system',
      title: 'Existing Lowercase',
      keywords: ['lowercase'],
      action: {
        type: 'run-system',
        payload: {
          command: 'lowercase',
        },
      },
    });

    const failure = expectFailure(await runtime.enablePlugin(resolve('plugins', 'text-tools')));

    expect(failure.error).toMatchObject({
      code: 'command-registration-error',
      pluginId: 'com.example.text-tools',
    });
    expect(registry.get('com.example.text-tools.uppercase')).toBeUndefined();
    expect(registry.get('com.example.text-tools.lowercase')?.source).toBe('system');
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('Failed to register plugin command'),
      }),
    );
  });

  it('returns a structured failure when plugin commands getter throws during enable', async () => {
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        get commands() {
          throw new Error('commands getter exploded');
        },
      })),
    });

    const failure = expectFailure(await runtime.enablePlugin(resolve('plugins', 'text-tools')));

    expect(failure.error).toMatchObject({
      code: 'command-registration-error',
      pluginId: 'com.example.text-tools',
      message: 'commands getter exploded',
    });
    expect(registry.list()).toEqual([]);
    expect(runtime.getPlugin('com.example.text-tools')?.status).toBe('disabled');
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('Plugin commands could not be read'),
        error: 'commands getter exploded',
      }),
    );
  });

  it('returns a structured failure when resolving the main path throws', async () => {
    const moduleLoader = vi.fn();
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader,
      resolveMainPath: vi.fn(() => {
        throw new Error('resolver exploded');
      }),
    });

    const failure = expectFailure(await runtime.loadPlugin(resolve('plugins', 'text-tools')));

    expect(failure.error).toEqual({
      code: 'main-path-error',
      message: 'resolver exploded',
      pluginId: 'com.example.text-tools',
    });
    expect(moduleLoader).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('Plugin main path could not be resolved'),
        error: 'resolver exploded',
      }),
    );
  });

  it('returns a structured failure when resolving the main path rejects', async () => {
    const moduleLoader = vi.fn();
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader,
      resolveMainPath: vi.fn(async () => Promise.reject('resolver rejected')),
    });

    const failure = expectFailure(await runtime.loadPlugin(resolve('plugins', 'text-tools')));

    expect(failure.error).toEqual({
      code: 'main-path-error',
      message: 'resolver rejected',
      pluginId: 'com.example.text-tools',
    });
    expect(moduleLoader).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('Plugin main path could not be resolved'),
        error: 'resolver rejected',
      }),
    );
  });

  it('denies clipboard reads and writes when the manifest declares no clipboard permissions', async () => {
    let pluginContext: CommandCabinPluginContext | undefined;
    const clipboard: PluginClipboardCapability = {
      readText: vi.fn(async () => 'secret'),
      writeText: vi.fn(async () => undefined),
    };
    const { runtime } = createRuntime({
      clipboard,
      readManifest: vi.fn(() =>
        createManifest({
          permissions: [],
        }),
      ),
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          pluginContext = context;
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    await expect(pluginContext!.clipboard!.readText()).rejects.toThrow(
      'Plugin requires permission "clipboard.read".',
    );
    await expect(
      pluginContext!.clipboard!.writeText({
        permission: 'clipboard.write',
        text: 'hello',
      }),
    ).rejects.toThrow('Plugin requires permission "clipboard.write".');
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('allows clipboard reads but denies writes for read-only clipboard permission', async () => {
    let pluginContext: CommandCabinPluginContext | undefined;
    const clipboard: PluginClipboardCapability = {
      readText: vi.fn(async () => 'secret'),
      writeText: vi.fn(async () => undefined),
    };
    const { runtime } = createRuntime({
      clipboard,
      readManifest: vi.fn(() =>
        createManifest({
          permissions: ['clipboard.read'],
        }),
      ),
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          pluginContext = context;
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    await expect(pluginContext!.clipboard!.readText()).resolves.toBe('secret');
    await expect(
      pluginContext!.clipboard!.writeText({
        permission: 'clipboard.write',
        text: 'hello',
      }),
    ).rejects.toThrow('Plugin requires permission "clipboard.write".');
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('allows clipboard writes but denies reads for write-only clipboard permission', async () => {
    let pluginContext: CommandCabinPluginContext | undefined;
    const clipboard: PluginClipboardCapability = {
      readText: vi.fn(async () => 'secret'),
      writeText: vi.fn(async () => undefined),
    };
    const { runtime } = createRuntime({
      clipboard,
      readManifest: vi.fn(() =>
        createManifest({
          permissions: ['clipboard.write'],
        }),
      ),
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          pluginContext = context;
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    await expect(pluginContext!.clipboard!.readText()).rejects.toThrow(
      'Plugin requires permission "clipboard.read".',
    );
    await expect(
      pluginContext!.clipboard!.writeText({
        permission: 'clipboard.write',
        text: 'hello',
      }),
    ).resolves.toBeUndefined();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith({
      permission: 'clipboard.write',
      text: 'hello',
    });
  });

  it('catches activate exceptions, logs them, and leaves the plugin disabled', async () => {
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: () => {
          throw new Error('activate exploded');
        },
      })),
    });

    const failure = expectFailure(await runtime.enablePlugin(resolve('plugins', 'text-tools')));

    expect(failure.error).toMatchObject({
      code: 'activate-error',
      pluginId: 'com.example.text-tools',
      message: 'activate exploded',
    });
    expect(registry.list()).toEqual([]);
    expect(runtime.getPlugin('com.example.text-tools')?.status).toBe('disabled');
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('activate failed'),
        error: 'activate exploded',
      }),
    );
  });

  it('formats hostile lifecycle thrown values without crashing the runtime', async () => {
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: () => {
          throw createHostileThrownValue();
        },
      })),
    });

    const failure = expectFailure(await runtime.enablePlugin(resolve('plugins', 'text-tools')));

    expect(failure.error).toMatchObject({
      code: 'activate-error',
      pluginId: 'com.example.text-tools',
      message: '[unformattable thrown value]',
    });
    expect(registry.list()).toEqual([]);
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('[unformattable thrown value]'),
        error: '[unformattable thrown value]',
      }),
    );
  });

  it('catches deactivate exceptions while still clearing plugin commands', async () => {
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        deactivate: () => {
          throw new Error('deactivate exploded');
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    const failure = expectFailure(await runtime.disablePlugin('com.example.text-tools'));

    expect(failure.error).toMatchObject({
      code: 'deactivate-error',
      pluginId: 'com.example.text-tools',
      message: 'deactivate exploded',
    });
    expect(registry.list()).toEqual([]);
    expect(runtime.getPlugin('com.example.text-tools')?.status).toBe('disabled');
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('deactivate failed'),
        error: 'deactivate exploded',
      }),
    );
  });

  it('catches deactivate getter exceptions while still clearing plugin commands', async () => {
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        get deactivate() {
          throw new Error('deactivate getter exploded');
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    const failure = expectFailure(await runtime.disablePlugin('com.example.text-tools'));

    expect(failure.error).toMatchObject({
      code: 'deactivate-error',
      pluginId: 'com.example.text-tools',
      message: 'deactivate getter exploded',
    });
    expect(registry.list()).toEqual([]);
    expect(runtime.getPlugin('com.example.text-tools')?.status).toBe('disabled');
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('Plugin deactivate failed'),
        error: 'deactivate getter exploded',
      }),
    );
  });

  it('keeps plugin log details isolated from later caller mutations', async () => {
    const details = {
      nested: {
        count: 1,
      },
    };
    const { runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          context.logger.info('snapshot', details);
          details.nested.count = 2;
        },
      })),
    });

    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    const listedLog = runtime.getPluginLogs('com.example.text-tools').find((entry) => {
      return entry.message === 'snapshot';
    });

    expect(listedLog?.details).toEqual({
      nested: {
        count: 1,
      },
    });

    (listedLog!.details as { nested: { count: number } }).nested.count = 99;

    expect(
      runtime.getPluginLogs('com.example.text-tools').find((entry) => {
        return entry.message === 'snapshot';
      })?.details,
    ).toEqual({
      nested: {
        count: 1,
      },
    });
  });

  it('coerces plugin log messages safely and isolates them from later caller mutations', async () => {
    const message = {
      value: 'initial',
      toString() {
        return this.value;
      },
    };
    const { runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          context.logger.info(message as never);
          message.value = 'mutated';
        },
      })),
    });

    await runtime.enablePlugin(resolve('plugins', 'text-tools'));

    const listedLog = runtime.getPluginLogs('com.example.text-tools').find((entry) => {
      return entry.message === 'initial';
    });

    expect(listedLog?.message).toBe('initial');
  });

  it('executes plugin command handlers and returns handler metadata', async () => {
    const { registry, runtime } = createRuntime();
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    const command = registry.get('com.example.text-tools.uppercase')!;

    await expect(runtime.executePluginCommand(command)).resolves.toEqual({
      status: 'success',
      commandId: 'com.example.text-tools.uppercase',
      pluginId: 'com.example.text-tools',
      localCommandId: 'uppercase',
      metadata: {
        transformed: true,
      },
    });
  });

  it('catches command handler exceptions and logs them without throwing', async () => {
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        commands: {
          uppercase: () => {
            throw new Error('handler exploded');
          },
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    const command = registry.get('com.example.text-tools.uppercase')!;

    await expect(runtime.executePluginCommand(command)).resolves.toEqual({
      status: 'failure',
      commandId: 'com.example.text-tools.uppercase',
      pluginId: 'com.example.text-tools',
      localCommandId: 'uppercase',
      error: {
        code: 'handler-error',
        message: 'handler exploded',
      },
    });
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('command handler failed'),
        error: 'handler exploded',
      }),
    );
  });

  it('formats hostile command handler thrown values without crashing the runtime', async () => {
    const { registry, runtime, logSink } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        commands: {
          uppercase: () => {
            throw createHostileThrownValue();
          },
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    const command = registry.get('com.example.text-tools.uppercase')!;

    await expect(runtime.executePluginCommand(command)).resolves.toEqual({
      status: 'failure',
      commandId: 'com.example.text-tools.uppercase',
      pluginId: 'com.example.text-tools',
      localCommandId: 'uppercase',
      error: {
        code: 'handler-error',
        message: '[unformattable thrown value]',
      },
    });
    expect(logSink).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'com.example.text-tools',
        level: 'error',
        message: expect.stringContaining('[unformattable thrown value]'),
        error: '[unformattable thrown value]',
      }),
    );
  });

  it('keeps plugin crashes isolated from host command execution', async () => {
    const { registry, runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: vi.fn(),
        commands: {
          uppercase: () => {
            throw new Error('plugin crashed');
          },
        },
      })),
    });
    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    const command = registry.get('com.example.text-tools.uppercase') as Command;
    const executor = createCommandExecutor({
      handlers: {
        'run-plugin': runtime.createRunPluginCommandHandler(),
      },
    });

    await expect(executor.execute(command)).resolves.toEqual({
      status: 'failure',
      commandId: 'com.example.text-tools.uppercase',
      actionType: 'run-plugin',
      error: {
        code: 'handler-error',
        message:
          'Plugin command "uppercase" from plugin "com.example.text-tools" failed: plugin crashed',
      },
    });
  });

  it('allows activate to register additional API commands through the plugin context', async () => {
    const handler = vi.fn(() => ({
      metadata: {
        trimmed: true,
      },
    }));
    const { registry, runtime } = createRuntime({
      moduleLoader: vi.fn(() => ({
        activate: (context) => {
          context.registerCommand(
            {
              id: 'trim',
              title: 'Trim Whitespace',
              keywords: ['trim'],
            },
            handler,
          );
        },
      })),
    });

    await runtime.enablePlugin(resolve('plugins', 'text-tools'));
    const command = registry.get('com.example.text-tools.trim')!;

    expect(command).toMatchObject({
      id: 'com.example.text-tools.trim',
      source: 'plugin',
      pluginId: 'com.example.text-tools',
      title: 'Trim Whitespace',
      subtitle: 'Text Tools',
    });
    await expect(runtime.executePluginCommand(command)).resolves.toMatchObject({
      status: 'success',
      metadata: {
        trimmed: true,
      },
    });
  });
});
