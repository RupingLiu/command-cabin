# CommandCabin About And Updates Design

## Goal

Add a visible product version to the CommandCabin settings UI and add first-version automatic
updates through GitHub Releases.

## Scope

This change adds an "About and Updates" section to the existing settings page. It shows the
installed CommandCabin version, reports update status, starts an automatic update check after app
startup, automatically downloads available updates, and lets the user restart to install once an
update has been downloaded.

This first version does not add release channels, configurable update intervals, persisted update
preferences, release notes rendering, or a separate update window.

## Architecture

Use `electron-updater` in the Electron main process and keep updater details out of the renderer.
The main process will own a focused updater controller that wraps the `autoUpdater` singleton and
exposes a narrow CommandCabin interface:

- return the current update status snapshot
- start a manual update check
- restart and install after an update has been downloaded
- notify renderer windows when status changes

The preload layer will expose typed methods and event subscriptions on `window.desktopApi`. The
renderer will consume only CommandCabin update DTOs from `apps/desktop/src/shared`.

## Publish Configuration

`electron-builder.yml` will publish Windows artifacts to GitHub Releases:

- provider: `github`
- owner: `RupingLiu`
- repo: `command-cabin`

The desktop app will add `electron-updater` as an application dependency, not a dev dependency,
because the packaged app needs it at runtime. Existing NSIS x64 packaging remains the installer
target.

## UI

Add an `AboutSettings` component to the settings page. It will follow the existing
`settings-section` styling and display:

- `CommandCabin v{version}`
- a localized status line
- `Check for updates` when a check is allowed
- `Restart to install` only after an update has been downloaded

Status copy should cover these states:

- idle
- checking
- update available
- downloading with percentage
- downloaded and ready to install
- up to date
- error
- unavailable in development or unsupported runtime

The current version should be obtained through `desktopApi.getAppInfo()`. The app info object will
gain a top-level `version` field sourced from Electron `app.getVersion()` in the main process.

## Update Behavior

On app startup, after the main window/controller is initialized, the updater controller will start
one automatic check. If an update is available, the app automatically downloads it. When the update
is downloaded, CommandCabin does not restart by itself; the settings UI shows that the update is
ready and offers a restart/install action.

Manual checks from the settings UI reuse the same controller and are ignored while a check or
download is already in progress.

## Error Handling

Development builds do not attempt real update checks. They report an unavailable status with a
short explanation that automatic updates apply to installed builds.

Updater errors are captured into the status snapshot and logged in the main process. They should
not block startup, show a modal dialog, close the launcher, or affect hotkeys, tray behavior,
plugins, clipboard history, app indexing, or settings persistence.

`quitAndInstall()` is only allowed after the controller has observed an `update-downloaded` event.
Calling install before that state returns a structured failure.

## Testing

Add focused tests for:

- updater controller state transitions from mocked `autoUpdater` events
- startup auto-check triggering without blocking app startup
- preload IPC methods and removable status subscriptions
- shared update status parsing that rejects malformed payloads
- settings UI rendering for version text, status text, progress, and install button visibility
- packaging config that requires `electron-updater` and GitHub Releases publish metadata

Run targeted tests first, then `corepack pnpm typecheck` and relevant unit tests before completion.

