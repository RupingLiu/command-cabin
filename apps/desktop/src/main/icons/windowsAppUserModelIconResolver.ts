import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_APP_USER_MODEL_ICON_TIMEOUT_MS = 1_500;
const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

export interface WindowsAppUserModelIconResolverExecFileOptions {
  windowsHide: true;
  timeout: number;
  encoding: 'utf8';
}

export interface WindowsAppUserModelIconResolverExecFileResult {
  stdout: string;
}

export type WindowsAppUserModelIconResolverExecFile = (
  file: string,
  args: readonly string[],
  options: WindowsAppUserModelIconResolverExecFileOptions,
) => Promise<WindowsAppUserModelIconResolverExecFileResult>;

export interface WindowsAppUserModelIconResolverOptions {
  execFile?: WindowsAppUserModelIconResolverExecFile;
  logger?: Pick<Console, 'warn'>;
  timeoutMs?: number;
}

export interface WindowsAppUserModelIconResolver {
  resolve: (appUserModelId: string) => Promise<string | undefined>;
}

function createPowerShellScript(appUserModelId: string): string {
  const encodedAppUserModelId = Buffer.from(appUserModelId, 'utf8').toString('base64');

  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$AppUserModelId = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedAppUserModelId}'))
$parts = $AppUserModelId.Split('!', 2)
if ($parts.Count -ne 2) {
  exit 0
}

$packageFamilyName = $parts[0]
$applicationId = $parts[1]
$package = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $packageFamilyName } | Select-Object -First 1
if ($null -eq $package) {
  exit 0
}

$manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  exit 0
}

[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$applications = @($manifest.Package.Applications.Application)
$application = $applications | Where-Object { $_.Id -eq $applicationId } | Select-Object -First 1
if ($null -eq $application) {
  $application = $applications | Select-Object -First 1
}
if ($null -eq $application) {
  exit 0
}

$visualElements = $application.VisualElements
$logoPaths = @(
  $visualElements.Square150x150Logo,
  $visualElements.Square44x44Logo,
  $manifest.Package.Properties.Logo
) | Where-Object { $_ -is [string] -and $_.Trim().Length -gt 0 }

$candidateRoots = @(
  $package.InstallLocation,
  (Join-Path $package.InstallLocation 'images')
)
$candidates = New-Object System.Collections.Generic.List[string]
foreach ($logoPath in $logoPaths) {
  foreach ($candidateRoot in $candidateRoots) {
    $fullPath = Join-Path $candidateRoot $logoPath
    [void]$candidates.Add($fullPath)
    $directory = [System.IO.Path]::GetDirectoryName($fullPath)
    $fileName = [System.IO.Path]::GetFileNameWithoutExtension($fullPath)
    $extension = [System.IO.Path]::GetExtension($fullPath)

    foreach ($suffix in @('.targetsize-256', '.targetsize-128', '.targetsize-96', '.targetsize-64', '.targetsize-48', '.scale-400', '.scale-200', '.scale-150', '.scale-100')) {
      [void]$candidates.Add((Join-Path $directory "$fileName$suffix$extension"))
    }
  }
}

$selectedPath = $candidates |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Sort-Object -Property @{ Expression = { (Get-Item -LiteralPath $_).Length }; Descending = $true } |
  Select-Object -First 1

if ($null -eq $selectedPath) {
  exit 0
}

$extension = [System.IO.Path]::GetExtension($selectedPath).ToLowerInvariant()
$mimeType = if ($extension -eq '.ico') { 'image/x-icon' } else { 'image/png' }
$base64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($selectedPath))
Write-Output ("data:{0};base64,{1}" -f $mimeType, $base64)
`;
}

function createEncodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function isValidAppUserModelId(appUserModelId: string): boolean {
  const trimmedAppUserModelId = appUserModelId.trim();
  const separatorIndex = trimmedAppUserModelId.indexOf('!');

  return (
    separatorIndex > 0 &&
    separatorIndex < trimmedAppUserModelId.length - 1 &&
    !trimmedAppUserModelId.includes('\\')
  );
}

const defaultExecFile: WindowsAppUserModelIconResolverExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], options);

  return {
    stdout: String(stdout),
  };
};

export function createWindowsAppUserModelIconResolver({
  execFile = defaultExecFile,
  logger = console,
  timeoutMs = DEFAULT_APP_USER_MODEL_ICON_TIMEOUT_MS,
}: WindowsAppUserModelIconResolverOptions = {}): WindowsAppUserModelIconResolver {
  const iconCache = new Map<string, string | undefined>();

  return {
    resolve: async (appUserModelId) => {
      const trimmedAppUserModelId = appUserModelId.trim();

      if (!isValidAppUserModelId(trimmedAppUserModelId)) {
        return undefined;
      }

      if (iconCache.has(trimmedAppUserModelId)) {
        return iconCache.get(trimmedAppUserModelId);
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
            createEncodedPowerShellCommand(createPowerShellScript(trimmedAppUserModelId)),
          ],
          {
            windowsHide: true,
            timeout: timeoutMs,
            encoding: 'utf8',
          },
        );
        const dataUrl = stdout.trim();
        const resolvedIcon = IMAGE_DATA_URL_PATTERN.test(dataUrl) ? dataUrl : undefined;

        iconCache.set(trimmedAppUserModelId, resolvedIcon);
        return resolvedIcon;
      } catch (error) {
        logger.warn('Failed to load AppUserModelID icon.', error);
        iconCache.set(trimmedAppUserModelId, undefined);
        return undefined;
      }
    },
  };
}
