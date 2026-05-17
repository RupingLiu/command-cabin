import { describe, expect, it } from 'vitest';

import {
  parseLauncherCommandExecutionResult,
  parseLauncherCommandSearchResults,
} from './launcherApi.js';

describe('launcher API validators', () => {
  it('sanitizes valid command search results from IPC', () => {
    const results = parseLauncherCommandSearchResults([
      {
        extra: 'ignored',
        favoriteId: 'favorite-wps',
        icon: 'S',
        id: 'system.settings',
        score: 1.2,
        source: 'system',
        subtitle: 'Preferences',
        title: 'Open Settings',
      },
    ]);

    expect(results).toEqual([
      {
        favoriteId: 'favorite-wps',
        icon: 'S',
        id: 'system.settings',
        score: 1.2,
        source: 'system',
        subtitle: 'Preferences',
        title: 'Open Settings',
      },
    ]);
  });

  it('rejects malformed command search results from IPC', () => {
    expect(() =>
      parseLauncherCommandSearchResults([
        {
          id: 'system.settings',
          score: Number.NaN,
          source: 'system',
          title: 'Open Settings',
        },
      ]),
    ).toThrow(/Invalid launcher command search response/);
  });

  it('sanitizes valid command execution success results from IPC', () => {
    const result = parseLauncherCommandExecutionResult({
      actionType: 'run-system',
      commandId: 'system.settings',
      metadata: {
        handled: true,
      },
      status: 'success',
    });

    expect(result).toEqual({
      actionType: 'run-system',
      commandId: 'system.settings',
      metadata: {
        handled: true,
      },
      status: 'success',
    });
  });

  it('sanitizes valid command execution failure results from IPC', () => {
    const result = parseLauncherCommandExecutionResult({
      actionType: 'run-system',
      commandId: 'missing.command',
      error: {
        code: 'invalid-command',
        message: 'Command not found.',
      },
      status: 'failure',
    });

    expect(result).toEqual({
      actionType: 'run-system',
      commandId: 'missing.command',
      error: {
        code: 'invalid-command',
        message: 'Command not found.',
      },
      status: 'failure',
    });
  });

  it('rejects malformed command execution results from IPC', () => {
    expect(() =>
      parseLauncherCommandExecutionResult({
        actionType: 'run-system',
        commandId: 'system.settings',
        metadata: [],
        status: 'success',
      }),
    ).toThrow(/Invalid launcher command execution response/);
  });
});
