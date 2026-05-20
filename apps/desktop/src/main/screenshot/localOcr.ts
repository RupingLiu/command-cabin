import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { app, nativeImage } from 'electron';

import type { ScreenshotOcrRequest, ScreenshotOcrResult } from '../../shared/screenshotApi.js';
import { parseScreenshotOcrResult } from '../../shared/screenshotApi.js';

const execFileAsync = promisify(execFile);
const DEFAULT_OCR_TIMEOUT_MS = 10_000;

export interface LocalOcrExecFileOptions {
  encoding: 'utf8';
  timeout: number;
  windowsHide: true;
}

export interface LocalOcrExecFileResult {
  stdout: string;
}

export type LocalOcrExecFile = (
  file: string,
  args: readonly string[],
  options: LocalOcrExecFileOptions,
) => Promise<LocalOcrExecFileResult>;

export interface RunLocalOcrDependencies {
  execFile?: LocalOcrExecFile | undefined;
  getTempPath?: (() => string) | undefined;
  randomUUID?: (() => string) | undefined;
  timeoutMs?: number | undefined;
  unlink?: ((path: string) => Promise<unknown> | unknown) | undefined;
  writeFile?: ((path: string, data: Buffer) => Promise<unknown> | unknown) | undefined;
  writePngFromDataUrl?: ((imageDataUrl: string) => Buffer) | undefined;
}

function createEncodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function createPowerShellOcrScript(imagePath: string, language: string): string {
  const encodedImagePath = Buffer.from(imagePath, 'utf8').toString('base64');

  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# ImagePath: ${imagePath}
$ImagePath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedImagePath}'))
$Language = [Windows.Globalization.Language]::new('${language}')

function Write-OcrJson($Value) {
  $Value | ConvertTo-Json -Compress -Depth 5
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null

  $source = @"
using System.Threading.Tasks;
using Windows.Foundation;

public static class CommandCabinWinRtAsync
{
  public static Task<T> AsTask<T>(IAsyncOperation<T> operation)
  {
    return System.WindowsRuntimeSystemExtensions.AsTask(operation);
  }
}
"@
  Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Runtime.WindowsRuntime' -ErrorAction Stop

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($Language)
  if ($null -eq $engine) {
    Write-OcrJson ([PSCustomObject]@{
      status = 'unavailable'
      language = '${language}'
      message = 'Windows OCR is not available for the selected language.'
    })
    exit 0
  }

  $file = [CommandCabinWinRtAsync]::AsTask[Windows.Storage.StorageFile](
    [Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)
  ).GetAwaiter().GetResult()
  $stream = [CommandCabinWinRtAsync]::AsTask[Windows.Storage.Streams.IRandomAccessStream](
    $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
  ).GetAwaiter().GetResult()
  $decoder = [CommandCabinWinRtAsync]::AsTask[Windows.Graphics.Imaging.BitmapDecoder](
    [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
  ).GetAwaiter().GetResult()
  $bitmap = [CommandCabinWinRtAsync]::AsTask[Windows.Graphics.Imaging.SoftwareBitmap](
    $decoder.GetSoftwareBitmapAsync()
  ).GetAwaiter().GetResult()
  $result = [CommandCabinWinRtAsync]::AsTask[Windows.Media.Ocr.OcrResult](
    $engine.RecognizeAsync($bitmap)
  ).GetAwaiter().GetResult()
  $lines = @($result.Lines | ForEach-Object { $_.Text })

  Write-OcrJson ([PSCustomObject]@{
    status = 'success'
    language = '${language}'
    text = ($lines -join "\`n")
    lines = $lines
  })
} catch {
  Write-OcrJson ([PSCustomObject]@{
    status = 'unavailable'
    language = '${language}'
    message = if ($_.Exception.Message) { $_.Exception.Message } else { 'Windows OCR is unavailable.' }
  })
}
`;
}

const defaultExecFile: LocalOcrExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], options);

  return {
    stdout: String(stdout),
  };
};

function writePngFromDataUrl(imageDataUrl: string): Buffer {
  return nativeImage.createFromDataURL(imageDataUrl).toPNG();
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Local OCR failed.';
}

function isUnavailableExecutionError(error: unknown): boolean {
  const execError = error as { code?: unknown; killed?: unknown; signal?: unknown };

  return (
    execError.code === 'ENOENT' ||
    execError.code === 'ETIMEDOUT' ||
    (execError.killed === true && execError.signal === 'SIGTERM')
  );
}

export async function runLocalOcr(
  request: ScreenshotOcrRequest,
  {
    execFile = defaultExecFile,
    getTempPath = () => app.getPath('temp'),
    randomUUID: createId = randomUUID,
    timeoutMs = DEFAULT_OCR_TIMEOUT_MS,
    unlink: removeFile = unlink,
    writeFile: writeTempFile = writeFile,
    writePngFromDataUrl: createPng = writePngFromDataUrl,
  }: RunLocalOcrDependencies = {},
): Promise<ScreenshotOcrResult> {
  const tempPath = join(getTempPath(), `command-cabin-ocr-${createId()}.png`);

  try {
    await writeTempFile(tempPath, createPng(request.imageDataUrl));
    const { stdout } = await execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        createEncodedPowerShellCommand(createPowerShellOcrScript(tempPath, request.language)),
      ],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      },
    );

    return parseScreenshotOcrResult(JSON.parse(stdout.trim()));
  } catch (error) {
    if (isUnavailableExecutionError(error)) {
      return {
        language: request.language,
        message: 'Windows OCR is unavailable because PowerShell could not be started.',
        status: 'unavailable',
      };
    }

    return {
      language: request.language,
      message: toMessage(error),
      status: 'error',
    };
  } finally {
    await Promise.resolve(removeFile(tempPath)).catch(() => undefined);
  }
}
