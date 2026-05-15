import { describe, expect, it } from 'vitest';

import {
  createPluginCommand,
  createPluginCommandId,
  readPluginCommandPayload,
} from './pluginCommandAdapter.js';
import type { PluginManifest } from './pluginManifest.js';

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

describe('plugin command adapter', () => {
  it('creates stable host command ids from plugin and local command ids', () => {
    expect(createPluginCommandId('com.example.text-tools', 'uppercase')).toBe(
      'com.example.text-tools.uppercase',
    );
  });

  it('converts manifest command declarations to run-plugin commands', () => {
    const manifest = createManifest();

    expect(createPluginCommand(manifest, manifest.commands[0]!)).toEqual({
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

  it('reads plugin command payloads without relying on dotted host ids', () => {
    expect(
      readPluginCommandPayload({
        id: 'com.example.text-tools.uppercase',
        source: 'plugin',
        pluginId: 'com.example.text-tools',
        title: 'Uppercase',
        keywords: ['uppercase'],
        action: {
          type: 'run-plugin',
          payload: {
            pluginId: 'com.example.text-tools',
            commandId: 'uppercase',
          },
        },
      }),
    ).toEqual({
      pluginId: 'com.example.text-tools',
      commandId: 'uppercase',
    });
  });

  it('rejects malformed API command declarations before registry mutation', () => {
    expect(() =>
      createPluginCommand(createManifest(), {
        id: 'Bad Command',
        title: 'Broken',
        keywords: [],
      }),
    ).toThrow(/Command ID must use lowercase letters/);
  });
});
