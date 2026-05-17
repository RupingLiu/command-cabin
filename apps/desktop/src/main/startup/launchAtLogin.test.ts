import { describe, expect, it, vi } from 'vitest';

import {
  LOGIN_STARTUP_ARG,
  createLaunchAtLoginController,
  isLaunchAtLoginStartup,
} from './launchAtLogin.js';

describe('launch at login startup helpers', () => {
  it('detects the login startup argument', () => {
    expect(isLaunchAtLoginStartup(['CommandCabin.exe', LOGIN_STARTUP_ARG])).toBe(true);
    expect(isLaunchAtLoginStartup(['CommandCabin.exe', '--user-opened'])).toBe(false);
  });

  it('syncs enabled settings to Electron login item settings with hidden startup args', () => {
    const setLoginItemSettings = vi.fn();
    const controller = createLaunchAtLoginController({
      app: {
        setLoginItemSettings,
      },
      executablePath: 'C:\\Program Files\\command-cabin\\CommandCabin.exe',
    });

    controller.sync(true);

    expect(setLoginItemSettings).toHaveBeenCalledWith({
      args: [LOGIN_STARTUP_ARG],
      enabled: true,
      name: 'CommandCabin',
      openAtLogin: true,
      path: 'C:\\Program Files\\command-cabin\\CommandCabin.exe',
    });
  });

  it('removes the login item when disabled', () => {
    const setLoginItemSettings = vi.fn();
    const controller = createLaunchAtLoginController({
      app: {
        setLoginItemSettings,
      },
      executablePath: 'C:\\Program Files\\command-cabin\\CommandCabin.exe',
    });

    controller.sync(false);

    expect(setLoginItemSettings).toHaveBeenCalledWith({
      args: [],
      enabled: false,
      name: 'CommandCabin',
      openAtLogin: false,
      path: 'C:\\Program Files\\command-cabin\\CommandCabin.exe',
    });
  });
});
