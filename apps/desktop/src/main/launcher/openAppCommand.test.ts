import { describe, expect, it, vi } from 'vitest';

import { createOpenAppCommand } from './openAppCommand.js';

describe('createOpenAppCommand', () => {
  it('opens AppUserModelID commands through the Windows AppsFolder shell URI', async () => {
    const openPath = vi.fn(async () => '');
    const openExternal = vi.fn(async () => undefined);
    const openApp = createOpenAppCommand({ openExternal, openPath });

    await openApp({
      appUserModelId: 'DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
      shortcutPath: 'shell:AppsFolder\\DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
    });

    expect(openExternal).toHaveBeenCalledWith(
      'shell:AppsFolder\\DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it('keeps shortcut commands on the file path opener', async () => {
    const openPath = vi.fn(async () => '');
    const openExternal = vi.fn(async () => undefined);
    const openApp = createOpenAppCommand({ openExternal, openPath });

    await openApp({
      shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad.lnk',
    });

    expect(openPath).toHaveBeenCalledWith(
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad.lnk',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('raises shell path errors for shortcut commands', async () => {
    const openApp = createOpenAppCommand({
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => 'The system cannot find the file specified.'),
    });

    await expect(
      openApp({
        shortcutPath: 'C:\\Missing\\Broken.lnk',
      }),
    ).rejects.toThrow('The system cannot find the file specified.');
  });
});
