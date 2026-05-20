import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AppsFolderAppLauncherExecFileOptions {
  windowsHide: boolean;
}

export type AppsFolderAppLauncherExecFile = (
  file: string,
  args: string[],
  options: AppsFolderAppLauncherExecFileOptions,
) => Promise<unknown>;

export interface ExplorerAppsFolderAppLauncherOptions {
  execFile?: AppsFolderAppLauncherExecFile | undefined;
}

export function createExplorerAppsFolderAppLauncher({
  execFile = execFileAsync,
}: ExplorerAppsFolderAppLauncherOptions = {}) {
  return async (appsFolderUri: string): Promise<void> => {
    await execFile('explorer.exe', [appsFolderUri], {
      windowsHide: true,
    });
  };
}
