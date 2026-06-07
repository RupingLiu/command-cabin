import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { app, nativeImage } from 'electron';

import type {
  ScreenshotOcrLanguage,
  ScreenshotOcrRequest,
  ScreenshotOcrResult,
} from '../../shared/screenshotApi.js';
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

export interface LocalOcrRequest extends ScreenshotOcrRequest {
  fallbackLanguages?: readonly ScreenshotOcrLanguage[] | undefined;
}

function createEncodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getUniqueOcrLanguages(request: LocalOcrRequest): ScreenshotOcrLanguage[] {
  const languages: ScreenshotOcrLanguage[] = [];

  for (const language of [request.language, ...(request.fallbackLanguages ?? [])]) {
    if (!languages.includes(language)) {
      languages.push(language);
    }
  }

  return languages;
}

function createPowerShellOcrScript(
  imagePath: string,
  languages: readonly ScreenshotOcrLanguage[],
): string {
  const encodedImagePath = Buffer.from(imagePath, 'utf8').toString('base64');
  const requestedLanguageTags = languages.map(quotePowerShellString).join(', ');
  const primaryLanguage = languages[0] ?? 'en-US';

  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# ImagePath: ${imagePath}
$ImagePath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedImagePath}'))
$RequestedLanguageTags = @(${requestedLanguageTags})
$ResolvedLanguageTag = '${primaryLanguage}'

function Write-OcrJson($Value) {
  $Value | ConvertTo-Json -Compress -Depth 5
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null

  function Get-OcrLanguageCandidates([string] $LanguageTag) {
    switch ($LanguageTag) {
      'zh-CN' { return @('zh-CN', 'zh-Hans-CN', 'zh-Hans', 'zh') }
      'zh-TW' { return @('zh-TW', 'zh-Hant-TW', 'zh-Hant', 'zh') }
      'en-US' { return @('en-US', 'en') }
      default { return @($LanguageTag) }
    }
  }

  function Resolve-OcrLanguage([string] $LanguageTag) {
    $availableLanguages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
    if ($availableLanguages.Count -eq 0) {
      return $null
    }

    $candidateTags = Get-OcrLanguageCandidates $LanguageTag
    foreach ($candidateTag in $candidateTags) {
      foreach ($availableLanguage in $availableLanguages) {
        $availableTag = [string]$availableLanguage.LanguageTag
        if ([string]::Equals($availableTag, $candidateTag, [System.StringComparison]::OrdinalIgnoreCase)) {
          return $availableLanguage
        }
      }
    }

    foreach ($candidateTag in $candidateTags) {
      foreach ($availableLanguage in $availableLanguages) {
        $availableTag = [string]$availableLanguage.LanguageTag
        if (
          $availableTag.StartsWith("$candidateTag-", [System.StringComparison]::OrdinalIgnoreCase) -or
          $candidateTag.StartsWith("$availableTag-", [System.StringComparison]::OrdinalIgnoreCase)
        ) {
          return $availableLanguage
        }
      }
    }

    return $null
  }

  function Await-WinRtOperation($Operation, [Type] $ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    if ($null -eq $method) {
      throw 'Windows Runtime AsTask bridge is unavailable.'
    }
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
  }

  $Language = $null
  foreach ($RequestedLanguageTag in $RequestedLanguageTags) {
    $Language = Resolve-OcrLanguage $RequestedLanguageTag
    if ($null -ne $Language) {
      $ResolvedLanguageTag = $RequestedLanguageTag
      break
    }
  }

  if ($null -eq $Language) {
    $availableTags = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    $availableMessage = if ($availableTags.Count -gt 0) { " Available OCR languages: $($availableTags -join ', ')." } else { '' }
    Write-OcrJson ([PSCustomObject]@{
      status = 'unavailable'
      language = '${primaryLanguage}'
      message = "Windows OCR is not available for the selected language.$availableMessage"
    })
    exit 0
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($Language)
  if ($null -eq $engine) {
    Write-OcrJson ([PSCustomObject]@{
      status = 'unavailable'
      language = $ResolvedLanguageTag
      message = 'Windows OCR is not available for the selected language.'
    })
    exit 0
  }

  $file = Await-WinRtOperation (
    [Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)
  ) ([Windows.Storage.StorageFile])
  $stream = Await-WinRtOperation (
    $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
  ) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRtOperation (
    [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
  ) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRtOperation (
    $decoder.GetSoftwareBitmapAsync()
  ) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-WinRtOperation (
    $engine.RecognizeAsync($bitmap)
  ) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object { $_.Text })

  Write-OcrJson ([PSCustomObject]@{
    status = 'success'
    language = $ResolvedLanguageTag
    text = ($lines -join "\`n")
    lines = $lines
  })
} catch {
  $message = if ($_.Exception.Message) { $_.Exception.Message } else { 'Windows OCR is unavailable.' }
  Write-OcrJson ([PSCustomObject]@{
    status = 'unavailable'
    language = '${primaryLanguage}'
    message = $message
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

function tryParseOcrResult(value: unknown): ScreenshotOcrResult | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  try {
    return parseScreenshotOcrResult(JSON.parse(value.trim()));
  } catch {
    return undefined;
  }
}

function stripPowerShellCliXml(value: string): string {
  return value
    .replace(/#< CLIXML/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMessage(error: unknown): string {
  const execError = error as { message?: unknown; stderr?: unknown };
  const stderr =
    typeof execError.stderr === 'string' ? stripPowerShellCliXml(execError.stderr) : undefined;

  if (stderr && stderr.length > 0) {
    return stderr;
  }

  if (error instanceof Error && error.message.startsWith('Command failed: powershell.exe')) {
    return 'Windows OCR failed while running PowerShell.';
  }

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
  request: LocalOcrRequest,
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
    const languages = getUniqueOcrLanguages(request);
    const { stdout } = await execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        createEncodedPowerShellCommand(createPowerShellOcrScript(tempPath, languages)),
      ],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      },
    );

    return parseScreenshotOcrResult(JSON.parse(stdout.trim()));
  } catch (error) {
    const execError = error as { stdout?: unknown };
    const parsedStdout = tryParseOcrResult(execError.stdout);

    if (parsedStdout) {
      return parsedStdout;
    }

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
