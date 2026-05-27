# App Icon Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make app search results replace letter fallback icons with real app icons as soon as cold-cache icon resolution finishes.

**Architecture:** Keep search fast by returning cached icons immediately, then emit an IPC event when background icon resolution produces new `data:image/*` icons. The renderer merges those updates into the current result list and keeps image fallback behavior robust.

**Tech Stack:** Electron main/preload IPC, React renderer, TypeScript, Vitest, pnpm workspace.

---

### Task 1: Main-Process Icon Update Event

**Files:**
- Modify: `apps/desktop/src/shared/ipcChannels.ts`
- Modify: `apps/desktop/src/main/icons/searchResultIconHydration.ts`
- Modify: `apps/desktop/src/main/icons/searchResultIconHydration.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] Add `SEARCH_RESULT_ICONS_UPDATED_CHANNEL = 'command-cabin:search-result-icons-updated'`.
- [ ] Change `hydrateSearchResultsWithCachedIcons()` so it still returns cached/public results immediately.
- [ ] In the background, call `appIconResolver.resolveSearchResultIcon(result)` for app results and collect resolved results whose `icon` starts with `data:image/`.
- [ ] Add an optional `onIconsResolved(results)` callback and invoke it only when at least one resolved result has a real image icon.
- [ ] Update the main `SEARCH_COMMANDS_CHANNEL` handler to send the resolved icon results to `event.sender` through the new IPC channel.
- [ ] Add tests proving initial return is non-blocking and the callback receives resolved icons after background resolution.

### Task 2: Renderer Icon Update Merge and Safe Image Rendering

**Files:**
- Modify: `apps/desktop/src/shared/launcherApi.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.test.ts`
- Modify: `apps/desktop/src/renderer/src/launcher/useLauncherController.ts`
- Modify: `apps/desktop/src/renderer/src/launcher/useLauncherController.test.ts`
- Modify: `apps/desktop/src/renderer/src/launcher/ResultItem.tsx`
- Modify: `apps/desktop/src/renderer/src/launcher/ResultItem.test.ts`
- Modify: `apps/desktop/src/renderer/src/launcher/AddAppPicker.tsx`
- Modify: `apps/desktop/src/renderer/src/launcher/AddAppPicker.test.ts`

- [ ] Expose `desktopApi.onSearchResultIconsUpdated(listener)` in preload.
- [ ] Reuse `parseLauncherCommandSearchResults()` for the event payload.
- [ ] Add a launcher reducer action that merges incoming icon updates by result id, only accepting `data:image/*`.
- [ ] Subscribe to the preload event in `useLauncherController()` and dispatch the merge action.
- [ ] Add image error fallback in result icons so a failed image source reverts to the glyph.
- [ ] Make `AddAppPicker` use `<img>` only for `data:image/*`; raw Windows paths should show the glyph fallback.
- [ ] Add tests for event parsing, reducer merge behavior, image error fallback, and Add App picker path fallback.

### Task 3: Cacheability and Desktop Shortcut Metadata

**Files:**
- Modify: `apps/desktop/src/main/icons/appIconResolver.ts`
- Modify: `apps/desktop/src/main/icons/appIconResolver.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/launcher/desktopShortcutCommands.ts` only if it remains needed.

- [ ] Replace global `hasWeakShortcutExpansion` cacheability checks with per-candidate weak fallback tracking.
- [ ] Keep direct executable/image/AppUserModelID icon results cacheable even if a separate `.lnk` candidate timed out.
- [ ] Keep weak shortcut-only fallback icons non-cacheable.
- [ ] Configure `createAppIndexer()` with `createWindowsStartMenuScanner({ desktopDirectories: getDesktopShortcutDirectories(), desktopShortcutResolver: shortcutResolver })`.
- [ ] Remove the extra unresolved desktop shortcut list from `getLauncherAppCommands()` to avoid duplicate desktop app commands.
- [ ] Add tests that direct `.exe` icons are cached when a `.lnk` candidate is weak, while shortcut-only weak fallback icons are not cached.

### Task 4: Release Verification

**Files:**
- Modify: workspace `package.json` files for the next patch version.
- Generate: `release/CommandCabin-<version>-x64-Setup.exe`
- Generate: `release/CommandCabin-<version>-x64-Setup.exe.blockmap`
- Generate: `release/latest.yml`

- [ ] Run `corepack pnpm typecheck`.
- [ ] Run `corepack pnpm lint`.
- [ ] Run `corepack pnpm test`.
- [ ] Run `corepack pnpm --filter @command-cabin/desktop dist:win`.
- [ ] Run `git diff --check`.
- [ ] Push main, create the version tag, and publish a GitHub Release with Chinese notes.
