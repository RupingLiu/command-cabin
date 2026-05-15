import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PERMISSIONS,
  formatPluginManifestValidationErrors,
  getPluginManifestFilePath,
  PLUGIN_MANIFEST_SCHEMA as EXPORTED_PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PERMISSIONS as EXPORTED_PLUGIN_PERMISSIONS,
  resolvePluginManifestRealPath,
  resolvePluginManifestPath,
  validatePluginManifest as validateExportedPluginManifest,
  validatePluginManifest,
  type PluginManifest,
  type ValidatePluginManifestResult,
} from '@command-cabin/core';

function createValidManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'com.example.text-tools',
    name: 'Text Tools',
    version: '0.1.0',
    description: 'Common text transformations',
    main: 'dist/main.js',
    ui: 'dist/index.html',
    permissions: ['clipboard.read', 'clipboard.write'],
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

describe('plugin manifest validation', () => {
  it('accepts a valid manifest and returns an isolated normalized manifest', () => {
    const input = createValidManifest();
    const result = validatePluginManifest(input);

    expect(result).toEqual({
      ok: true,
      manifest: input,
    });

    if (!result.ok) {
      throw new Error('Expected manifest validation to pass');
    }

    input.commands[0]!.keywords.push('mutated');
    input.permissions.push('clipboard.read');

    expect(result.manifest.commands[0]!.keywords).toEqual(['uppercase', 'text']);
    expect(result.manifest.permissions).toEqual(['clipboard.read', 'clipboard.write']);
  });

  it('exposes manifest schema and validation APIs from the core package entrypoint', () => {
    expect(EXPORTED_PLUGIN_MANIFEST_SCHEMA).toBe(PLUGIN_MANIFEST_SCHEMA);
    expect(EXPORTED_PLUGIN_PERMISSIONS).toBe(PLUGIN_PERMISSIONS);
    expect(validateExportedPluginManifest(createValidManifest())).toMatchObject({ ok: true });
  });

  it('rejects manifests that are missing required fields', () => {
    const errors = expectInvalid(validatePluginManifest({}));

    expect(errors).toEqual([
      { field: 'id', message: 'Plugin ID is required.' },
      { field: 'name', message: 'Plugin name is required.' },
      { field: 'version', message: 'Plugin version is required.' },
      { field: 'description', message: 'Plugin description is required.' },
      { field: 'main', message: 'Plugin main entry file is required.' },
      { field: 'permissions', message: 'Plugin permissions must be an array.' },
      { field: 'commands', message: 'Plugin commands must be an array.' },
    ]);
  });

  it.each([
    [
      'Text Tools',
      'id',
      'Plugin ID must use lowercase reverse-domain format, for example "com.example.text-tools".',
    ],
    [
      'com.Example.text-tools',
      'id',
      'Plugin ID must use lowercase reverse-domain format, for example "com.example.text-tools".',
    ],
    [
      'text-tools',
      'id',
      'Plugin ID must use lowercase reverse-domain format, for example "com.example.text-tools".',
    ],
    ['1.0', 'version', 'Plugin version must look like semantic versioning, for example "1.2.3".'],
    [
      'v1.0.0',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '01.0.0',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '1.02.3',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '1.2.03',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '1.0.0-',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '1.0.0-alpha..1',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '1.0.0-01',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '1.0.0+',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
    [
      '1.0.0+build..1',
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    ],
  ])('rejects invalid ID or version value %s', (value, field, message) => {
    const manifest =
      field === 'id' ? createValidManifest({ id: value }) : createValidManifest({ version: value });

    expect(expectInvalid(validatePluginManifest(manifest))).toContainEqual({
      field,
      message,
    });
  });

  it.each(['1.0.0-alpha.1', '1.0.0+build.5', '1.0.0-alpha.1+build.5'])(
    'accepts valid semantic version %s',
    (version) => {
      expect(validatePluginManifest(createValidManifest({ version }))).toMatchObject({ ok: true });
    },
  );

  it('rejects unknown plugin permissions', () => {
    const errors = expectInvalid(
      validatePluginManifest(
        createValidManifest({
          permissions: ['clipboard.read', 'network.fetch'] as never,
        }),
      ),
    );

    expect(errors).toContainEqual({
      field: 'permissions[1]',
      message:
        'Unknown plugin permission "network.fetch". Allowed permissions: clipboard.read, clipboard.write.',
    });
  });

  it('rejects malformed commands and duplicate command IDs', () => {
    const errors = expectInvalid(
      validatePluginManifest(
        createValidManifest({
          commands: [
            {
              id: 'uppercase',
              title: 'Uppercase',
              keywords: ['uppercase'],
            },
            {
              id: 'uppercase',
              title: 'Duplicate uppercase',
              keywords: ['duplicate'],
            },
            {
              id: 'Bad Command',
              title: '',
              keywords: ['bad'],
            },
          ],
        }),
      ),
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        {
          field: 'commands[1].id',
          message: 'Command ID "uppercase" is already declared in this manifest.',
        },
        {
          field: 'commands[2].id',
          message:
            'Command ID must use lowercase letters, numbers, dots, or hyphens, for example "uppercase".',
        },
        {
          field: 'commands[2].title',
          message: 'Command title is required.',
        },
      ]),
    );
  });

  it.each([
    [
      'missing keywords',
      [{ id: 'uppercase', title: 'Uppercase' }],
      { field: 'commands[0].keywords', message: 'Command keywords must be an array.' },
    ],
    [
      'non-array keywords',
      [{ id: 'uppercase', title: 'Uppercase', keywords: 'uppercase' }],
      { field: 'commands[0].keywords', message: 'Command keywords must be an array.' },
    ],
    [
      'non-string keyword',
      [{ id: 'uppercase', title: 'Uppercase', keywords: ['uppercase', 42] }],
      { field: 'commands[0].keywords[1]', message: 'Command keyword must be a string.' },
    ],
    [
      'blank keyword',
      [{ id: 'uppercase', title: 'Uppercase', keywords: ['uppercase', '  '] }],
      { field: 'commands[0].keywords[1]', message: 'Command keyword cannot be empty.' },
    ],
  ])('rejects invalid command keywords: %s', (_name, commands, expectedError) => {
    const errors = expectInvalid(
      validatePluginManifest(
        createValidManifest({
          commands: commands as never,
        }),
      ),
    );

    expect(errors).toContainEqual(expectedError);
  });

  it.each([
    [
      '../dist/main.js',
      undefined,
      'main',
      'Plugin main entry file must stay inside the plugin folder and cannot contain "..".',
    ],
    [
      '/tmp/plugin/main.js',
      undefined,
      'main',
      'Plugin main entry file must be a relative path inside the plugin folder.',
    ],
    [
      'dist/main.js',
      'C:\\Users\\alice\\plugin\\index.html',
      'ui',
      'Plugin UI entry file must be a relative path inside the plugin folder.',
    ],
  ])('rejects unsafe main or UI paths', (main, ui, field, message) => {
    const errors = expectInvalid(
      validatePluginManifest(
        createValidManifest({
          main,
          ...(ui === undefined ? {} : { ui }),
        }),
      ),
    );

    expect(errors).toContainEqual({ field, message });
  });

  it('formats validation errors as user-facing messages without stack traces', () => {
    const errors = expectInvalid(
      validatePluginManifest({
        id: 'Bad Plugin',
        permissions: ['network.fetch'],
      }),
    );
    const messages = formatPluginManifestValidationErrors(errors);

    expect(messages).toEqual(
      expect.arrayContaining([
        'id: Plugin ID must use lowercase reverse-domain format, for example "com.example.text-tools".',
        'permissions[0]: Unknown plugin permission "network.fetch". Allowed permissions: clipboard.read, clipboard.write.',
      ]),
    );
    expect(messages.join('\n')).not.toMatch(/\bat\b|Error:/);
  });

  it('returns user-facing errors when manifest fields cannot be read', () => {
    const manifest = new Proxy(createValidManifest(), {
      get(target, property, receiver) {
        if (property === 'commands') {
          throw new Error('commands getter failed');
        }

        return Reflect.get(target, property, receiver);
      },
    });

    const errors = expectInvalid(validatePluginManifest(manifest));
    const messages = formatPluginManifestValidationErrors(errors);

    expect(errors).toContainEqual({
      field: 'commands',
      message: 'Plugin commands could not be read.',
    });
    expect(messages.join('\n')).not.toContain('commands getter failed');
  });
});

