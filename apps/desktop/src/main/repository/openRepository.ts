export const COMMAND_CABIN_REPOSITORY_URL = 'https://github.com/RupingLiu/command-cabin';

export interface OpenRepositoryOptions {
  openExternal: (url: string) => Promise<void> | void;
}

export async function openRepository({ openExternal }: OpenRepositoryOptions): Promise<boolean> {
  await openExternal(COMMAND_CABIN_REPOSITORY_URL);
  return true;
}
