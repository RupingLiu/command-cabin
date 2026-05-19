import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = process.cwd();
const builderConfigPath = join(repoRoot, 'electron-builder.yml');
const rootPackagePath = join(repoRoot, 'package.json');
const desktopPackagePath = join(repoRoot, 'apps', 'desktop', 'package.json');
const desktopMainEntryPath = join(repoRoot, 'apps', 'desktop', 'src', 'main', 'index.ts');
const installerIncludePath = join(repoRoot, 'apps', 'desktop', 'build', 'installer.nsh');
const afterPackIconHookPath = join(
  repoRoot,
  'apps',
  'desktop',
  'scripts',
  'after-pack-windows-icon.cjs',
);
const windowsIconPath = join(repoRoot, 'apps', 'desktop', 'build', 'icon.ico');
const versioningPolicyPath = join(repoRoot, 'docs', 'product', 'versioning-policy.md');
const unpackedAppPath = join(repoRoot, 'release', 'win-unpacked');
const unpackedResourcesAppPath = join(unpackedAppPath, 'resources', 'app');
const workspacePackagePaths = [
  rootPackagePath,
  desktopPackagePath,
  join(repoRoot, 'packages', 'core', 'package.json'),
  join(repoRoot, 'packages', 'plugin-api', 'package.json'),
  join(repoRoot, 'packages', 'built-in-plugins', 'calculator', 'package.json'),
  join(repoRoot, 'packages', 'built-in-plugins', 'clipboard-history', 'package.json'),
  join(repoRoot, 'packages', 'built-in-plugins', 'quick-converter', 'package.json'),
  join(repoRoot, 'packages', 'built-in-plugins', 'text-tools', 'package.json'),
] as const;
const strictProductVersionPattern = /^\d+\.\d+\.\d+$/;

interface BuilderConfig {
  afterPack?: string;
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
  publish?: Array<{
    owner?: string;
    provider?: string;
    repo?: string;
  }>;
  electronVersion?: string;
  files?: string[];
  nsis?: {
    allowToChangeInstallationDirectory?: boolean;
    artifactName?: string;
    createDesktopShortcut?: string;
    createStartMenuShortcut?: boolean;
    include?: string;
    installerIcon?: string;
    oneClick?: boolean;
    perMachine?: boolean;
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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  productName?: string;
  scripts?: Record<string, string>;
  version?: string;
}

interface PackageJson {
  name?: string;
  version?: string;
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

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

function readRootPackageVersion(): string {
  const version = readPackageJson(rootPackagePath).version;

  if (version === undefined) {
    throw new Error('Root package version is missing.');
  }

  return version;
}

function getInstallerPath(): string {
  return join(repoRoot, 'release', `CommandCabin-${readRootPackageVersion()}-x64-Setup.exe`);
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
  test('documents the CommandCabin x.y.z product version policy', () => {
    const policy = readFileSync(versioningPolicyPath, 'utf8');

    expect(policy).toContain('x.y.z');
    expect(policy).toContain('x:');
    expect(policy).toContain('y:');
    expect(policy).toContain('z:');
    expect(policy).toContain('breaking');
    expect(policy).toContain('user-visible');
    expect(policy).toContain('Bug fixes');
  });

  test('keeps workspace package versions aligned to strict x.y.z', () => {
    const rootPackage = readPackageJson(rootPackagePath);

    expect(rootPackage.version).toMatch(strictProductVersionPattern);

    for (const packagePath of workspacePackagePaths) {
      const packageJson = readPackageJson(packagePath);

      expect(packageJson.version).toBe(rootPackage.version);
      expect(packageJson.version).toMatch(strictProductVersionPattern);
    }
  });

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
    expect(config.afterPack).toBe('apps/desktop/scripts/after-pack-windows-icon.cjs');
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
    expect(config.publish).toEqual([
      {
        owner: 'RupingLiu',
        provider: 'github',
        repo: 'command-cabin',
      },
    ]);
  });

