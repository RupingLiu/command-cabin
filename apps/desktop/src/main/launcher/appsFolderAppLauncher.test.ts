import { describe, expect, it, vi } from 'vitest';

import { createExplorerAppsFolderAppLauncher } from './appsFolderAppLauncher.js';

describe('createExplorerAppsFolderAppLauncher', () => {
  it('opens AppsFolder app URIs through explorer.exe', async () => {
    const childProcess = {
      on: vi.fn(() => childProcess),
      unref: vi.fn(),
    };
    const spawn = vi.fn(() => childProcess);
    const openAppsFolderApp = createExplorerAppsFolderAppLauncher({ spawn });

    await openAppsFolderApp(
      'shell:AppsFolder\\AD2F1837.HPPrinterControl_v10z8vjag6ke6!AD2F1837.HPPrinterControl',
    );

    expect(spawn).toHaveBeenCalledWith(
      'explorer.exe',
      ['shell:AppsFolder\\AD2F1837.HPPrinterControl_v10z8vjag6ke6!AD2F1837.HPPrinterControl'],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    expect(childProcess.unref).toHaveBeenCalledOnce();
  });

  it('does not wait for explorer.exe exit before reporting launch success', async () => {
    const childProcess = {
      on: vi.fn(() => childProcess),
      unref: vi.fn(),
    };
    const spawn = vi.fn(() => childProcess);
    const openAppsFolderApp = createExplorerAppsFolderAppLauncher({ spawn });

    await expect(
      openAppsFolderApp(
        'shell:AppsFolder\\AD2F1837.HPPrinterControl_v10z8vjag6ke6!AD2F1837.HPPrinterControl',
      ),
    ).resolves.toBeUndefined();

    expect(childProcess.on).not.toHaveBeenCalledWith('exit', expect.any(Function));
    expect(childProcess.on).not.toHaveBeenCalledWith('close', expect.any(Function));
  });
});
