# CommandCabin Agent Notes

## Project Shape

CommandCabin is a Windows-first Electron desktop productivity launcher. The repo is a pnpm
workspace with TypeScript project references.

- `apps/desktop`: Electron app shell. Main process owns persistence, OS integration, hotkeys,
  tray, startup behavior, app indexing, plugin loading, and IPC handlers. Preload exposes the
  typed `window.desktopApi`. Renderer is a React app with launcher, settings, and plugin-host
  views.
- `packages/core`: Pure business logic for commands, search/ranking, settings, storage,
  favorites, app indexing, and plugin runtime. Prefer putting non-Electron logic here.
- `packages/plugin-api`: Public plugin type surface.
- `packages/built-in-plugins/*`: Built-in command providers such as calculator, clipboard history,
  text tools, and quick converter.
- `tests/unit`: Cross-package unit and packaging smoke tests.

## Commands

Use `corepack pnpm` from the repository root.

- Install: `corepack pnpm install`
- Run desktop app: `corepack pnpm dev`
- Build all packages: `corepack pnpm build`
- Typecheck: `corepack pnpm typecheck`
- Test all: `corepack pnpm test`
- Lint: `corepack pnpm lint`
- Format check: `corepack pnpm format`
- Format write: `corepack pnpm format:write`
- Desktop package directory: `corepack pnpm --filter @command-cabin/desktop package:dir`
- Windows installer: `corepack pnpm --filter @command-cabin/desktop dist:win`

For targeted tests, prefer Vitest paths, for example:

```powershell
corepack pnpm test apps/desktop/src/main/window/createMainWindow.test.ts
corepack pnpm --filter @command-cabin/core test
```

## Native (Rust + Slint) Workspace

A native rewrite of the desktop app lives under `native/` (Cargo workspace: `cabin-core`,
`cabin-storage`, `cabin-platform`, `cabin-platform-windows`, `cabin-app`). It is developed
milestone-by-milestone; acceptance docs and milestone plans live under
`docs/superpowers/acceptance/` (start at `m5-release.md` for the release checklist and
milestone index). Until the Electron-to-native cutover, both stacks coexist.

- Toolchain: `stable-x86_64-pc-windows-gnu` (cargo + MSYS2 UCRT64 linker). Cargo is not on the
  default PATH — bootstrap with
  `export PATH="$USERPROFILE/.cargo/bin:/c/msys64/ucrt64/bin:$PATH"` (Git Bash) or use the
  scripts below, which set it themselves.
- Build: `powershell native/scripts/build.ps1 -Release` (builds, copies the exe to
  `native/artifacts/`, then deletes `native/target` — disk-budget discipline; do not leave
  `native/target` behind).
- Test all: `powershell native/scripts/build.ps1 -Test`; targeted: `cargo test -p <crate>` from
  `native/`.
- Lint/format: `cargo clippy --workspace -- -D warnings` and `cargo fmt` (workspace lints come
  from `[workspace.lints.clippy]` in `native/Cargo.toml`).
- Windows installer: `powershell native/scripts/build-installer.ps1` (version single-source is
  `[workspace.package] version` in `native/Cargo.toml`; produces
  `native/artifacts/CommandCabin-Setup-{version}.exe` + `.sha512`).
- Layering rules: `cabin-core`/`cabin-storage`/`cabin-platform` are pure Rust with no
  Windows/Electron dependencies (platform specifics go behind traits defined in
  `cabin-platform`, implemented in `cabin-platform-windows`); `cabin-app` is the only crate
  allowed to touch Slint/winit/win32 and owns orchestration. Tests live beside source as
  `*.rs` `#[cfg(test)]` modules; live-network probes are `#[ignore]`-gated.
- Architecture parity: TS-era behavior (`apps/desktop`, `packages/core`) is the reference spec;
  when porting behavior, quote the TS source in tests/docs rather than inventing semantics.

## Coding Conventions

- The repo is ESM TypeScript with `moduleResolution: NodeNext`; keep relative TS imports using
  `.js` extensions.
- Keep strict typing intact. The base config enables `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`.
- Prettier uses single quotes, semicolons, trailing commas, and 100-character print width.
- Tests live beside source as `*.test.ts` / `*.test.tsx`; production `tsconfig` files exclude tests.
- Preserve existing validation/parsing style at boundaries. Shared preload/main IPC parsers should
  reject unknown or malformed inputs before they enter core logic.
- Avoid naming competitor products in user-facing copy or project docs.

## Architecture Notes

- Commands use the core `Command` model and execute through `createCommandExecutor`.
- Search uses Fuse.js plus CommandCabin ranking boosts for source, history, pinned commands, recent
  use, and exact title matches.
- Persistent app data is stored under Electron `app.getPath('userData')`; the SQLite database is
  `command-cabin.sqlite`.
- Storage migrations live in `packages/core/src/storage/migrations.ts`. Treat migration IDs and
  names as append-only once applied.
- App discovery is Windows-centered and scans Start Menu/Desktop shortcuts. Shortcut resolution
  shells out to PowerShell through the scanner abstraction.
- Main-process IPC handlers are registered in `apps/desktop/src/main/index.ts`; the matching
  channel constants live in `apps/desktop/src/shared/ipcChannels.ts`.
- Renderer code should call `window.desktopApi` through existing hooks/components instead of using
  Electron APIs directly.
- Plugin manifests require reverse-domain IDs, semver-like versions, explicit permissions, and
  declared commands. Plugin command IDs are adapted into host command IDs by core.
- Plugin UI is hosted through the plugin host/webview guard path; keep preload and webview policy
  changes narrow and covered by tests.

## Working Safely

- The worktree may contain user changes. Do not revert unrelated modified or untracked files.
- Prefer focused changes with nearby tests. Broaden verification when touching IPC, persistence,
  plugin runtime, packaging, or shared core contracts.
- Before beta packaging, follow `docs/product/beta-release-checklist.md`.
