import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_SHORTCUT_RESOLVER_TIMEOUT_MS = 5_000;

export type StartMenuDirectoryEntryKind = 'file' | 'directory' | 'other';

export interface StartMenuDirectoryEntry {
  name: string;
  kind: StartMenuDirectoryEntryKind;
}

export interface StartMenuFileSystem {
  readDirectory: (directoryPath: string) => Promise<StartMenuDirectoryEntry[]>;
}

export interface ResolvedShortcut {
  targetPath?: string;
  arguments?: string;
  workingDirectory?: string;
  iconPath?: string;
  appUserModelId?: string;
}

export interface ShortcutResolver {
  resolve: (shortcutPath: string) => Promise<ResolvedShortcut>;
}

export interface WindowsShortcutResolverExecFileOptions {
  windowsHide: true;
  timeout: number;
  encoding: 'utf8';
}

export interface WindowsShortcutResolverExecFileResult {
  stdout: string;
}

export type WindowsShortcutResolverExecFile = (
  file: string,
  args: readonly string[],
  options: WindowsShortcutResolverExecFileOptions,
) => Promise<WindowsShortcutResolverExecFileResult>;

export interface WindowsShortcutResolverOptions {
  platform?: NodeJS.Platform;
  execFile?: WindowsShortcutResolverExecFile;
  timeoutMs?: number;
}

export interface StartMenuShortcut extends ResolvedShortcut {
  name: string;
  opensApplication?: boolean;
  shortcutPath: string;
}

export interface StartMenuScanFailure {
  shortcutPath?: string;
  directoryPath?: string;
  message: string;
}

export interface StartMenuScanResult {
  shortcuts: StartMenuShortcut[];
  failures: StartMenuScanFailure[];
}

export interface WindowsStartMenuScanner {
  scan: () => Promise<StartMenuScanResult>;
}

export interface WindowsStartMenuScannerOptions {
  desktopDirectories?: readonly string[];
  desktopShortcutResolver?: ShortcutResolver;
  startMenuDirectories?: readonly string[];
  fileSystem?: StartMenuFileSystem;
  shortcutResolver?: ShortcutResolver;
  env?: NodeJS.ProcessEnv;
}

interface PowerShellShortcutJson {
  targetPath?: unknown;
  arguments?: unknown;
  workingDirectory?: unknown;
  iconPath?: unknown;
  appUserModelId?: unknown;
}

