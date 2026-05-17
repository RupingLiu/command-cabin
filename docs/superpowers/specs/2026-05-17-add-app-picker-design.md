# Add App Picker Design

## Goal

Replace the native Windows file picker used by the home-screen "Add app" tile with a CommandCabin-owned add-app panel that can show application icons, search candidates, and handle incomplete shortcuts gracefully.

## Problem

The current flow opens the OS "Add application" dialog filtered to `.exe` and `.lnk`. Windows owns that UI, so CommandCabin cannot control icon rendering, sorting, search behavior, localization, or explanations for broken shortcuts. Some desktop shortcuts, including Codex and Claude on this machine, expose no target path or icon location through the standard shell APIs, so the dialog shows blank document icons and gives the user no context.

## Recommended Experience

Clicking the home-screen add tile opens an in-app modal panel instead of the native file picker. The panel lists application candidates from CommandCabin's indexed Start Menu apps and Desktop shortcuts. It includes search, icon previews, app name, source label, path detail, and an Add button. The native file picker remains available as a secondary "Browse local file" action for apps that do not appear in the list.

The panel should default to the user's current language and theme. It should fit inside the fixed CommandCabin window, avoid nested large frames, and keep the launcher usable with keyboard navigation.

## Candidate Sources

Candidates come from two sources:

- Start Menu apps already indexed by `createAppIndexer`.
- Desktop `.lnk` files scanned on demand from the current user's Desktop directory.

Start Menu candidates should reuse their existing command metadata, including title, subtitle, shortcut path, executable path, icon candidates, and app user model ID when present. Desktop shortcut candidates should attempt to resolve shortcut metadata through the existing Windows shortcut resolver. If target or icon resolution fails, the candidate still appears if the shortcut itself exists, but it is marked as unresolved and uses a letter fallback icon.

Candidates are deduplicated by normalized executable path when available, then by normalized shortcut path. Pinned apps already on the home screen are still shown, but their primary action changes to "Added" and is disabled.

## Data Contract

The main process exposes two new renderer APIs:

- `listAppCandidates(query?: string): Promise<AppCandidate[]>`
- `addPinnedAppFromCandidate(candidateId: string): Promise<FavoriteListRecord>`

`AppCandidate` contains:

- `id`: stable candidate id.
- `title`: display name.
- `source`: `start-menu` or `desktop`.
- `sourceLabel`: localized in the renderer from `source`.
- `subtitle`: executable path, app user model id, shortcut path, or resolution status.
- `shortcutPath`: path opened by Electron when launched.
- `executablePath`: resolved target when available.
- `icon`: optional data URL returned by the main icon resolver.
- `iconCandidates`: internal main-process data, not sent to renderer.
- `alreadyPinned`: boolean.
- `resolutionStatus`: `resolved` or `unresolved-shortcut`.

The renderer should not parse `.lnk` files or call native icon APIs. The main process owns filesystem and icon resolution.

## Error Handling

Shortcut resolution and icon extraction must use short timeouts so the modal never remains stuck in a loading state. A candidate that cannot resolve an icon appears with a letter fallback. A candidate that cannot resolve a target path still appears if it can be opened as a shortcut path. If adding a candidate fails because its backing file no longer exists or cannot be opened, the modal shows an inline error and keeps focus in the panel.

The fallback "Browse local file" action uses the current native file picker and immediately converts the selected file into the same pinned-app creation path used by candidate selection.

## UI Behavior

The modal contains:

- Header: "Add app" / "添加应用" / "新增應用程式".
- Search input with localized placeholder.
- Scrollable candidate list.
- Candidate rows with icon, title, source/path detail, and action button.
- Footer action: "Browse local file".
- Empty state when no candidates match.

Keyboard behavior:

- `Esc` closes the modal.
- Arrow keys move through candidates.
- `Enter` adds the selected candidate.
- `Tab` follows normal focus order.

## Testing

Tests cover:

- Candidate listing merges Start Menu and Desktop shortcuts.
- Deduplication removes duplicate app entries.
- Unresolved shortcuts remain visible with fallback metadata.
- Adding a candidate stores executable/icon metadata when available.
- Renderer modal renders localized labels, empty state, added state, and candidate rows.
- Existing native browse behavior remains available as fallback.

