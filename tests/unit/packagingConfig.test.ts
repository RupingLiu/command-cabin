import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = process.cwd();
const builderConfigPath = join(repoRoot, 'electron-builder.yml');
const desktopPackagePath = join(repoRoot, 'apps', 'desktop', 'package.json');
const windowsIconPath = join(repoRoot, 'apps', 'desktop', 'build', 'icon.ico');
const unpackedAppPath = join(repoRoot, 'release', 'win-unpacked');
const unpackedResourcesAppPath = join(unpackedAppPath, 'resources', 'app');
const installerPath = join(repoRoot, 'release', 'CommandCabin-0.1.0-x64-Setup.exe');

interface BuilderConfig {
  appId?: string;
  asar?: boolean;
  directories?: {
    app?: string;
    buildResources?: string;
    output?: string;
  };
  extraMetadata?: {
    main?: string;
    name?: string;
    productName?: string;
  };
  electronVersion?: string;
  files?: string[];
  nsis?: {
    artifactName?: string;
    createDesktopShortcut?: string;
    createStartMenuShortcut?: boolean;
    installerIcon?: string;
    shortcutName?: string;
    uninstallerIcon?: string;
    uninstallDisplayName?: string;
  };
  productName?: string;
  win?: {
    icon?: string;
    signAndEditExecutable?: boolean;
    target?: Array<{
      arch?: string[];
      target?: string;
    }>;
  };
}

interface DesktopPackageJson {
  devDependencies?: Record<string, string>;
  main?: string;
  productName?: string;
  scripts?: Record<string, string>;
}

interface PackagedAppMetadata {
  main?: string;
  name?: string;
  productName?: string;
  version?: string;
}

function readBuilderConfig(): BuilderConfig {
  return parse(readFileSync(builderConfigPath, 'utf8')) as BuilderConfig;
}

function readDesktopPackageJson(): DesktopPackageJson {
  return JSON.parse(readFileSync(desktopPackagePath, 'utf8')) as DesktopPackageJson;
}

function readIcoDirectory(path: string): { bitsPerPixel: number; height: number; width: number } {
  const icon = readFileSync(path);
  const reserved = icon.readUInt16LE(0);
  const imageType = icon.readUInt16LE(2);
  const imageCount = icon.readUInt16LE(4);

  expect(reserved).toBe(0);
  expect(imageType).toBe(1);
  expect(imageCount).toBeGreaterThanOrEqual(1);

  const width = icon[6] === 0 ? 256 : icon[6];
  const height = icon[7] === 0 ? 256 : icon[7];
  const bitsPerPixel = icon.readUInt16LE(12);

  return { bitsPerPixel, height, width };
}

function listFilesRecursive(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
    } else {
      files.push(entryPath);
    }
  }

  return files;
}

describe('desktop packaging configuration', () => {
  test('uses an explicit root electron-builder project with the desktop app directory', () => {
    const config = readBuilderConfig();

    expect(config.appId).toBe('com.commandcabin.app');
    expect(config.electronVersion).toBe('39.0.0');
    expect(config.productName).toBe('CommandCabin');
    expect(config.directories).toEqual({
      app: 'apps/desktop',
      buildResources: 'apps/desktop/build',
      output: 'release',
    });
    expect(config.extraMetadata).toMatchObject({
      main: 'out/main/index.js',
      name: 'command-cabin',
      productName: 'CommandCabin',
    });
    expect(config.asar).toBe(false);
    expect(config.files).toEqual(
      expect.arrayContaining([
        'out/**',
        'package.json',
        'build/icon.ico',
        '!**/*.map',
        '!**/*.test.*',
        '!**/*.tsbuildinfo',
        '!**/src/**',
        '!**/tests/**',
        '!**/vitest.config.*',
        '!**/tsconfig*.json',
        '!node_modules/@command-cabin/**/dist/*.tsbuildinfo',
        '!node_modules/@command-cabin/**/tsconfig*.json',
        '!node_modules/@command-cabin/**/vitest.config.*',
      ]),
    );
  });

  test('configures Windows NSIS x64 installer metadata and a valid icon', () => {
    const config = readBuilderConfig();
    const iconDirectory = readIcoDirectory(windowsIconPath);

    expect(config.win?.icon).toBe('apps/desktop/build/icon.ico');
    expect(config.win?.signAndEditExecutable).toBe(false);
    expect(config.win?.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.nsis).toEqual({
      artifactName: 'CommandCabin-${version}-${arch}-Setup.${ext}',
      installerIcon: 'apps/desktop/build/icon.ico',
      uninstallerIcon: 'apps/desktop/build/icon.ico',
      shortcutName: 'CommandCabin',
      uninstallDisplayName: 'CommandCabin',
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
    });
    expect(iconDirectory).toMatchObject({
      bitsPerPixel: 32,
      height: 256,
      width: 256,
    });
    expect(statSync(windowsIconPath).size).toBeGreaterThan(1024);
  });

  test('desktop package exposes self-sufficient packaging scripts and app naming for userData', () => {
    const packageJson = readDesktopPackageJson();

    expect(packageJson.main).toBe('./out/main/index.js');
    expect(packageJson.productName).toBe('CommandCabin');
    expect(packageJson.devDependencies?.['electron-builder']).toBeDefined();
    expect(packageJson.scripts?.package).toBe('node scripts/package-with-pnpm-shim.js');
    expect(packageJson.scripts?.['package:dir']).toBe(
      'node scripts/package-with-pnpm-shim.js --dir',
    );
    expect(packageJson.scripts?.['dist:win']).toBe(
      'node scripts/package-with-pnpm-shim.js --win --x64',
    );
  });

  test('package:dir artifact contains app metadata and native sqlite module when present', () => {
    if (!existsSync(unpackedResourcesAppPath)) {
      return;
    }

    const metadata = JSON.parse(
      readFileSync(join(unpackedResourcesAppPath, 'package.json'), 'utf8'),
    ) as PackagedAppMetadata;
    const appFiles = listFilesRecursive(unpackedResourcesAppPath).map((entry) =>
      normalize(entry).replace(normalize(unpackedResourcesAppPath), '').replaceAll('\\', '/'),
    );
    const unpackedNativeModule = join(
      unpackedResourcesAppPath,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    );

    expect(metadata).toMatchObject({
      main: 'out/main/index.js',
      name: 'command-cabin',
      productName: 'CommandCabin',
      version: '0.1.0',
    });
    expect(appFiles).toEqual(expect.arrayContaining(['/out/main/index.js']));
    expect(appFiles.some((path) => path.endsWith('.tsbuildinfo'))).toBe(false);
    expect(appFiles.some((path) => path.includes('vitest.config'))).toBe(false);
    expect(appFiles.some((path) => path.endsWith('/tsconfig.json'))).toBe(false);
    expect(existsSync(unpackedNativeModule)).toBe(true);

    const nativeModuleHash = createHash('sha256')
      .update(readFileSync(unpackedNativeModule))
      .digest('hex');
    expect(nativeModuleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(normalize(unpackedNativeModule)).toContain(
      normalize('resources/app/node_modules/better-sqlite3'),
    );
  });

  test('NSIS installer artifact is present after dist:win packaging has run', () => {
    if (!existsSync(installerPath)) {
      return;
    }

    expect(statSync(installerPath).size).toBeGreaterThan(10_000_000);
  });
});
