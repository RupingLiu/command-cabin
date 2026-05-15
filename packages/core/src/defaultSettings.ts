export interface CommandCabinDefaults {
  readonly appId: 'com.commandcabin.app';
  readonly defaultHotkey: 'Alt+Space';
  readonly platformPriority: 'windows';
  readonly plugins: {
    readonly allowLocalThirdPartyPlugins: true;
  };
}

export function createDefaultSettings(): CommandCabinDefaults {
  return {
    appId: 'com.commandcabin.app',
    defaultHotkey: 'Alt+Space',
    platformPriority: 'windows',
    plugins: {
      allowLocalThirdPartyPlugins: true,
    },
  };
}
