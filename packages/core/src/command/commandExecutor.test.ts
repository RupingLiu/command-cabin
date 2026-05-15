import { describe, expect, it, vi } from 'vitest';

import { createCommandExecutor } from './commandExecutor.js';
import type { Command } from './types.js';

function createCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'url.docs',
    source: 'url',
    title: 'Open Docs',
    keywords: ['docs'],
    action: {
      type: 'open-url',
      payload: {
        url: 'https://example.com/docs',
      },
    },
    ...overrides,
  };
}

describe('command executor', () => {
  it('dispatches a command to its injected action handler', async () => {
    const handler = vi.fn(async () => ({
      metadata: {
        opened: true,
      },
    }));
    const executor = createCommandExecutor({
      handlers: {
        'open-url': handler,
      },
    });
    const command = createCommand();

    await expect(executor.execute(command)).resolves.toEqual({
      status: 'success',
      commandId: 'url.docs',
      actionType: 'open-url',
      metadata: {
        opened: true,
      },
    });
    expect(handler).toHaveBeenCalledWith(command);
  });

  it('returns empty metadata when a handler returns void', async () => {
    const executor = createCommandExecutor({
      handlers: {
        'open-url': () => undefined,
      },
    });

    await expect(executor.execute(createCommand())).resolves.toEqual({
      status: 'success',
      commandId: 'url.docs',
      actionType: 'open-url',
      metadata: {},
    });
  });

  it('keeps result identifiers and caller command stable when a handler mutates its command view', async () => {
    const executor = createCommandExecutor({
      handlers: {
        'open-url': (receivedCommand) => {
          (receivedCommand as Command).id = 'mutated.id';
          (receivedCommand as Command).action.type = 'run-system';
          (receivedCommand.action.payload as Command['action']['payload']).url =
            'https://example.com/mutated';

          return {
            metadata: {
              mutated: true,
            },
          };
        },
      },
    });
    const command = createCommand();

    await expect(executor.execute(command)).resolves.toEqual({
      status: 'success',
      commandId: 'url.docs',
      actionType: 'open-url',
      metadata: {
        mutated: true,
      },
    });
    expect(command).toEqual(createCommand());
  });

  it('returns a structured failure when a handler returns metadata that is not JSON-compatible', async () => {
    const executor = createCommandExecutor({
      handlers: {
        'open-url': () => ({
          metadata: {
            copiedAt: new Date('2026-05-15T10:00:00.000Z'),
          } as never,
        }),
      },
    });

    await expect(executor.execute(createCommand())).resolves.toEqual({
      status: 'failure',
      commandId: 'url.docs',
      actionType: 'open-url',
      error: {
        code: 'invalid-result',
        message:
          'Invalid JSON value in command execution metadata for command "url.docs" at metadata.copiedAt: object must be a plain JSON object',
      },
    });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'done'],
    ['Date', new Date('2026-05-15T10:00:00.000Z')],
    ['class instance', new (class CommandHandlerResult {})()],
  ])('returns a structured failure when a handler returns %s', async (_name, handlerResult) => {
    const executor = createCommandExecutor({
      handlers: {
        'open-url': () => handlerResult as never,
      },
    });

    await expect(executor.execute(createCommand())).resolves.toEqual({
      status: 'failure',
      commandId: 'url.docs',
      actionType: 'open-url',
      error: {
        code: 'invalid-result',
        message: 'Command handler result must be undefined or a plain object.',
      },
    });
  });

  it('returns a structured failure when no handler is registered for the action type', async () => {
    const executor = createCommandExecutor({ handlers: {} });

    await expect(executor.execute(createCommand())).resolves.toEqual({
      status: 'failure',
      commandId: 'url.docs',
      actionType: 'open-url',
      error: {
        code: 'missing-handler',
        message: 'No command handler registered for action type "open-url".',
      },
    });
  });

  it('returns a structured failure when a handler throws', async () => {
    const executor = createCommandExecutor({
      handlers: {
        'copy-text': () => {
          throw new Error('Clipboard unavailable');
        },
      },
    });

    await expect(
      executor.execute(
        createCommand({
          id: 'copy.username',
          source: 'system',
          title: 'Copy Username',
          action: {
            type: 'copy-text',
            payload: {
              text: 'ruping',
            },
          },
        }),
      ),
    ).resolves.toEqual({
      status: 'failure',
      commandId: 'copy.username',
      actionType: 'copy-text',
      error: {
        code: 'handler-error',
        message: 'Clipboard unavailable',
      },
    });
  });

  it('returns a structured failure when a handler rejects with a non-error value', async () => {
    const executor = createCommandExecutor({
      handlers: {
        'run-plugin': async () => Promise.reject('plugin crashed'),
      },
    });

    await expect(
      executor.execute(
        createCommand({
          id: 'plugin.uppercase',
          source: 'plugin',
          pluginId: 'com.example.text-tools',
          title: 'Uppercase',
          action: {
            type: 'run-plugin',
            payload: {
              commandId: 'uppercase',
            },
          },
        }),
      ),
    ).resolves.toEqual({
      status: 'failure',
      commandId: 'plugin.uppercase',
      actionType: 'run-plugin',
      error: {
        code: 'handler-error',
        message: 'plugin crashed',
      },
    });
  });
});
