import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const shimDir = join(desktopRoot, '.package-bin');
const pathSeparator = process.platform === 'win32' ? ';' : ':';
const packageArgs = process.argv.slice(2);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? desktopRoot,
    env: options.env ?? process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function writePnpmShim() {
  rmSync(shimDir, { force: true, recursive: true });
  mkdirSync(shimDir, { recursive: true });

  if (process.platform === 'win32') {
    writeFileSync(join(shimDir, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm %*\r\n');
    return;
  }

  writeFileSync(join(shimDir, 'pnpm'), '#!/usr/bin/env sh\ncorepack pnpm "$@"\n', {
    mode: 0o755,
  });
}

writePnpmShim();
run('corepack', [
  'pnpm',
  '--dir',
  repoRoot,
  '-r',
  '--filter',
  '@command-cabin/plugin-api',
  '--filter',
  '@command-cabin/core',
  '--filter',
  '@command-cabin/built-in-plugin-calculator',
  '--filter',
  '@command-cabin/built-in-plugin-clipboard-history',
  '--filter',
  '@command-cabin/built-in-plugin-quick-converter',
  '--filter',
  '@command-cabin/built-in-plugin-text-tools',
  '--filter',
  '@command-cabin/desktop',
  '--if-present',
  'build',
]);

if (packageArgs.includes('--dir')) {
  packageArgs.push('-c.win.signAndEditExecutable=false');
}

run(
  'electron-builder',
  [...packageArgs, '--projectDir', repoRoot, '--config', 'electron-builder.yml'],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${shimDir}${pathSeparator}${process.env.PATH ?? ''}`,
    },
  },
);
