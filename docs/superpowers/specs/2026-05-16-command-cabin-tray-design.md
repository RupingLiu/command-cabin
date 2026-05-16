# CommandCabin Tray Design

## Background

CommandCabin is an Electron desktop launcher with a frameless always-on-top main window, hide-on-blur behavior, and a global hotkey. Recent startup debugging showed that if the global hotkey is unavailable, the user needs another reliable way to bring the launcher back. The application currently has no system tray integration.

## Goals

- Add a Windows system tray icon that is created when the app starts.
- Keep CommandCabin running when the user closes the launcher window.
- Let the user restore the launcher from the tray even when the global hotkey is unavailable.
- Provide an explicit tray menu action for quitting the app cleanly.

## Non-Goals

- Do not add a renderer UI for tray settings in this change.
- Do not add auto-start or notification features.
- Do not redesign the launcher window.
- Do not add custom tray artwork beyond reusing the packaged app icon.

## Tray Behavior

The app creates a tray icon using the existing `apps/desktop/build/icon.ico` asset. The tray tooltip is `CommandCabin`.

Left-clicking the tray icon toggles the launcher window:

- If the launcher is visible, hide it.
- If the launcher is hidden or destroyed, create or show it, center it, focus it, and focus the search input through the existing window visibility flow.

Right-clicking the tray icon opens a context menu with:

- `Show CommandCabin`: shows and focuses the launcher.
- `Settings`: shows the launcher and opens the existing settings view.
- `Quit`: performs a real application quit.

Closing the launcher window hides it to the tray and keeps the app running. A real quit only happens through the tray `Quit` action or an operating-system shutdown path.

## Architecture

Add a small main-process tray controller near the existing desktop application controller. It should own the Electron `Tray` instance, context menu, and click handlers. It should not know about storage, plugins, indexing, or renderer internals.

The existing `createDesktopApplicationController` remains the source of truth for launcher visibility. If it needs one extra method for explicitly showing the launcher from tray code, add that method instead of duplicating window logic in the tray controller.

Add a main-to-renderer IPC signal for opening settings from the tray. The controller should show and focus the launcher first, then send the settings signal to the renderer. The renderer should route this signal through existing app state so it lands on the current `SettingsPage` instead of adding a separate settings window.

The main process should hold a single tray controller instance for the lifetime of the app. It should dispose of the tray during final shutdown.

## Quit Flow

Introduce an explicit main-process quit intent, such as `isQuittingFromTray`, so the app can distinguish these cases:

- User closes the launcher window: prevent close and hide to tray.
- User chooses tray `Quit`: allow shutdown and run the existing cleanup path for clipboard watcher, plugins, database, hotkeys, and tray.
- Startup failure before the tray exists: keep the existing failure behavior and quit.

## Error Handling

If tray creation fails, CommandCabin should log the error and continue with the launcher and hotkey. Tray failure should not prevent startup.

If the tray icon asset cannot be resolved in packaged mode, log the error and continue without a tray rather than crashing.

If the hotkey conflicts, the existing user-visible warning can still appear, but the tray remains available as a recovery path.

## Testing

Add unit tests around the main-process tray behavior using mock Electron tray/menu primitives:

- Creating the tray sets the tooltip and context menu.
- Left-click toggles the launcher through the desktop application controller.
- The Settings menu item shows the launcher and sends the settings signal to the renderer.
- Closing the launcher hides it instead of quitting.
- Tray `Quit` allows real shutdown.
- Tray creation failure logs and does not throw from app startup.

Existing tests for window visibility and hotkey conflict behavior should continue to pass.

## Acceptance Criteria

- After installing and launching CommandCabin, a tray icon is available in the Windows notification area.
- Closing the launcher window hides it to tray and keeps the process alive.
- Clicking the tray icon restores the launcher.
- The tray menu can show the launcher, open settings, and quit.
- Full typecheck, unit tests, lint, Windows packaging, and installed-app smoke test pass.
