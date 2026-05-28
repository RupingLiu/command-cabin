# Latest-Only Update Install Design

## Context

CommandCabin currently checks GitHub Releases through `electron-updater`, downloads available
updates in the background, and shows a launcher-home install prompt once an update package is
downloaded.

The current state model treats "downloaded" as globally installable. In a fast release sequence,
that can produce a confusing path:

1. The installed app is `v1.0.0`.
2. The app starts downloading `v1.0.1`.
3. GitHub later reports `v1.0.2` as the newest release.
4. `v1.0.1` finishes downloading before `v1.0.2`.
5. The launcher can still prompt the user to install `v1.0.1`.

That is not the desired behavior. The launcher should only invite the user to install the latest
version known from GitHub.

## Decision

CommandCabin will only show an install action when the downloaded package version matches the
latest remote version known by the updater.

If a newer remote version is known, an older downloaded package becomes stale for UI purposes. The
app should not offer to install it from the launcher or settings screen.

## Update State Model

The update controller should track these concepts separately:

- `latestVersion`: the newest version reported by GitHub.
- `downloadedVersion`: the version of the package that has finished downloading locally.
- `activeDownloadVersion`: the version currently being downloaded, when known.

The existing `version` field can continue to be used for current UI compatibility, but internally
the controller needs enough state to answer one question reliably:

> Is the downloaded package also the latest known remote version?

Only when the answer is yes should `canInstall` be true.

## Launcher And Settings Behavior

The home-screen update banner and the settings "About and updates" section should follow the same
rule:

- While checking GitHub, show the existing checking message.
- While downloading the latest known version, show download progress for that latest version.
- When the latest known version is downloaded, show the install action.
- If the latest known version fails to download, show the failure and let the user retry/check
  again.
- If an older package is already downloaded but a newer remote version is known, do not show the
  install action for the older package.

This means the app may temporarily hide an older downloaded package if it knows that a newer
version exists. That is intentional; it avoids a user installing `v1.0.1` and immediately being
asked to install `v1.0.2`.

## Example Scenarios

### Current app is `v1.0.0`; GitHub latest is already `v1.0.2`

The app should discover and download `v1.0.2`. It should never prompt for `v1.0.1`.

### `v1.0.1` is downloaded, then GitHub reports `v1.0.2`

The app should stop treating `v1.0.1` as installable in the UI. The launcher should show the
`v1.0.2` checking/downloading/error state instead. The install button returns only after `v1.0.2`
has downloaded successfully.

### `v1.0.2` download fails while `v1.0.1` is available locally

The app should report the `v1.0.2` download failure and offer retry/check behavior. It should not
fall back to prompting installation of `v1.0.1`.

## Error Handling

If version metadata is missing from an updater event, the controller should avoid claiming an
outdated package is installable. Missing version data should degrade toward "not installable until
confirmed" rather than exposing a stale install button.

If a manual or automatic check runs while a stale downloaded package exists, the check should be
allowed when the controller needs to confirm whether the downloaded version is still latest.

## Testing

Add controller tests for:

- A downloaded package matching the latest known version sets `canInstall: true`.
- A downloaded package older than the latest known version keeps `canInstall: false`.
- A newer `update-available` event after an older `update-downloaded` event hides the old install
  prompt.
- A failed newer download does not fall back to the older downloaded package.
- Manual/background checks are not blocked merely because a stale downloaded package exists.

Renderer tests should assert that install buttons are shown only when `canInstall` is true and the
status represents the latest downloaded version.

## Out Of Scope

This change does not need to manually delete old update cache files. It only needs to prevent stale
packages from being presented as the preferred install action.
