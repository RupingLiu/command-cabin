# Latest-Only Update Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure CommandCabin only prompts users to install the newest GitHub Release known to the updater.

**Architecture:** Keep `electron-updater` as the download engine, but separate remote latest-version knowledge from locally downloaded package knowledge inside the update controller. Publish `canInstall: true` only when the downloaded package version matches the latest known remote version, and keep the renderer using `canInstall` as the install-button authority.

**Tech Stack:** Electron main process, `electron-updater`, preload IPC, React renderer, TypeScript, Vitest, pnpm workspace.

---

### Task 1: Extend Update Status Version Metadata

**Files:**
- Modify: `apps/desktop/src/shared/updateApi.ts`
- Modify: `apps/desktop/src/shared/updateApi.test.ts`

- [ ] **Step 1: Write parser tests for explicit update version metadata**

Add this test to `apps/desktop/src/shared/updateApi.test.ts` after the existing downloaded-status test:

```ts
  it('accepts latest, active download, and downloaded version metadata', () => {
    expect(
      parseUpdateStatus({
        activeDownloadVersion: '0.8.8',
        canCheck: false,
        canInstall: false,
        downloadedVersion: '0.8.7',
        latestVersion: '0.8.8',
        phase: 'downloading',
        version: '0.8.8',
      }),
    ).toEqual({
      activeDownloadVersion: '0.8.8',
      canCheck: false,
      canInstall: false,
      downloadedVersion: '0.8.7',
      error: undefined,
      latestVersion: '0.8.8',
      percent: undefined,
      phase: 'downloading',
      version: '0.8.8',
    });
  });
```

- [ ] **Step 2: Run the focused parser test and verify it fails**

Run:

```powershell
corepack pnpm test apps/desktop/src/shared/updateApi.test.ts
```

Expected: FAIL because `UpdateStatus` does not yet preserve `latestVersion`, `downloadedVersion`, or `activeDownloadVersion`.

- [ ] **Step 3: Add optional metadata fields to `UpdateStatus`**

In `apps/desktop/src/shared/updateApi.ts`, extend the interface:

```ts
export interface UpdateStatus {
  activeDownloadVersion?: string | undefined;
  canCheck: boolean;
  canInstall: boolean;
  downloadedVersion?: string | undefined;
  error?: string | undefined;
  latestVersion?: string | undefined;
  percent?: number | undefined;
  phase: UpdateStatusPhase;
  version?: string | undefined;
}
```

Then update `parseUpdateStatus()` to preserve those fields:

```ts
  return {
    activeDownloadVersion: parseOptionalString(
      value.activeDownloadVersion,
      'Invalid update status activeDownloadVersion',
    ),
    canCheck: parseBoolean(value.canCheck, 'Invalid update status canCheck'),
    canInstall: parseBoolean(value.canInstall, 'Invalid update status canInstall'),
    downloadedVersion: parseOptionalString(
      value.downloadedVersion,
      'Invalid update status downloadedVersion',
    ),
    error: parseOptionalString(value.error, 'Invalid update status error'),
    latestVersion: parseOptionalString(
      value.latestVersion,
      'Invalid update status latestVersion',
    ),
    percent: parseOptionalPercent(value.percent),
    phase: value.phase as UpdateStatusPhase,
    version: parseOptionalString(value.version, 'Invalid update status version'),
  };
```

- [ ] **Step 4: Run parser tests and commit**

Run:

```powershell
corepack pnpm test apps/desktop/src/shared/updateApi.test.ts
```

Expected: PASS.

Commit:

```powershell
git add apps/desktop/src/shared/updateApi.ts apps/desktop/src/shared/updateApi.test.ts
git commit -m "feat: expose update version metadata"
```

### Task 2: Enforce Latest-Only Install Eligibility In The Update Controller

**Files:**
- Modify: `apps/desktop/src/main/updater/updateController.ts`
- Modify: `apps/desktop/src/main/updater/updateController.test.ts`

- [ ] **Step 1: Add failing controller tests for stale downloaded packages**

In `apps/desktop/src/main/updater/updateController.test.ts`, replace the existing test named `does not re-check once an update package is downloaded` with this version:

