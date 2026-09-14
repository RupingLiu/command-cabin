import { describe, expect, it } from 'vitest';

import type { PluginManifest } from './pluginManifest.js';
import { validatePluginManifest, type ValidatePluginManifestResult } from './validateManifest.js';

function createValidManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
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

function expectInvalid(result: ValidatePluginManifestResult) {
  expect(result.ok).toBe(false);

  if (result.ok) {
    throw new Error('Expected manifest validation to fail');
  }

  return result.errors;
}

describe('plugin manifest field length limits', () => {
  it('accepts a manifest whose fields sit exactly at their limits', () => {
    const manifest = createValidManifest({
      id: `com.${'a'.repeat(96)}`,
      name: 'n'.repeat(200),
      description: 'd'.repeat(500),
      main: `dist/${'a'.repeat(495)}`,
      version: `1.0.0-${'a'.repeat(44)}`,
      ui: `dist/${'a'.repeat(495)}`,
    });

    expect(validatePluginManifest(manifest)).toMatchObject({ ok: true });
  });

  it.each([
    ['id', `com.${'a'.repeat(97)}`, 'id', 'Plugin ID must be at most 100 characters.'],
    ['name', 'n'.repeat(201), 'name', 'Plugin name must be at most 200 characters.'],
    [
      'description',
      'd'.repeat(501),
      'description',
      'Plugin description must be at most 500 characters.',
    ],
    [
      'main',
      `dist/${'a'.repeat(496)}`,
      'main',
      'Plugin main entry file must be at most 500 characters.',
    ],
    [
      'version',
      `1.0.0-${'a'.repeat(45)}`,
      'version',
      'Plugin version must be at most 50 characters.',
    ],
  ])('rejects an over-length %s field', (field, value, errorField, message) => {
    const manifest = createValidManifest({ [field]: value });

    expect(expectInvalid(validatePluginManifest(manifest))).toContainEqual({
      field: errorField,
      message,
    });
  });

  it('rejects an over-length optional ui field', () => {
    const manifest = createValidManifest({
      ui: `dist/${'a'.repeat(496)}`,
    });

    expect(expectInvalid(validatePluginManifest(manifest))).toContainEqual({
      field: 'ui',
      message: 'Plugin UI entry file must be at most 500 characters.',
    });
  });
});

describe('plugin manifest command limits', () => {
  it('accepts up to 100 commands', () => {
    const manifest = createValidManifest({
      commands: Array.from({ length: 100 }, (_, index) => ({
        id: `command${index}`,
        title: 'Command',
        keywords: ['keyword'],
      })),
    });

    expect(validatePluginManifest(manifest)).toMatchObject({ ok: true });
  });

  it('rejects more than 100 commands', () => {
    const manifest = createValidManifest({
      commands: Array.from({ length: 101 }, (_, index) => ({
        id: `command${index}`,
        title: 'Command',
        keywords: ['keyword'],
      })),
    });

    expect(expectInvalid(validatePluginManifest(manifest))).toContainEqual({
      field: 'commands',
      message: 'Plugin commands must contain at most 100 commands.',
    });
  });

  it('accepts a command title at the 200-character limit and rejects a longer one', () => {
    expect(
      validatePluginManifest(
        createValidManifest({
          commands: [{ id: 'upper', title: 't'.repeat(200), keywords: ['keyword'] }],
        }),
      ),
    ).toMatchObject({ ok: true });

    expect(
      expectInvalid(
        validatePluginManifest(
          createValidManifest({
            commands: [{ id: 'upper', title: 't'.repeat(201), keywords: ['keyword'] }],
          }),
        ),
      ),
    ).toContainEqual({
      field: 'commands[0].title',
      message: 'Command title must be at most 200 characters.',
    });
  });

  it('accepts up to 20 keywords per command and rejects a longer list', () => {
    const keywords = Array.from({ length: 20 }, (_, index) => `keyword${index}`);

    expect(
      validatePluginManifest(
        createValidManifest({
          commands: [{ id: 'upper', title: 'Uppercase', keywords }],
        }),
      ),
    ).toMatchObject({ ok: true });

    const tooManyKeywords = Array.from({ length: 21 }, (_, index) => `keyword${index}`);

    expect(
      expectInvalid(
        validatePluginManifest(
          createValidManifest({
            commands: [{ id: 'upper', title: 'Uppercase', keywords: tooManyKeywords }],
          }),
        ),
      ),
    ).toContainEqual({
      field: 'commands[0].keywords',
      message: 'Command keywords must contain at most 20 keywords.',
    });
  });

  it('accepts 100-character keywords and rejects longer ones', () => {
    expect(
      validatePluginManifest(
        createValidManifest({
          commands: [{ id: 'upper', title: 'Uppercase', keywords: ['k'.repeat(100)] }],
        }),
      ),
    ).toMatchObject({ ok: true });

    expect(
      expectInvalid(
        validatePluginManifest(
          createValidManifest({
            commands: [{ id: 'upper', title: 'Uppercase', keywords: ['k'.repeat(101)] }],
          }),
        ),
      ),
    ).toContainEqual({
      field: 'commands[0].keywords[0]',
      message: 'Command keyword must be at most 100 characters.',
    });
  });
});

describe('plugin manifest permissions', () => {
  it('deduplicates repeated permissions without erroring', () => {
    const result = validatePluginManifest(
      createValidManifest({
        permissions: ['clipboard.read', 'clipboard.write', 'clipboard.read', 'clipboard.write'],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        permissions: ['clipboard.read', 'clipboard.write'],
      },
    });
  });
});
