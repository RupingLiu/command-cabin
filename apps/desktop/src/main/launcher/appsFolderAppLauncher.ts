import { spawn } from 'node:child_process';

export interface AppsFolderAppLauncherSpawnOptions {
  detached: boolean;
  stdio: 'ignore';
  windowsHide: boolean;
}

export interface AppsFolderAppLauncherChildProcess {
  on: (event: 'error', listener: (error: Error) => void) => AppsFolderAppLauncherChildProcess;
  unref: () => void;
}

export type AppsFolderAppLauncherSpawn = (
  file: string,
  args: string[],
  options: AppsFolderAppLauncherSpawnOptions,
) => AppsFolderAppLauncherChildProcess;

export interface ExplorerAppsFolderAppLauncherOptions {
  logger?: Pick<Console, 'warn'> | undefined;
  spawn?: AppsFolderAppLauncherSpawn | undefined;
}

export function createExplorerAppsFolderAppLauncher({
  logger = console,
  spawn: spawnProcess = spawn,
}: ExplorerAppsFolderAppLauncherOptions = {}) {
  return async (appsFolderUri: string): Promise<void> => {
    const childProcess = spawnProcess('explorer.exe', [appsFolderUri], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    childProcess.on('error', (error) => {
      logger.warn('Failed to launch AppsFolder app through explorer.exe.', error);
    });
    childProcess.unref();
  };
}