```ts
  it('does not re-check once the latest update package is downloaded', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '0.3.0' });
    updater.emit('update-downloaded', { version: '0.3.0' });

    await expect(controller.checkForUpdates()).resolves.toMatchObject({
      canInstall: true,
      downloadedVersion: '0.3.0',
      latestVersion: '0.3.0',
      phase: 'downloaded',
      version: '0.3.0',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
```

Add these tests after it:

```ts
  it('hides a downloaded package after a newer remote version is discovered', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '1.0.1' });
    updater.emit('update-downloaded', { version: '1.0.1' });
    expect(controller.getStatus()).toMatchObject({
      canInstall: true,
      downloadedVersion: '1.0.1',
      latestVersion: '1.0.1',
      phase: 'downloaded',
    });

    updater.emit('update-available', { version: '1.0.2' });

    expect(controller.getStatus()).toMatchObject({
      activeDownloadVersion: '1.0.2',
      canInstall: false,
      downloadedVersion: '1.0.1',
      latestVersion: '1.0.2',
      phase: 'available',
      version: '1.0.2',
    });
  });

  it('does not mark a stale downloaded event as installable while a newer version is active', () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '1.0.1' });
    updater.emit('update-available', { version: '1.0.2' });
    updater.emit('update-downloaded', { version: '1.0.1' });

    expect(controller.getStatus()).toMatchObject({
      activeDownloadVersion: '1.0.2',
      canInstall: false,
      downloadedVersion: '1.0.1',
      latestVersion: '1.0.2',
      phase: 'downloading',
      version: '1.0.2',
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not fall back to an older downloaded package after a newer download fails', async () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-available', { version: '1.0.1' });
    updater.emit('update-downloaded', { version: '1.0.1' });

    updater.downloadUpdate = vi.fn(async () => {
      throw new Error('Network timeout');
    });
    updater.emit('update-available', { version: '1.0.2' });
    await Promise.resolve();

    expect(controller.getStatus()).toMatchObject({
      canInstall: false,
      downloadedVersion: '1.0.1',
      error: 'Network timeout',
      latestVersion: '1.0.2',
      phase: 'error',
      version: '1.0.2',
    });
  });

  it('keeps install disabled when downloaded version metadata is missing', () => {
    const controller = createUpdateController({
      autoUpdater: updater,
      getWindows: () => [sender],
      isPackaged: true,
      logger: console,
    });

    updater.emit('update-downloaded', {});

    expect(controller.getStatus()).toMatchObject({
      canCheck: true,
      canInstall: false,
      phase: 'downloaded',
    });
    expect(controller.installUpdate()).toEqual({
      error: 'Update is not ready to install.',
      ok: false,
    });
  });
```

- [ ] **Step 2: Run the controller tests and verify they fail**

Run:

```powershell
corepack pnpm test apps/desktop/src/main/updater/updateController.test.ts
```

Expected: FAIL because `canInstall` is still derived only from `phase === 'downloaded'`.

- [ ] **Step 3: Add internal version knowledge and status publishing helpers**

In `apps/desktop/src/main/updater/updateController.ts`, add this type near `ProgressInfoLike`:

```ts
interface UpdateVersionKnowledge {
  activeDownloadVersion?: string | undefined;
  downloadedVersion?: string | undefined;
  latestVersion?: string | undefined;
}
```

Inside `createUpdateController()`, after the `status` initializer, add:

```ts
  let versionKnowledge: UpdateVersionKnowledge = {};
```

Replace `mergeStatus()` with these helpers:

