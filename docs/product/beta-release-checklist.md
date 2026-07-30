# CommandCabin Beta Release Checklist

For repeatable local packaging commands, follow
[`docs/product/windows-packaging-workflow.md`](./windows-packaging-workflow.md). Use this checklist
for release readiness; use the workflow document for the exact fastest command path.

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
- NSIS installer: `release/CommandCabin-0.9.0-x64-Setup.exe`

## Clean Windows User Verification

Use a clean Windows user profile or a clean Windows VM snapshot with no prior CommandCabin
installation.

- [ ] Confirm `%APPDATA%\CommandCabin` does not exist before install.
- [ ] Run `CommandCabin-0.9.0-x64-Setup.exe`.
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

## This Agent Run (July 30, 2026 / v0.9.0)

Full clean-user Windows verification requires a separate clean profile or VM and remains an
independent manual acceptance item. The automated release gates below were completed locally:

- [x] `corepack pnpm install --frozen-lockfile`
- [x] `corepack pnpm test`: 102 test files, 854 tests
- [x] `corepack pnpm typecheck`
- [x] `corepack pnpm lint`
- [x] `corepack pnpm format`
- [x] `corepack pnpm build`
- [x] `corepack pnpm --filter @command-cabin/desktop package:dir`
- [x] Packaging config smoke test, including the regression guard against recursive `RMDir /r`
- [x] 760×520 and 500×700 renderer UI verification with no horizontal overflow or console errors
- [x] `git diff --check`

Local package generation:

- [x] Directory package: `C:\WorkingFolder\command-cabin\release\win-unpacked\`
- [x] Unpacked app payload: `C:\WorkingFolder\command-cabin\release\win-unpacked\resources\app\`
- [x] Packaged app uses Electron/Node `node:sqlite`; packaging smoke confirms there is no stale
      `better-sqlite3` or other native `.node` payload.

Local installer generation:

- [x] `corepack pnpm --filter @command-cabin/desktop dist:win`
- [x] NSIS installer: `C:\WorkingFolder\command-cabin\release\CommandCabin-0.9.0-x64-Setup.exe`
      (97,433,771 bytes; SHA-256
      `3C12990B47D20E2CB0013B6DD9A2A50820C820CB25F5C6F98B30C0707DC96B61`)
- [x] Block map: `C:\WorkingFolder\command-cabin\release\CommandCabin-0.9.0-x64-Setup.exe.blockmap`
- [x] Update metadata: `C:\WorkingFolder\command-cabin\release\latest.yml`

Notes for this beta release:

- The installer is unsigned.
- `asar: false` and Windows executable resource editing remain disabled in the current beta
  packaging policy. Re-enable ASAR/integrity, resource editing and signing in a signing-capable
  build environment before treating the installer as a hardened, signed distribution.
