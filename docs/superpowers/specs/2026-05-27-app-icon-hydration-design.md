# App Icon Hydration Design

## Problem

On a fresh install or after clearing `app-icons.json`, most app results render as letter fallback
icons. The app already resolves icons in the main process, but the current search IPC path only
returns icons that are already in the persistent icon cache. Cache misses are warmed in the
background without notifying the renderer, so the visible result list never receives the newly
resolved `data:image/*` icon until a later search, reload, or restart.

There are two secondary issues:

- Weak `.lnk` fallback state can mark a whole candidate set as not cacheable, even when a direct
  `.exe` candidate succeeds.
- Desktop shortcut commands are listed separately without resolving `.lnk` metadata through the
  core scanner, which increases the number of weak shortcut-only icon candidates.

## Requirements

- Search results should show real app icons shortly after they are resolved, without forcing users
  to search again or restart the app.
- Search input should remain responsive. Cold-cache native icon resolution must stay in the
  background.
- The renderer must only render trusted `data:image/*` values as `<img>` sources and must fall back
  cleanly if an image fails to load.
- Successfully resolved direct executable, AppUserModelID, and image asset icons should be written
  to the persistent icon cache even if an unrelated shortcut candidate timed out.
- Desktop shortcuts should enter the indexed app command flow with resolved shortcut metadata where
  possible.
- The final release must include tests, a Windows installer, pushed commits/tags, and a GitHub
  Release with Chinese release notes.

## Approach

Main search IPC will continue returning immediately with cached icons, but `hydrateSearchResults`
will resolve cold icons in the background and report any newly resolved `data:image/*` icons through
a new `command-cabin:search-result-icons-updated` IPC event. The preload exposes
`desktopApi.onSearchResultIconsUpdated()`. The renderer listens once and merges icon updates by
result id into the current visible result list.

`appIconResolver` will track weak fallback status per candidate path instead of globally. This lets
direct executable or AppUserModelID successes be cached even when a `.lnk` expansion was weak. The
desktop app indexer will be configured with desktop directories so desktop shortcuts are resolved
by the same scanner used for Start Menu shortcuts.

## Verification

- Unit tests cover background icon update emission, renderer merge behavior, image fallback, weak
  shortcut cacheability, and desktop scanner wiring.
- Full verification runs `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`,
  `corepack pnpm --filter @command-cabin/desktop dist:win`, and `git diff --check`.