```ts
  function isLatestDownloaded(): boolean {
    return (
      versionKnowledge.downloadedVersion !== undefined &&
      versionKnowledge.latestVersion !== undefined &&
      versionKnowledge.downloadedVersion === versionKnowledge.latestVersion
    );
  }

  function getDisplayVersion(phase: UpdateStatus['phase'], patchVersion?: string): string | undefined {
    if (patchVersion !== undefined) {
      return patchVersion;
    }
    if (phase === 'downloaded') {
      return versionKnowledge.downloadedVersion ?? versionKnowledge.latestVersion ?? status.version;
    }
    return (
      versionKnowledge.activeDownloadVersion ??
      versionKnowledge.latestVersion ??
      versionKnowledge.downloadedVersion ??
      status.version
    );
  }

  function mergeStatus(patch: Partial<UpdateStatus> & Pick<UpdateStatus, 'phase'>): UpdateStatus {
    const canInstall = patch.phase === 'downloaded' && isLatestDownloaded();
    const isBusy =
      patch.phase === 'checking' ||
      patch.phase === 'available' ||
      patch.phase === 'downloading';
    const isReady = patch.phase === 'downloaded' && canInstall;

    return publish({
      activeDownloadVersion: versionKnowledge.activeDownloadVersion,
      canCheck: !isBusy && !isReady && isPackaged,
      canInstall,
      downloadedVersion: versionKnowledge.downloadedVersion,
      error: patch.error,
      latestVersion: versionKnowledge.latestVersion,
      percent: patch.percent,
      phase: patch.phase,
      version: getDisplayVersion(patch.phase, patch.version),
    });
  }
```

If `exactOptionalPropertyTypes` complains about assigning `undefined` optional fields, introduce a small `compactStatus()` helper instead of assigning undefined fields directly:

```ts
  function compactStatus(nextStatus: UpdateStatus): UpdateStatus {
    return Object.fromEntries(
      Object.entries(nextStatus).filter(([, value]) => value !== undefined),
    ) as UpdateStatus;
  }
```

Then call `publish(compactStatus({ ... }))`.

- [ ] **Step 4: Update updater event handlers**

Adjust event handlers in `apps/desktop/src/main/updater/updateController.ts` to maintain `versionKnowledge`:

```ts
  autoUpdater.on('update-available', (info: unknown) => {
    const latestVersion = getVersion(info);
    if (latestVersion !== undefined) {
      versionKnowledge = {
        ...versionKnowledge,
        activeDownloadVersion: latestVersion,
        latestVersion,
      };
    } else {
      versionKnowledge = {
        ...versionKnowledge,
        activeDownloadVersion: undefined,
      };
    }

    mergeStatus({ phase: 'available', version: latestVersion });
    void autoUpdater.downloadUpdate().catch((error: unknown) => {
      logger.error('Update download failed.', error);
      mergeStatus({
        error: getErrorMessage(error),
        phase: 'error',
        version: versionKnowledge.latestVersion,
      });
    });
  });
```

```ts
  autoUpdater.on('update-not-available', (info: unknown) => {
    const version = getVersion(info);
    if (version !== undefined) {
      versionKnowledge = {
        ...versionKnowledge,
        latestVersion: version,
      };
    }
    mergeStatus({ phase: 'up-to-date', version });
  });
```

```ts
  autoUpdater.on('download-progress', (progress: unknown) => {
    mergeStatus({
      percent: getPercent(progress),
      phase: 'downloading',
      version: versionKnowledge.activeDownloadVersion ?? versionKnowledge.latestVersion,
    });
  });
```

```ts
  autoUpdater.on('update-downloaded', (info: unknown) => {
    const downloadedVersion = getVersion(info);
    if (downloadedVersion !== undefined) {
      versionKnowledge = {
        ...versionKnowledge,
        downloadedVersion,
        latestVersion: versionKnowledge.latestVersion ?? downloadedVersion,
      };
    }

    if (downloadedVersion !== undefined && downloadedVersion === versionKnowledge.latestVersion) {
      versionKnowledge = {
        ...versionKnowledge,
        activeDownloadVersion: undefined,
      };
      mergeStatus({ phase: 'downloaded', version: downloadedVersion });
      return;
    }

    mergeStatus({
      phase: versionKnowledge.activeDownloadVersion ? 'downloading' : 'downloaded',
      version: versionKnowledge.activeDownloadVersion ?? versionKnowledge.latestVersion,
    });
  });
```

Keep the existing `error` handler, but pass `version: versionKnowledge.latestVersion` in its `mergeStatus()` call.

