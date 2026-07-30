export type CommandCabinWindowRole = 'launcher' | 'pinned-image' | 'screenshot';

export const WINDOW_ROLE_ARGUMENT_PREFIX = '--command-cabin-window-role=';
export const APP_VERSION_ARGUMENT_PREFIX = '--command-cabin-version=';
export const PLUGIN_PRELOAD_ARGUMENT_PREFIX = '--command-cabin-plugin-preload=';

function readArgumentValue(args: readonly string[], prefix: string): string | undefined {
  const argument = args.find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length).trim();

  return value && value.length > 0 ? value : undefined;
}

export function parseCommandCabinWindowRole(
  args: readonly string[],
): CommandCabinWindowRole | undefined {
  const role = readArgumentValue(args, WINDOW_ROLE_ARGUMENT_PREFIX);

  return role === 'launcher' || role === 'pinned-image' || role === 'screenshot' ? role : undefined;
}

export function readCommandCabinAppVersion(args: readonly string[]): string {
  return readArgumentValue(args, APP_VERSION_ARGUMENT_PREFIX) ?? '0.0.0';
}

export function readCommandCabinPluginPreloadPath(args: readonly string[]): string | undefined {
  return readArgumentValue(args, PLUGIN_PRELOAD_ARGUMENT_PREFIX);
}

export function createWindowPreloadArguments({
  appVersion,
  pluginPreloadPath,
  role,
}: {
  appVersion?: string | undefined;
  pluginPreloadPath?: string | undefined;
  role: CommandCabinWindowRole;
}): string[] {
  return [
    `${WINDOW_ROLE_ARGUMENT_PREFIX}${role}`,
    `${APP_VERSION_ARGUMENT_PREFIX}${appVersion?.trim() || '0.0.0'}`,
    ...(pluginPreloadPath ? [`${PLUGIN_PRELOAD_ARGUMENT_PREFIX}${pluginPreloadPath}`] : []),
  ];
}