describe('plugin path helpers', () => {
  it('resolves manifest-relative paths under the plugin root', () => {
    const pluginRoot = resolve('plugins', 'text-tools');
    const result = resolvePluginManifestPath(pluginRoot, 'dist/main.js', 'main');

    expect(result).toEqual({
      ok: true,
      path: join(pluginRoot, 'dist', 'main.js'),
    });
    expect(getPluginManifestFilePath(pluginRoot)).toBe(join(pluginRoot, 'plugin.json'));
  });

  it('resolves real paths under the real plugin root', async () => {
    const pluginRoot = resolve('plugins', 'text-tools');
    const lexicalMain = join(pluginRoot, 'dist', 'main.js');
    const realPluginRoot = resolve('real-plugins', 'text-tools');
    const realMain = join(realPluginRoot, 'dist', 'main.js');

    await expect(
      resolvePluginManifestRealPath(pluginRoot, 'dist/main.js', 'main', {
        realpath: async (filePath) => {
          if (filePath === pluginRoot) {
            return realPluginRoot;
          }

          if (filePath === lexicalMain) {
            return realMain;
          }

          throw new Error(`Unexpected realpath input: ${filePath}`);
        },
      }),
    ).resolves.toEqual({
      ok: true,
      path: realMain,
    });
  });

  it('rejects symlink or junction targets whose real path escapes the plugin root', async () => {
    const pluginRoot = resolve('plugins', 'text-tools');
    const lexicalMain = join(pluginRoot, 'linked', 'main.js');
    const realPluginRoot = resolve('real-plugins', 'text-tools');
    const outsideMain = resolve('shared-plugin-files', 'main.js');

    await expect(
      resolvePluginManifestRealPath(pluginRoot, 'linked/main.js', 'main', {
        realpath: async (filePath) => {
          if (filePath === pluginRoot) {
            return realPluginRoot;
          }

          if (filePath === lexicalMain) {
            return outsideMain;
          }

          throw new Error(`Unexpected realpath input: ${filePath}`);
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        field: 'main',
        message: 'Plugin main entry file must resolve inside the plugin folder.',
      },
    });
  });

  it('allows dotted path segments that do not traverse outside the plugin root', () => {
    const pluginRoot = resolve('plugins', 'text-tools');

    expect(resolvePluginManifestPath(pluginRoot, '..data/main.js', 'main')).toEqual({
      ok: true,
      path: join(pluginRoot, '..data', 'main.js'),
    });
  });

  it.each([
    [
      '../outside.js',
      'main',
      'Plugin main entry file must stay inside the plugin folder and cannot contain "..".',
    ],
    [
      'dist/../../outside.js',
      'main',
      'Plugin main entry file must stay inside the plugin folder and cannot contain "..".',
    ],
    [
      'C:\\Users\\alice\\outside.js',
      'ui',
      'Plugin UI entry file must be a relative path inside the plugin folder.',
    ],
    ['', 'main', 'Plugin main entry file is required.'],
  ])('rejects unsafe manifest path %s', (manifestPath, field, message) => {
    const result = resolvePluginManifestPath(resolve('plugins', 'text-tools'), manifestPath, field);

    expect(result).toEqual({
      ok: false,
      error: {
        field,
        message,
      },
    });
  });
});
