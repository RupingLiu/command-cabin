# Background Auto Update Design

## Goal

CommandCabin should check for updates without requiring the user to open Settings and press
"Check for updates". When an update package has been downloaded, the launcher home screen should
show a clear install prompt and let the user choose whether to install.

## Behavior

- When the launcher home screen opens or receives focus, it asks the updater to check for updates.
- When CommandCabin is running in the background, the main process checks for updates periodically.
- The default background interval is six hours.
- If a check is already running, an update is downloading, or an update has already been downloaded,
  new check requests are ignored and return the current status.
- Updates download automatically after they are discovered.
- Updates never install automatically. The user must choose to install after the package is ready.
- The launcher home screen shows an update banner only when `UpdateStatus.phase === 'downloaded'`.
- The Settings > About and Update section keeps its manual check and install controls.

## Architecture

- `apps/desktop/src/main/updater/updateController.ts` remains the source of truth for update state.
  It will keep `startAutomaticCheck()` but expand it from a one-shot startup check into an immediate
  check plus an interval timer.
- `apps/desktop/src/renderer/src/launcher/LauncherPage.tsx` will own the launcher update banner. It
  will load the current update status, subscribe to status changes, check on mount, and check again
  whenever the launcher receives the focus signal.
- No new IPC channel is required. The renderer can reuse `getUpdateStatus`, `checkForUpdates`,
  `installUpdate`, and `onUpdateStatusChanged` from `window.desktopApi`.

## User Interface

- The launcher banner appears under the results/home app grid and above the compact home action
  buttons.
- The banner text is localized:
  - zh-CN: `新版本 {version} 已下载`
  - zh-TW: `新版本 {version} 已下載`
  - en-US: `Version {version} is ready`
- The button is localized:
  - zh-CN: `立即安装`
  - zh-TW: `立即安裝`
  - en-US: `Install now`
- Failed install attempts show a compact error message in the banner area.

## Testing

- Add updater tests for interval checks and skipping duplicate checks while an update is downloaded.
- Add launcher rendering tests for the downloaded update banner and install action markup.
- Add app-level tests to ensure `LauncherPage` receives update APIs from `window.desktopApi`.
- Run targeted tests first, then full `test`, `typecheck`, and `lint`.
