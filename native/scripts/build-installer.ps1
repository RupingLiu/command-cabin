# 用法: powershell native/scripts/build-installer.ps1 [-Version x.y.z] [-SkipBuild] [-KeepNsisCache]
# 行为: release 构建 → makensis 打包 → 产出 native/artifacts/CommandCabin-Setup-{version}.exe
#       + 同名 .sha512 校验文件 → 清理中间产物（artifacts 仅留 release exe + Setup + sha512）。
# 说明: PS 5.1 兼容；本文件必须保存为 UTF-8 with BOM（含中文注释）。
param(
    # 缺省从 native/Cargo.toml 的 [workspace.package] version 解析（版本单一来源）
    [string]$Version = '',
    # 跳过 cargo 构建，直接使用 native/artifacts/cabin-app-release.exe（构建已由 build.ps1 -Release 完成）
    [switch]$SkipBuild,
    # 首次下载便携 NSIS 后保留 zip（缺省删除，仅留解压目录）
    [switch]$KeepNsisCache
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$native = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $native 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null

# ---- 1. 版本单一来源：Cargo.toml [workspace.package] version = "x.y.z" ----
if (-not $Version) {
    $cargoToml = Join-Path $native 'Cargo.toml'
    $inPackage = $false
    foreach ($line in Get-Content $cargoToml) {
        if ($line -match '^\[workspace\.package\]') { $inPackage = $true; continue }
        if ($inPackage -and $line -match '^\[') { break }
        if ($inPackage -and $line -match '^\s*version\s*=\s*"([^"]+)"') {
            $Version = $Matches[1]
            break
        }
    }
    if (-not $Version) { throw "无法从 $cargoToml 解析 [workspace.package] version" }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本号须为 x.y.z：$Version" }
Write-Host "==> 版本 $Version"

# ---- 2. Release 构建（build.ps1 -Release；产物复制到 artifacts 并清空 target）----
$exeSource = Join-Path $artifacts 'cabin-app-release.exe'
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build.ps1') -Release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path $exeSource)) {
    throw "缺少 $exeSource —— 先运行 native/scripts/build.ps1 -Release（或去掉 -SkipBuild）"
}
$binaryVersion = (Get-Item -LiteralPath $exeSource).VersionInfo.ProductVersion
if ($binaryVersion -ne $Version) {
    throw "EXE 版本 $binaryVersion 与安装包版本 $Version 不一致；请重新构建 Release"
}

# ---- 3. 定位/获取 makensis：PATH → 便携缓存 → 下载（一次性，留在用户目录）----
# 便携 NSIS 版本固定：3.11（官方 SourceForge 分发的当前稳定版 zip，约 3.5MB；
# 解压后约 14MB，存于 ~/.local/share/nsis，不进仓库 —— 磁盘红线允许的用户工具目录）。
$nsisVersion = '3.11'
$nsisZipUrl = 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip'
$makensis = $null
$cmd = Get-Command 'makensis.exe' -ErrorAction SilentlyContinue
if ($cmd) { $makensis = $cmd.Source }
$nsisCache = Join-Path $env:USERPROFILE '.local\share\nsis'
if (-not $makensis -and (Test-Path $nsisCache)) {
    $found = Get-ChildItem $nsisCache -Recurse -Filter 'makensis.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { $makensis = $found.FullName }
}
if (-not $makensis) {
    Write-Host "==> 下载便携 NSIS $nsisVersion 到 $nsisCache"
    New-Item -ItemType Directory -Force -Path $nsisCache | Out-Null
    $zipPath = Join-Path $nsisCache "nsis-$nsisVersion.zip"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-WebRequest -Uri $nsisZipUrl -OutFile $zipPath -UseBasicParsing
    $extractDir = Join-Path $nsisCache "nsis-$nsisVersion"
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    if (-not $KeepNsisCache) { Remove-Item $zipPath -Force -ErrorAction SilentlyContinue }
    $found = Get-ChildItem $extractDir -Recurse -Filter 'makensis.exe' | Select-Object -First 1
    if (-not $found) { throw "解压后未找到 makensis.exe（$extractDir）" }
    $makensis = $found.FullName
}
Write-Host "==> makensis: $makensis"

# ---- 4. makensis 打包（版本经 -DVERSION 注入；源路径全部绝对，规避相对路径歧义）----
$setupExe = Join-Path $artifacts ("CommandCabin-Setup-{0}.exe" -f $Version)
$licenseSource = Join-Path (Split-Path -Parent $native) 'LICENSE'
$iconSource = Join-Path $native 'assets\icon.ico'
if (-not (Test-Path $iconSource)) { throw "缺少图标 $iconSource（预生成并提交，<100KB）" }

$nsiScript = Join-Path $PSScriptRoot 'installer.nsi'
$fontLicenseSource = Join-Path $native 'assets\fonts\LICENSE-LiberationSans.txt'
if (-not (Test-Path $fontLicenseSource)) { throw "缺少字体许可 $fontLicenseSource" }
& $makensis "/DVERSION=$Version" "/DSETUP_OUTFILE=$setupExe" "/DEXE_SOURCE=$exeSource" `
    "/DLICENSE_SOURCE=$licenseSource" "/DICON_SOURCE=$iconSource" `
    "/DFONT_LICENSE_SOURCE=$fontLicenseSource" $nsiScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path $setupExe)) { throw "makensis 未产出 $setupExe" }

# ---- 5. sha512 校验文件（sha512sum 标准文本格式：<hex>␠␠<资产名>）----
# 与 cabin-core updater::parse_sha512_sidecar 的解析约定逐字对齐：
#   小写 128 位十六进制 + 两个空格 + 与资产名完全一致的文件名 + LF；
#   无 BOM（BOM 会破坏首行摘要解析）。
$hash = (Get-FileHash -Path $setupExe -Algorithm SHA512).Hash.ToLowerInvariant()
$assetName = Split-Path -Leaf $setupExe
$sidecarPath = "$setupExe.sha512"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($sidecarPath, "$hash  $assetName`n", $utf8NoBom)

# ---- 6. 清理中间产物：artifacts 仅留 release exe + Setup exe + .sha512 ----
$keep = @((Split-Path -Leaf $exeSource), $assetName, "$assetName.sha512")
Get-ChildItem $artifacts -File |
    Where-Object { $keep -notcontains $_.Name } |
    Remove-Item -Force

$setup = Get-Item $setupExe
$sidecar = Get-Item $sidecarPath
Write-Host ("==> 产物: {0} ({1:N0} bytes)" -f $setup.FullName, $setup.Length)
Write-Host ("==> 产物: {0} ({1:N0} bytes)" -f $sidecar.FullName, $sidecar.Length)
Write-Host "==> 安装包 + sha512 就绪（artifacts 已清理中间产物）"
