import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_SHORTCUT_RESOLVER_TIMEOUT_MS = 5_000;
const DEFAULT_APPS_FOLDER_SCANNER_TIMEOUT_MS = 3_000;
const DEFAULT_SHORTCUT_RESOLUTION_CONCURRENCY = 8;
const WINDOWS_APPS_FOLDER_PATH = 'shell:AppsFolder';

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
  resolveMany?: (shortcutPaths: readonly string[]) => Promise<Array<ResolvedShortcut | undefined>>;
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

export interface AppsFolderApp {
  name: string;
  appUserModelId: string;
}

export interface AppsFolderScanResult {
  apps: AppsFolderApp[];
  failures: StartMenuScanFailure[];
}

export interface WindowsAppsFolderScanner {
  scan: () => Promise<AppsFolderScanResult>;
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
  shortcutResolutionConcurrency?: number;
  appsFolderScanner?: WindowsAppsFolderScanner;
  env?: NodeJS.ProcessEnv;
}

interface PowerShellShortcutJson {
  targetPath?: unknown;
  arguments?: unknown;
  workingDirectory?: unknown;
  iconPath?: unknown;
  appUserModelId?: unknown;
}

interface PowerShellShortcutBatchItemJson extends PowerShellShortcutJson {
  shortcutPath?: unknown;
  error?: unknown;
}

