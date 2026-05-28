import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { setBoundedMapEntry } from './boundedMemoryCache.js';

const execFileAsync = promisify(execFile);
const DEFAULT_ASSOCIATED_ICON_TIMEOUT_MS = 1_000;
const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 96;
const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

export interface WindowsAssociatedIconResolverExecFileOptions {
  windowsHide: true;
  timeout: number;
  encoding: 'utf8';
}

export interface WindowsAssociatedIconResolverExecFileResult {
  stdout: string;
}

export type WindowsAssociatedIconResolverExecFile = (
  file: string,
  args: readonly string[],
  options: WindowsAssociatedIconResolverExecFileOptions,
) => Promise<WindowsAssociatedIconResolverExecFileResult>;

export interface WindowsAssociatedIconResolverOptions {
  execFile?: WindowsAssociatedIconResolverExecFile;
  logger?: Pick<Console, 'warn'>;
  memoryCacheMaxEntries?: number;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export interface WindowsAssociatedIconResolver {
  resolve: (filePath: string) => Promise<string | undefined>;
}

function createPowerShellScript(filePath: string): string {
  const encodedFilePath = Buffer.from(filePath, 'utf8').toString('base64');

  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$FilePath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedFilePath}'))
if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  exit 0
}

Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($FilePath)
if ($null -eq $icon) {
  exit 0
}

$bitmap = $icon.ToBitmap()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$base64 = [System.Convert]::ToBase64String($stream.ToArray())
Write-Output ("data:image/png;base64,{0}" -f $base64)
`;
}

function createEncodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const defaultExecFile: WindowsAssociatedIconResolverExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], options);

  return {
    stdout: String(stdout),
  };
};

export function createWindowsAssociatedIconResolver({
  execFile = defaultExecFile,
  logger = console,
  memoryCacheMaxEntries = DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
  platform = process.platform,
  timeoutMs = DEFAULT_ASSOCIATED_ICON_TIMEOUT_MS,
}: WindowsAssociatedIconResolverOptions = {}): WindowsAssociatedIconResolver {
  const iconCache = new Map<string, string | undefined>();

  return {
    resolve: async (filePath) => {
      const trimmedFilePath = filePath.trim();

      if (trimmedFilePath.length === 0 || platform !== 'win32') {
        return undefined;
      }

      const cacheKey = trimmedFilePath.toLowerCase();

      if (iconCache.has(cacheKey)) {
        return iconCache.get(cacheKey);
      }

      try {
        const { stdout } = await execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            createEncodedPowerShellCommand(createPowerShellScript(trimmedFilePath)),
          ],
          {
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true,
          },
        );
        const dataUrl = stdout.trim();
        const resolvedIcon = IMAGE_DATA_URL_PATTERN.test(dataUrl) ? dataUrl : undefined;

        setBoundedMapEntry(iconCache, cacheKey, resolvedIcon, memoryCacheMaxEntries);
        return resolvedIcon;
      } catch (error) {
        logger.warn('Failed to extract associated Windows file icon.', error);
        setBoundedMapEntry(iconCache, cacheKey, undefined, memoryCacheMaxEntries);
        return undefined;
      }
    },
  };
}
