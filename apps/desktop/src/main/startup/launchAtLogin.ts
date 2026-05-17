export const LOGIN_STARTUP_ARG = '--command-cabin-login-startup';

export interface LaunchAtLoginApp {
  setLoginItemSettings: (settings: {
    args: string[];
    enabled: boolean;
    name: string;
    openAtLogin: boolean;
    path: string;
  }) => void;
}

export interface LaunchAtLoginController {
  sync: (enabled: boolean) => void;
}

export interface CreateLaunchAtLoginControllerOptions {
  app: LaunchAtLoginApp;
  executablePath?: string;
  loginStartupArg?: string;
}

export function isLaunchAtLoginStartup(
  argv: readonly string[],
  loginStartupArg = LOGIN_STARTUP_ARG,
): boolean {
  return argv.includes(loginStartupArg);
}

export function createLaunchAtLoginController({
  app,
  executablePath = process.execPath,
  loginStartupArg = LOGIN_STARTUP_ARG,
}: CreateLaunchAtLoginControllerOptions): LaunchAtLoginController {
  return {
    sync: (enabled) => {
      app.setLoginItemSettings({
        args: enabled ? [loginStartupArg] : [],
        enabled,
        name: 'CommandCabin',
        openAtLogin: enabled,
        path: executablePath,
      });
    },
  };
}
