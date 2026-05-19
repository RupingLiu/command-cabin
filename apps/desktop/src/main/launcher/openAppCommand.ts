import type { CommandPayload } from '@command-cabin/core';

export interface OpenAppCommandShell {
  openExternal: (url: string) => Promise<void> | void;
  openPath: (path: string) => Promise<string> | string;
}

function getRequiredStringPayloadValue(payload: CommandPayload, key: string): string {
  const value = payload[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`App ${key} is missing.`);
  }

  return value.trim();
}

function getOptionalStringPayloadValue(payload: CommandPayload, key: string): string | undefined {
  const value = payload[key];
  const trimmedValue = typeof value === 'string' ? value.trim() : '';

  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function createAppsFolderUri(appUserModelId: string): string {
  return `shell:AppsFolder\\${appUserModelId}`;
}

export function createOpenAppCommand({ openExternal, openPath }: OpenAppCommandShell) {
  return async (payload: CommandPayload): Promise<void> => {
    const appUserModelId = getOptionalStringPayloadValue(payload, 'appUserModelId');

    if (appUserModelId !== undefined) {
      await openExternal(createAppsFolderUri(appUserModelId));
      return;
    }

    const shortcutPath = getRequiredStringPayloadValue(payload, 'shortcutPath');
    const errorMessage = await openPath(shortcutPath);

    if (errorMessage.trim().length > 0) {
      throw new Error(errorMessage);
    }
  };
}
