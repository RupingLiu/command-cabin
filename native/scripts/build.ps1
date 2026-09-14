# 用法: pwsh native/scripts/build.ps1 [-Release] [-Test]
# 行为: 执行 cargo build/test，将可执行产物复制到 native/artifacts/，然后删除 native/target。
param(
    [switch]$Release,
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
# 工具链不在默认 PATH：cargo 在 ~/.cargo/bin；GNU 工具链的链接器在 MSYS2 UCRT64
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$msysBin = 'C:\msys64\ucrt64\bin'
$env:PATH = @($cargoBin, $msysBin, $env:PATH) -join [IO.Path]::PathSeparator
$native = Split-Path -Parent $PSScriptRoot
Push-Location $native
try {
    $profileArgs = @()
    if ($Release) { $profileArgs += '--release' }

    if ($Test) {
        cargo test --workspace
    } else {
        cargo build @profileArgs
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $profile = if ($Release) { 'release' } else { 'debug' }
    $exe = Join-Path $native "target/$profile/cabin-app.exe"
    if (Test-Path $exe) {
        $artifacts = Join-Path $native 'artifacts'
        New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
        Copy-Item $exe (Join-Path $artifacts "cabin-app-$profile.exe") -Force
    }
}
finally {
    # 用户要求：不关心编译速度，只关心磁盘占用 —— 构建完成后清空编译缓存
    Remove-Item (Join-Path $native 'target') -Recurse -Force -ErrorAction SilentlyContinue
    Pop-Location
}
