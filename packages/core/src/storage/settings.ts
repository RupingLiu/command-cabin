export type CommandCabinTheme = 'system' | 'light' | 'dark';
export type CommandCabinLanguage = 'zh-CN' | 'zh-TW' | 'en-US';
export type DeepReadonly<T> = T extends object
  ? {
      readonly [Key in keyof T]: DeepReadonly<T[Key]>;
    }
  : T;

export interface CommandCabinSearchSettings {
  maxResults: number;
  historyBoost: number;
  pluginBoost: number;
  appBoost: number;
  fileBoost: number;
}

export interface CommandCabinSettings {
  hotkey: string;
  hideOnBlur: boolean;
  theme: CommandCabinTheme;
  language: CommandCabinLanguage;
  launchAtLogin: boolean;
  preserveSearchQuery: boolean;
  search: CommandCabinSearchSettings;
}

export type CommandCabinSettingsPatch = Partial<Omit<CommandCabinSettings, 'search'>> & {
  search?: Partial<CommandCabinSearchSettings>;
};

export interface CommandCabinSettingsStore {
  getSettings: () => CommandCabinSettings;
  updateSettings: (settingsPatch: CommandCabinSettingsPatch) => CommandCabinSettings;
  resetSettings: () => CommandCabinSettings;
}

function deepFreeze<T extends object>(value: T): DeepReadonly<T> {
  for (const propertyName of Object.getOwnPropertyNames(value) as Array<keyof T>) {
    const propertyValue = value[propertyName];

    if (propertyValue && typeof propertyValue === 'object') {
      deepFreeze(propertyValue);
    }
  }

  return Object.freeze(value) as DeepReadonly<T>;
}

export const DEFAULT_COMMAND_CABIN_SETTINGS: DeepReadonly<CommandCabinSettings> = deepFreeze({
  hotkey: 'Alt+Space',
  hideOnBlur: true,
  theme: 'system',
  language: 'zh-CN',
  launchAtLogin: false,
  preserveSearchQuery: false,
  search: {
    maxResults: 20,
    historyBoost: 1.4,
    pluginBoost: 1,
    appBoost: 1.2,
    fileBoost: 0.9,
  },
});

function cloneSettings(settings: DeepReadonly<CommandCabinSettings>): CommandCabinSettings {
  return {
    ...settings,
    search: {
      ...settings.search,
    },
  };
}

function mergeSettings(
  baseSettings: CommandCabinSettings,
  settingsPatch: CommandCabinSettingsPatch,
): CommandCabinSettings {
  return {
    ...baseSettings,
    ...settingsPatch,
    search: {
      ...baseSettings.search,
      ...(settingsPatch.search ?? {}),
    },
  };
}

export function createDefaultCommandCabinSettings(): CommandCabinSettings {
  return cloneSettings(DEFAULT_COMMAND_CABIN_SETTINGS);
}

export function createInMemorySettingsStore(
  initialSettings: CommandCabinSettingsPatch = {},
): CommandCabinSettingsStore {
  let currentSettings = mergeSettings(createDefaultCommandCabinSettings(), initialSettings);

  return {
    getSettings: () => cloneSettings(currentSettings),
    updateSettings: (settingsPatch) => {
      currentSettings = mergeSettings(currentSettings, settingsPatch);
      return cloneSettings(currentSettings);
    },
    resetSettings: () => {
      currentSettings = createDefaultCommandCabinSettings();
      return cloneSettings(currentSettings);
    },
  };
}