  test('configures Windows NSIS x64 installer metadata and a valid icon', () => {
    const config = readBuilderConfig();
    const iconDirectory = readIcoDirectory(windowsIconPath);

    expect(config.win?.icon).toBe('apps/desktop/build/icon.ico');
    expect(config.win?.signAndEditExecutable).toBe(false);
    expect(config.win?.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.nsis).toEqual({
      allowToChangeInstallationDirectory: true,
      artifactName: 'CommandCabin-${version}-${arch}-Setup.${ext}',
      include: 'apps/desktop/build/installer.nsh',
      installerIcon: 'apps/desktop/build/icon.ico',
      oneClick: false,
      perMachine: true,
      uninstallerIcon: 'apps/desktop/build/icon.ico',
      shortcutName: 'CommandCabin',
      uninstallDisplayName: 'CommandCabin',
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
    });
    const installerInclude = readFileSync(installerIncludePath, 'utf8');
    expect(installerInclude).toContain('!macro preInit');
    expect(installerInclude).toContain('!macro customInstall');
    expect(installerInclude).toContain('C:\\Program Files\\command-cabin');
    expect(installerInclude).toContain('InstallLocation');
    expect(installerInclude).toContain('ReadEnvStr $0 "LOCALAPPDATA"');
    expect(installerInclude).toContain('$0\\Programs\\command-cabin');
    expect(installerInclude).toContain('SHChangeNotify');
    const afterPackIconHook = readFileSync(afterPackIconHookPath, 'utf8');
    expect(afterPackIconHook).toContain('rcedit');
    expect(afterPackIconHook).toContain("'build', 'icon.ico'");
    expect(afterPackIconHook).toContain('CommandCabin.exe');
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
    expect(packageJson.dependencies?.['electron-updater']).toBeDefined();
    expect(packageJson.devDependencies?.['electron-builder']).toBeDefined();
    expect(packageJson.scripts?.package).toBe('node scripts/package-with-pnpm-shim.js');
    expect(packageJson.scripts?.['package:dir']).toBe(
      'node scripts/package-with-pnpm-shim.js --dir',
    );
    expect(packageJson.scripts?.['dist:win']).toBe(
      'node scripts/package-with-pnpm-shim.js --win --x64',
    );
  });

  test('loads electron-updater through CommonJS interop for the ESM main process', () => {
    const mainEntry = readFileSync(desktopMainEntryPath, 'utf8');

    expect(mainEntry).toContain('createRequire(import.meta.url)');
    expect(mainEntry).toContain("require('electron-updater')");
    expect(mainEntry).not.toContain("import { autoUpdater } from 'electron-updater'");
  });

  test('package:dir artifact contains app metadata and avoids native sqlite modules', () => {
    if (!existsSync(unpackedResourcesAppPath)) {
      return;
    }

    const metadata = JSON.parse(
      readFileSync(join(unpackedResourcesAppPath, 'package.json'), 'utf8'),
    ) as PackagedAppMetadata;
    const appFiles = listFilesRecursive(unpackedResourcesAppPath).map((entry) =>
      normalize(entry).replace(normalize(unpackedResourcesAppPath), '').replaceAll('\\', '/'),
    );

    expect(metadata).toMatchObject({
      main: 'out/main/index.js',
      name: 'command-cabin',
      productName: 'CommandCabin',
      version: readRootPackageVersion(),
    });
    expect(appFiles).toEqual(expect.arrayContaining(['/out/main/index.js']));
    expect(appFiles.some((path) => path.endsWith('.tsbuildinfo'))).toBe(false);
    expect(appFiles.some((path) => path.includes('vitest.config'))).toBe(false);
    expect(appFiles.some((path) => path.endsWith('/tsconfig.json'))).toBe(false);
    expect(appFiles.some((path) => path.includes('/node_modules/better-sqlite3/'))).toBe(false);
    expect(appFiles.some((path) => path.endsWith('.node'))).toBe(false);
  });

  test('NSIS installer artifact is present after dist:win packaging has run', () => {
    const installerPath = getInstallerPath();

    if (!existsSync(installerPath)) {
      return;
    }

    expect(statSync(installerPath).size).toBeGreaterThan(10_000_000);
  });
});
