import { describe, expect, it } from 'vitest';

import { createCommandRegistry } from './commandRegistry.js';
import type { Command } from './types.js';

function createCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'app.notepad',
    source: 'app',
    title: 'Notepad',
    keywords: ['notepad', 'notes'],
    action: {
      type: 'open-app',
      payload: {
        executablePath: 'C:\\Windows\\System32\\notepad.exe',
      },
    },
    ...overrides,
  };
}

describe('command registry', () => {
  it('registers commands for lookup and returns isolated snapshots', () => {
    const registry = createCommandRegistry();
    const command = createCommand();

    registry.register(command);
    command.keywords.push('mutated');
    command.action.payload.executablePath = 'changed.exe';

    expect(registry.get('app.notepad')).toEqual(createCommand());

    const listedCommands = registry.list();
    listedCommands[0]!.keywords.push('caller-mutation');

    expect(registry.get('app.notepad')?.keywords).toEqual(['notepad', 'notes']);
  });

  it('keeps nested action payload records isolated from caller mutations', () => {
    const registry = createCommandRegistry();
    const command = createCommand({
      action: {
        type: 'run-plugin',
        payload: {
          args: {
            text: 'hello',
          },
        },
      },
    });

    registry.register(command);
    (command.action.payload.args as { text: string }).text = 'changed';

    const registeredCommand = registry.get('app.notepad');
    (registeredCommand?.action.payload.args as { text: string }).text = 'caller-mutation';

    expect(registry.get('app.notepad')?.action.payload).toEqual({
      args: {
        text: 'hello',
      },
    });
  });

  it('unregisters commands by id', () => {
    const registry = createCommandRegistry();

    registry.register(createCommand());

    expect(registry.has('app.notepad')).toBe(true);
    expect(registry.unregister('app.notepad')).toBe(true);
    expect(registry.unregister('app.notepad')).toBe(false);
    expect(registry.get('app.notepad')).toBeUndefined();
    expect(registry.has('app.notepad')).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('clears all registered commands', () => {
    const registry = createCommandRegistry();
    registry.register(createCommand({ id: 'app.notepad' }));
    registry.register(createCommand({ id: 'url.docs', source: 'url', title: 'Docs' }));

    registry.clear();

    expect(registry.has('app.notepad')).toBe(false);
    expect(registry.has('url.docs')).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('clears commands by source without touching other sources', () => {
    const registry = createCommandRegistry();
    registry.register(createCommand({ id: 'app.notepad', source: 'app' }));
    registry.register(createCommand({ id: 'app.calc', source: 'app', title: 'Calculator' }));
    registry.register(
      createCommand({
        id: 'system.lock-screen',
        source: 'system',
        title: 'Lock Screen',
        action: {
          type: 'run-system',
          payload: {
            command: 'lock-screen',
          },
        },
      }),
    );

    expect(registry.clearBySource('app')).toBe(2);
    expect(registry.list()).toMatchObject([
      {
        id: 'system.lock-screen',
        source: 'system',
      },
    ]);
  });

  it('rejects duplicate command ids and keeps the original command', () => {
    const registry = createCommandRegistry();
    registry.register(createCommand());

    expect(() =>
      registry.register(
        createCommand({
          title: 'Different Notepad',
          keywords: ['different'],
        }),
      ),
    ).toThrow(/Command already registered: app\.notepad/);
    expect(registry.get('app.notepad')).toEqual(createCommand());
  });

  it('rejects command payloads that are not JSON-compatible', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.register(
        createCommand({
          action: {
            type: 'run-plugin',
            payload: {
              startedAt: new Date('2026-05-15T10:00:00.000Z'),
            } as never,
          },
        }),
      ),
    ).toThrow(
      /Invalid JSON value in command action payload for command "app\.notepad" at payload\.startedAt: object must be a plain JSON object/,
    );
    expect(registry.has('app.notepad')).toBe(false);
  });
});
