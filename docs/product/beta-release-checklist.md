# CommandCabin Beta Release Checklist

## Packaging Configuration

- [x] Windows installer target is configured as NSIS x64 in `electron-builder.yml`.
- [x] Packaged app identity is configured with `appId: com.commandcabin.app`.
- [x] Packaged app display name is configured as `CommandCabin`.
- [x] Windows icon is configured at `apps/desktop/build/icon.ico`.
- [x] NSIS installer and uninstaller icons are configured at `apps/desktop/build/icon.ico`.
- [x] Desktop package `main` points to the electron-vite main process output: `./out/main/index.js`.
- [x] Desktop package scripts build electron-vite output before invoking electron-builder.
- [x] Local beta packaging disables ASAR and Windows executable resource editing in
      `electron-builder.yml` so unsigned NSIS artifacts can be generated without the
      `winCodeSign` symlink privilege path.

## User Data Directory

CommandCabin stores local runtime data through Electron `app.getPath('userData')`.

The main process currently stores the SQLite database at:

```text
<Electron userData>\command-cabin.sqlite
```

The packaged app name and product name are set to `CommandCabin`, so on Windows the expected
packaged user data directory is:

```text
%APPDATA%\CommandCabin
```

Verify this during clean-user testing by opening Settings > Data Directory and confirming that
the displayed path is under `%APPDATA%\CommandCabin`.

## Automated Checks

Run these before publishing a beta build:

```powershell
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format
corepack pnpm build
corepack pnpm --filter @command-cabin/desktop package:dir
corepack pnpm --filter @command-cabin/desktop dist:win
git diff --check
```

Record the generated artifacts:

- Directory package: `release/win-unpacked/`
- NSIS installer: `release/CommandCabin-0.1.0-x64-Setup.exe`

## Clean Windows User Verification

Use a clean Windows user profile or a clean Windows VM snapshot with no prior CommandCabin
installation.

- [ ] Confirm `%APPDATA%\CommandCabin` does not exist before install.
- [ ] Run `CommandCabin-0.1.0-x64-Setup.exe`.
- [ ] Confirm installer completes without requiring developer tools or source checkout files.
- [ ] Confirm Start Menu shortcut named `CommandCabin` is created.
- [ ] Confirm desktop shortcut named `CommandCabin` is created.
- [ ] Launch CommandCabin from the Start Menu shortcut.
- [ ] Confirm the app window opens and the launcher input is usable.
- [ ] Confirm Settings > Data Directory points to `%APPDATA%\CommandCabin`.
- [ ] Confirm quitting CommandCabin removes running Electron/CommandCabin processes.
- [ ] Uninstall CommandCabin from Windows Apps or the uninstaller entry.
- [ ] Confirm Start Menu and desktop shortcuts are removed.
- [ ] Confirm no CommandCabin process remains after uninstall.
- [ ] Decide whether user data retention is acceptable for beta; if retention is not desired,
      manually remove `%APPDATA%\CommandCabin` and record that behavior as a follow-up.

## This Agent Run

Full clean-user Windows verification requires a separate clean profile or VM. It was not completed
in the May 16, 2026 agent run, so the clean-user checklist above remains unchecked.

Local automated verification completed on May 16, 2026:

- [x] `corepack pnpm install`
- [x] Packaging config smoke test: `corepack pnpm test tests/unit/packagingConfig.test.ts`
- [x] `corepack pnpm --filter @command-cabin/desktop package:dir`
- [x] Full test suite after restoring the Node ABI for `better-sqlite3`: `corepack pnpm test`
- [x] `corepack pnpm typecheck`
- [x] `corepack pnpm lint`
- [x] `corepack pnpm format`
- [x] `corepack pnpm build`
- [x] `git diff --check`

Local package generation completed on May 16, 2026:

- [x] Directory package: `C:\WorkingFolder\command-cabin\release\win-unpacked\`
- [x] Unpacked app payload: `C:\WorkingFolder\command-cabin\release\win-unpacked\resources\app\`
- [x] Native SQLite packaged at:
      `C:\WorkingFolder\command-cabin\release\win-unpacked\resources\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node`

Local installer generation completed on May 16, 2026:

- [x] `corepack pnpm --filter @command-cabin/desktop dist:win`
- [x] NSIS installer: `C:\WorkingFolder\command-cabin\release\CommandCabin-0.1.0-x64-Setup.exe`
- [x] Block map: `C:\WorkingFolder\command-cabin\release\CommandCabin-0.1.0-x64-Setup.exe.blockmap`

Notes for this local beta artifact:

- The installer is unsigned.
- `asar: false` is intentional for this beta packaging pass because the current Windows user
  cannot extract `winCodeSign-2.6.0.7z` symlinks. Re-enable ASAR/integrity and executable
  resource editing in a signing-capable CI/user profile before producing a hardened release
  candidate.
- After a packaging attempt, run:

  ```powershell
  corepack pnpm --filter @command-cabin/core rebuild better-sqlite3
  ```

  This restores the native SQLite module for the local Node/Vitest ABI.