function createPowerShellShortcutResolverScript(shortcutPath: string): string {
  const encodedShortcutPath = Buffer.from(shortcutPath, 'utf8').toString('base64');

  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ShortcutPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedShortcutPath}'))
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$appUserModelId = $null
try {
  $shellApplication = New-Object -ComObject Shell.Application
  $folderPath = [System.IO.Path]::GetDirectoryName($ShortcutPath)
  $fileName = [System.IO.Path]::GetFileName($ShortcutPath)
  $folder = $shellApplication.Namespace($folderPath)
  if ($null -ne $folder) {
    $item = $folder.ParseName($fileName)
    if ($null -ne $item) {
      $linkTarget = $folder.GetDetailsOf($item, 204)
      if ($linkTarget -is [string] -and $linkTarget.Contains('!') -and -not $linkTarget.Contains('\\')) {
        $appUserModelId = $linkTarget
      }
    }
  }
} catch {
  $appUserModelId = $null
}
[pscustomobject]@{
  targetPath = $shortcut.TargetPath
  arguments = $shortcut.Arguments
  workingDirectory = $shortcut.WorkingDirectory
  iconPath = $shortcut.IconLocation
  appUserModelId = $appUserModelId
} | ConvertTo-Json -Compress
`;
}

function createEncodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function formatThrownValue(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.length > 0 ? value : undefined;
}

function createDefaultFileSystem(): StartMenuFileSystem {
  return {
    readDirectory: async (directoryPath) => {
      const entries = await readdir(directoryPath, { withFileTypes: true });

      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));
    },
  };
}

interface ExecFileError {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
}

function isExecFileTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const execFileError = error as ExecFileError;

  return (
    execFileError.code === 'ETIMEDOUT' ||
    (execFileError.killed === true && execFileError.signal === 'SIGTERM')
  );
}

const defaultWindowsShortcutResolverExecFile: WindowsShortcutResolverExecFile = async (
  file,
  args,
  options,
) => {
  const { stdout } = await execFileAsync(file, [...args], options);

  return {
    stdout: String(stdout),
  };
};

export function createWindowsShortcutResolver(
  options: WindowsShortcutResolverOptions = {},
): ShortcutResolver {
  const platform = options.platform ?? process.platform;
  const runExecFile = options.execFile ?? defaultWindowsShortcutResolverExecFile;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHORTCUT_RESOLVER_TIMEOUT_MS;

  return {
    resolve: async (shortcutPath) => {
      if (platform !== 'win32') {
        throw new Error('Default .lnk shortcut resolution is only available on Windows.');
      }

      let stdout: string;

      try {
        ({ stdout } = await runExecFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            createEncodedPowerShellCommand(createPowerShellShortcutResolverScript(shortcutPath)),
          ],
          {
            windowsHide: true,
            timeout: timeoutMs,
            encoding: 'utf8',
          },
        ));
      } catch (error) {
        if (isExecFileTimeoutError(error)) {
          throw new Error(`Shortcut resolution timed out after ${timeoutMs} ms.`, {
            cause: error,
          });
        }

        throw error;
      }

      const parsed = JSON.parse(stdout) as PowerShellShortcutJson;
      const shortcut: ResolvedShortcut = {};

      const targetPath = getOptionalString(parsed.targetPath);
      const shortcutArguments = getOptionalString(parsed.arguments);
      const workingDirectory = getOptionalString(parsed.workingDirectory);
      const iconPath = getOptionalString(parsed.iconPath);
      const appUserModelId = getOptionalString(parsed.appUserModelId);

      if (targetPath !== undefined) {
        shortcut.targetPath = targetPath;
      }
      if (shortcutArguments !== undefined) {
        shortcut.arguments = shortcutArguments;
      }
      if (workingDirectory !== undefined) {
        shortcut.workingDirectory = workingDirectory;
      }
      if (iconPath !== undefined) {
        shortcut.iconPath = iconPath;
      }
      if (appUserModelId !== undefined) {
        shortcut.appUserModelId = appUserModelId;
      }

      return shortcut;
    },
  };
}

function compareDirectoryEntries(
  left: StartMenuDirectoryEntry,
  right: StartMenuDirectoryEntry,
): number {
  if (left.kind !== right.kind) {
    if (left.kind === 'directory') {
      return -1;
    }
    if (right.kind === 'directory') {
      return 1;
    }
  }

  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

function isShortcutFile(entry: StartMenuDirectoryEntry): boolean {
  return entry.kind === 'file' && entry.name.toLowerCase().endsWith('.lnk');
}

function getShortcutName(shortcutPath: string): string {
  return path.basename(shortcutPath, path.extname(shortcutPath));
}

function mergeShortcut(
  shortcutPath: string,
  resolvedShortcut: ResolvedShortcut,
  opensApplication: boolean,
): StartMenuShortcut {
  const shortcut: StartMenuShortcut = {
    name: getShortcutName(shortcutPath),
    shortcutPath,
    ...resolvedShortcut,
  };

  if (opensApplication) {
    shortcut.opensApplication = true;
  }

  return shortcut;
}

export function getDefaultWindowsStartMenuDirectories(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const directories: string[] = [];

  if (env.APPDATA) {
    directories.push(path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }

  if (env.ProgramData) {
    directories.push(path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }

  return Array.from(new Set(directories));
}

export function getDefaultWindowsDesktopDirectories(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const directories: string[] = [];

  if (env.USERPROFILE) {
    directories.push(path.join(env.USERPROFILE, 'Desktop'));
  }

  if (env.PUBLIC) {
    directories.push(path.join(env.PUBLIC, 'Desktop'));
  }

  return Array.from(new Set(directories));
}

interface ScanDirectoryOptions {
  includeUnresolvedShortcuts: boolean;
  opensApplication: boolean;
  recurse: boolean;
  shortcutResolver: ShortcutResolver;
}

export function createWindowsStartMenuScanner(
  options: WindowsStartMenuScannerOptions = {},
): WindowsStartMenuScanner {
  const fileSystem = options.fileSystem ?? createDefaultFileSystem();
  const shortcutResolver = options.shortcutResolver ?? createWindowsShortcutResolver();
  const desktopShortcutResolver = options.desktopShortcutResolver ?? shortcutResolver;
  const startMenuDirectories =
    options.startMenuDirectories ?? getDefaultWindowsStartMenuDirectories(options.env);
  const desktopDirectories = options.desktopDirectories ?? [];

  async function scanDirectory(
    directoryPath: string,
    result: StartMenuScanResult,
    scanOptions: ScanDirectoryOptions,
  ): Promise<void> {
    let entries: StartMenuDirectoryEntry[];

    try {
      entries = await fileSystem.readDirectory(directoryPath);
    } catch (error) {
      result.failures.push({
        directoryPath,
        message: formatThrownValue(error),
      });
      return;
    }

    for (const entry of [...entries].sort(compareDirectoryEntries)) {
      const entryPath = path.join(directoryPath, entry.name);

      if (entry.kind === 'directory') {
        if (scanOptions.recurse) {
          await scanDirectory(entryPath, result, scanOptions);
        }
        continue;
      }

      if (!isShortcutFile(entry)) {
        continue;
      }

      try {
        result.shortcuts.push(
          mergeShortcut(
            entryPath,
            await scanOptions.shortcutResolver.resolve(entryPath),
            scanOptions.opensApplication,
          ),
        );
      } catch (error) {
        result.failures.push({
          shortcutPath: entryPath,
          message: formatThrownValue(error),
        });

        if (scanOptions.includeUnresolvedShortcuts) {
          result.shortcuts.push(mergeShortcut(entryPath, {}, scanOptions.opensApplication));
        }
      }
    }
  }

  return {
    scan: async () => {
      const result: StartMenuScanResult = {
        shortcuts: [],
        failures: [],
      };

      for (const directoryPath of startMenuDirectories) {
        await scanDirectory(directoryPath, result, {
          includeUnresolvedShortcuts: false,
          opensApplication: false,
          recurse: true,
          shortcutResolver,
        });
      }

      for (const directoryPath of desktopDirectories) {
        await scanDirectory(directoryPath, result, {
          includeUnresolvedShortcuts: true,
          opensApplication: true,
          recurse: false,
          shortcutResolver: desktopShortcutResolver,
        });
      }

      return result;
    },
  };
}