interface PowerShellAppsFolderAppJson {
  name?: unknown;
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

function createPowerShellShortcutBatchResolverScript(shortcutPaths: readonly string[]): string {
  const encodedShortcutPaths = Buffer.from(JSON.stringify(shortcutPaths), 'utf8').toString(
    'base64',
  );

  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ShortcutPathsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedShortcutPaths}'))
$ShortcutPaths = @($ShortcutPathsJson | ConvertFrom-Json)
$results = New-Object System.Collections.Generic.List[object]
foreach ($ShortcutPath in $ShortcutPaths) {
  try {
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
    [void]$results.Add([pscustomobject]@{
      shortcutPath = $ShortcutPath
      targetPath = $shortcut.TargetPath
      arguments = $shortcut.Arguments
      workingDirectory = $shortcut.WorkingDirectory
      iconPath = $shortcut.IconLocation
      appUserModelId = $appUserModelId
    })
  } catch {
    [void]$results.Add([pscustomobject]@{
      shortcutPath = $ShortcutPath
      error = $_.Exception.Message
    })
  }
}
$results | ConvertTo-Json -Compress
`;
}

function createPowerShellAppsFolderScannerScript(): string {
  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$apps = New-Object System.Collections.Generic.List[object]
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('shell:AppsFolder')
if ($null -ne $folder) {
  foreach ($item in @($folder.Items())) {
    $name = $item.Name
    $appUserModelId = $item.Path
    if (
      $name -is [string] -and
      $name.Trim().Length -gt 0 -and
      $appUserModelId -is [string] -and
      $appUserModelId.Contains('!') -and
      -not $appUserModelId.Contains('\\')
    ) {
      [void]$apps.Add([pscustomobject]@{
        name = $name
        appUserModelId = $appUserModelId
      })
    }
  }
}
$apps | ConvertTo-Json -Compress
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

function normalizeJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function createResolvedShortcutFromParsedJson(parsed: unknown): ResolvedShortcut {
  const shortcut: ResolvedShortcut = {};

  if (!parsed || typeof parsed !== 'object') {
    return shortcut;
  }

  const json = parsed as PowerShellShortcutJson;
  const targetPath = getOptionalString(json.targetPath);
  const shortcutArguments = getOptionalString(json.arguments);
  const workingDirectory = getOptionalString(json.workingDirectory);
  const iconPath = getOptionalString(json.iconPath);
  const appUserModelId = getOptionalString(json.appUserModelId);

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
}

function parsePowerShellShortcutBatchItem(parsed: unknown): ResolvedShortcut | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const json = parsed as PowerShellShortcutBatchItemJson;

  if (getOptionalString(json.error) !== undefined) {
    return undefined;
  }

  return createResolvedShortcutFromParsedJson(json);
}

function isValidAppUserModelId(value: string): boolean {
  const trimmedValue = value.trim();
  const separatorIndex = trimmedValue.indexOf('!');

  return (
    separatorIndex > 0 && separatorIndex < trimmedValue.length - 1 && !trimmedValue.includes('\\')
  );
}

function parseAppsFolderScannerOutput(stdout: string): AppsFolderApp[] {
  const trimmedOutput = stdout.trim();

  if (trimmedOutput.length === 0) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmedOutput);
  } catch (error) {
    throw new Error(`Failed to parse AppsFolder scanner output: ${formatThrownValue(error)}`, {
      cause: error,
    });
  }

  return normalizeJsonArray(parsed)
    .map((entry): AppsFolderApp | undefined => {
      if (!entry || typeof entry !== 'object') {
        return undefined;
      }

      const parsed = entry as PowerShellAppsFolderAppJson;
      const name = getOptionalString(parsed.name);
      const appUserModelId = getOptionalString(parsed.appUserModelId);

      if (
        name === undefined ||
        appUserModelId === undefined ||
        !isValidAppUserModelId(appUserModelId)
      ) {
        return undefined;
      }

      return {
        name,
        appUserModelId,
      };
    })
    .filter((entry): entry is AppsFolderApp => entry !== undefined);
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

      let parsed: unknown;

      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        throw new Error(`Failed to parse shortcut resolution output: ${formatThrownValue(error)}`, {
          cause: error,
        });
      }

      return createResolvedShortcutFromParsedJson(parsed);
    },
    resolveMany: async (shortcutPaths) => {
      if (platform !== 'win32') {
        throw new Error('Default .lnk shortcut resolution is only available on Windows.');
      }

      if (shortcutPaths.length === 0) {
        return [];
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
            createEncodedPowerShellCommand(
              createPowerShellShortcutBatchResolverScript(shortcutPaths),
            ),
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

      let parsed: unknown;

      try {
        parsed = JSON.parse(stdout);
      } catch {
        return shortcutPaths.map(() => undefined);
      }

      const parsedItems = normalizeJsonArray(parsed);

      return shortcutPaths.map((_shortcutPath, index) =>
        parsePowerShellShortcutBatchItem(parsedItems[index]),
      );
    },
  };
}

export function createWindowsAppsFolderScanner(
  options: WindowsShortcutResolverOptions = {},
): WindowsAppsFolderScanner {
  const platform = options.platform ?? process.platform;
  const runExecFile = options.execFile ?? defaultWindowsShortcutResolverExecFile;
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPS_FOLDER_SCANNER_TIMEOUT_MS;

  return {
    scan: async () => {
      if (platform !== 'win32') {
        return {
          apps: [],
          failures: [],
        };
      }

      try {
        const { stdout } = await runExecFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            createEncodedPowerShellCommand(createPowerShellAppsFolderScannerScript()),
          ],
          {
            windowsHide: true,
            timeout: timeoutMs,
            encoding: 'utf8',
          },
        );

        return {
          apps: parseAppsFolderScannerOutput(stdout),
          failures: [],
        };
      } catch (error) {
        return {
          apps: [],
          failures: [
            {
              directoryPath: WINDOWS_APPS_FOLDER_PATH,
              message: isExecFileTimeoutError(error)
                ? `AppsFolder scan timed out after ${timeoutMs} ms.`
                : formatThrownValue(error),
            },
          ],
        };
      }
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

function createAppsFolderShortcut(app: AppsFolderApp): StartMenuShortcut {
  return {
    name: app.name,
    appUserModelId: app.appUserModelId,
    opensApplication: true,
    shortcutPath: `${WINDOWS_APPS_FOLDER_PATH}\\${app.appUserModelId}`,
  };
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

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(values[currentIndex]!);
      }
    }),
  );

  return results;
}

export function createWindowsStartMenuScanner(
  options: WindowsStartMenuScannerOptions = {},
): WindowsStartMenuScanner {
  const fileSystem = options.fileSystem ?? createDefaultFileSystem();
  const shortcutResolver = options.shortcutResolver ?? createWindowsShortcutResolver();
  const desktopShortcutResolver = options.desktopShortcutResolver ?? shortcutResolver;
  const appsFolderScanner = options.appsFolderScanner ?? createWindowsAppsFolderScanner();
  const startMenuDirectories =
    options.startMenuDirectories ?? getDefaultWindowsStartMenuDirectories(options.env);
  const desktopDirectories = options.desktopDirectories ?? [];
  const shortcutResolutionConcurrency = Math.max(
    1,
    Math.floor(options.shortcutResolutionConcurrency ?? DEFAULT_SHORTCUT_RESOLUTION_CONCURRENCY),
  );

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

    const shortcutPaths: string[] = [];

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

      shortcutPaths.push(entryPath);
    }

    if (shortcutPaths.length === 0) {
      return;
    }

    const resolveMany = scanOptions.shortcutResolver.resolveMany;

    if (resolveMany !== undefined) {
      let resolvedShortcuts: Array<ResolvedShortcut | undefined>;

      try {
        resolvedShortcuts = await resolveMany(shortcutPaths);
      } catch (error) {
        const message = formatThrownValue(error);

        for (const shortcutPath of shortcutPaths) {
          result.failures.push({ shortcutPath, message });
        }
        return;
      }

      for (let index = 0; index < shortcutPaths.length; index += 1) {
        const shortcutPath = shortcutPaths[index]!;
        const resolvedShortcut = resolvedShortcuts[index];

        if (resolvedShortcut === undefined) {
          result.failures.push({
            shortcutPath,
            message: 'Failed to resolve shortcut.',
          });
          if (scanOptions.includeUnresolvedShortcuts) {
            result.shortcuts.push(mergeShortcut(shortcutPath, {}, scanOptions.opensApplication));
          }
          continue;
        }

        result.shortcuts.push(
          mergeShortcut(shortcutPath, resolvedShortcut, scanOptions.opensApplication),
        );
      }
      return;
    }

    const resolvedShortcuts = await mapWithConcurrency(
      shortcutPaths,
      shortcutResolutionConcurrency,
      async (shortcutPath) => {
        try {
          return {
            shortcut: mergeShortcut(
              shortcutPath,
              await scanOptions.shortcutResolver.resolve(shortcutPath),
              scanOptions.opensApplication,
            ),
          };
        } catch (error) {
          return {
            failure: {
              shortcutPath,
              message: formatThrownValue(error),
            },
            ...(scanOptions.includeUnresolvedShortcuts
              ? { shortcut: mergeShortcut(shortcutPath, {}, scanOptions.opensApplication) }
              : {}),
          };
        }
      },
    );

    for (const resolved of resolvedShortcuts) {
      if (resolved.shortcut !== undefined) {
        result.shortcuts.push(resolved.shortcut);
      }
      if ('failure' in resolved) {
        result.failures.push(resolved.failure);
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

      const appsFolderResult = await appsFolderScanner.scan();
      result.shortcuts.push(...appsFolderResult.apps.map(createAppsFolderShortcut));
      result.failures.push(...appsFolderResult.failures);

      return result;
    },
  };
}
