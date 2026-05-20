import { describe, expect, it, vi } from 'vitest';

import { createExplorerAppsFolderAppLauncher } from './appsFolderAppLauncher.js';

describe('createExplorerAppsFolderAppLauncher', () => {
  it('opens AppsFolder app URIs through explorer.exe', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const openAppsFolderApp = createExplorerAppsFolderAppLauncher({ execFile });

    await openAppsFolderApp(
      'shell:AppsFolder\\AD2F1837.HPPrinterControl_v10z8vjag6ke6!AD2F1837.HPPrinterControl',
    );

    expect(execFile).toHaveBeenCalledWith(
      'explorer.exe',
      ['shell:AppsFolder\\AD2F1837.HPPrinterControl_v10z8vjag6ke6!AD2F1837.HPPrinterControl'],
      {
        windowsHide: true,
      },
    );
  });
});