- [ ] **Step 5: Update `checkForUpdates()` and `installUpdate()` guards**

In `checkForUpdates()`, replace the early return condition with:

```ts
    if (
      status.phase === 'checking' ||
      status.phase === 'available' ||
      status.phase === 'downloading' ||
      (status.phase === 'downloaded' && status.canInstall)
    ) {
      return status;
    }
```

In `installUpdate()`, require both the phase and `canInstall`:

```ts
      if (status.phase !== 'downloaded' || !status.canInstall) {
        return {
          error: 'Update is not ready to install.',
          ok: false,
        };
      }
```

- [ ] **Step 6: Run controller tests and commit**

Run:

```powershell
corepack pnpm test apps/desktop/src/main/updater/updateController.test.ts
```

Expected: PASS.

Commit:

```powershell
git add apps/desktop/src/main/updater/updateController.ts apps/desktop/src/main/updater/updateController.test.ts
git commit -m "fix: install only latest downloaded update"
```

### Task 3: Add Renderer Guard Tests For Stale Downloaded Updates

**Files:**
- Modify: `apps/desktop/src/renderer/src/launcher/launcherAria.test.ts`
- Modify: `apps/desktop/src/renderer/src/settings/AboutSettings.test.ts`

- [ ] **Step 1: Add a launcher test for stale downloaded status**

In `apps/desktop/src/renderer/src/launcher/launcherAria.test.ts`, add this test after `shows a downloaded update prompt on the launcher home screen`:

```ts
  it('does not show a launcher install action for a stale downloaded update', () => {
    const html = renderToStaticMarkup(
      createElement(LauncherPage, {
        language: 'zh-CN',
        onOpenSettings: vi.fn(),
        onOpenUnitConverter: vi.fn(),
        updateState: {
          errorMessage: undefined,
          isInstalling: false,
          status: {
            canCheck: true,
            canInstall: false,
            downloadedVersion: '1.0.1',
            latestVersion: '1.0.2',
            phase: 'error',
            version: '1.0.2',
            error: 'Network timeout',
          },
        },
      }),
    );

    expect(html).toContain('无法连接 GitHub 检查更新');
    expect(html).toContain('Network timeout');
    expect(html).toContain('查看设置');
    expect(html).not.toContain('立即安装');
  });
```

- [ ] **Step 2: Add a settings test for stale downloaded status**

In `apps/desktop/src/renderer/src/settings/AboutSettings.test.ts`, add this test after `renders download progress and install action`:

```ts
  it('does not render an install action for a stale downloaded update', () => {
    const markup = renderToStaticMarkup(
      createElement(AboutSettings, {
        appInfo,
        state: {
          errorMessage: undefined,
          isChecking: false,
          isInstalling: false,
          status: {
            canCheck: true,
            canInstall: false,
            downloadedVersion: '1.0.1',
            latestVersion: '1.0.2',
            phase: 'error',
            version: '1.0.2',
            error: 'Network timeout',
          },
        },
      }),
    );

    expect(markup).toContain('Network timeout');
    expect(markup).not.toContain('重启安装');
  });
```

- [ ] **Step 3: Run renderer tests and commit**

Run:

```powershell
corepack pnpm test apps/desktop/src/renderer/src/launcher/launcherAria.test.ts apps/desktop/src/renderer/src/settings/AboutSettings.test.ts
```

Expected: PASS.

Commit:

```powershell
git add apps/desktop/src/renderer/src/launcher/launcherAria.test.ts apps/desktop/src/renderer/src/settings/AboutSettings.test.ts
git commit -m "test: cover stale update install prompts"
```

### Task 4: Final Verification

**Files:**
- No production file changes expected in this task.

- [ ] **Step 1: Run typecheck**

Run:

```powershell
corepack pnpm typecheck
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```powershell
corepack pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

Run:

```powershell
corepack pnpm test
```

Expected: PASS.

- [ ] **Step 4: Run diff whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 5: Confirm worktree state**

Run:

```powershell
git status --short --branch
```

Expected: branch may be ahead of `origin/main`; `.superpowers/` may remain untracked; no modified tracked files should remain.
