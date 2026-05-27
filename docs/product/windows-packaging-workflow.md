# CommandCabin Windows Packaging Workflow

This workflow is the source of truth for local Windows packaging. Run commands from the repository
root:

```powershell
Set-Location C:\WorkingFolder\command-cabin
```

## Fast Local Test Build

Use this when a user asks for a local no-install test exe. This is the fastest reliable path.

```powershell
corepack pnpm --filter @command-cabin/desktop package:dir
```

Output:

```text
C:\WorkingFolder\command-cabin\release\win-unpacked\CommandCabin.exe
```

Important: `win-unpacked\CommandCabin.exe` is a directory package. The exe must stay beside the
generated `resources`, `locales`, DLLs, and `.pak` files under `release\win-unpacked`.

## Single-File Portable Build

Use this only when the user explicitly asks for a single portable exe. It is slower than
`package:dir`, but avoids requiring the whole `win-unpacked` directory.

First generate or refresh the unpacked app:

```powershell
corepack pnpm --filter @command-cabin/desktop package:dir
```

Then run electron-builder from the repository root with the packaging pnpm shim on `PATH`:

```powershell
$env:PATH = 'C:\WorkingFolder\command-cabin\apps\desktop\.package-bin;' + $env:PATH
& .\apps\desktop\node_modules\.bin\electron-builder.CMD `
  --win portable `
  --x64 `
  --projectDir C:\WorkingFolder\command-cabin `
  --config electron-builder.yml `
  --config.win.signAndEditExecutable=false `
  '--config.portable.artifactName=CommandCabin-${version}-x64-Portable.${ext}'
```

Output:

```text
C:\WorkingFolder\command-cabin\release\CommandCabin-<version>-x64-Portable.exe
```

## Windows Installer Build

Use this for release candidates and GitHub Releases.

```powershell
corepack pnpm --filter @command-cabin/desktop dist:win
```

Outputs:

```text
C:\WorkingFolder\command-cabin\release\CommandCabin-<version>-x64-Setup.exe
C:\WorkingFolder\command-cabin\release\CommandCabin-<version>-x64-Setup.exe.blockmap
C:\WorkingFolder\command-cabin\release\latest.yml
```

## Verification Before Sharing Artifacts

For quick local test builds:

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm --filter @command-cabin/desktop package:dir
```

For release builds:

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm --filter @command-cabin/desktop dist:win
git diff --check
```

## Avoid These Slow or Broken Paths

- Do not use `corepack pnpm --filter @command-cabin/desktop exec electron-builder` with the root
  `electron-builder.yml`. It changes the working directory to `apps/desktop`, so root-relative
  config paths such as `apps/desktop/scripts/after-pack-windows-icon.cjs` resolve incorrectly.
- Do not call `node apps/desktop/scripts/package-with-pnpm-shim.js` directly for custom portable
  targets. The script is meant to run through the desktop package scripts; direct calls can miss the
  local `electron-builder` binary on `PATH`.
- Do not use the NSIS installer command when the user only asked for a local no-install test exe.
  `package:dir` is faster and produces `release\win-unpacked\CommandCabin.exe`.
- Do not copy only `release\win-unpacked\CommandCabin.exe` to another folder. Copy the full
  `release\win-unpacked` directory, or build the portable single-file exe.

## Native Module Note

Packaging rebuilds native dependencies for Electron. If local Vitest or Node usage later reports a
native SQLite ABI mismatch, rebuild the core package native dependency:

```powershell
corepack pnpm --filter @command-cabin/core rebuild better-sqlite3
```
