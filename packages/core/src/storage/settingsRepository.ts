import {
  type CommandCabinDatabase,
  type StorageJsonValue,
  formatStorageValueContext,
  isStorageJsonObject,
  parseStorageJson,
  stringifyStorageJson,
} from './database.js';
import {
  type CommandCabinSettings,
  type CommandCabinSettingsPatch,
  type CommandCabinSettingsStore,
  createDefaultCommandCabinSettings,
  createInMemorySettingsStore,
} from './settings.js';

const SETTINGS_KEY = 'command-cabin';
const SETTINGS_CONTEXT = { table: 'settings', key: SETTINGS_KEY };
const SETTINGS_KEYS = new Set([
  'hotkey',
  'hideOnBlur',
  'theme',
  'language',
  'launchAtLogin',
  'search',
]);
const SEARCH_SETTINGS_KEYS = new Set([
  'maxResults',
  'historyBoost',
  'pluginBoost',
  'appBoost',
  'fileBoost',
]);

interface SettingsRow {
  value: string;
}

function createSettingsFromPatch(settingsPatch: CommandCabinSettingsPatch): CommandCabinSettings {
  return createInMemorySettingsStore(settingsPatch).getSettings();
}

function cloneSettings(settings: CommandCabinSettings): CommandCabinSettings {
  return createInMemorySettingsStore(settings).getSettings();
}

function throwInvalidSettings(reason: string): never {
  throw new Error(`Invalid settings in ${formatStorageValueContext(SETTINGS_CONTEXT)}: ${reason}`);
}

function validateOptionalString(
  settingsPatch: Record<string, unknown>,
  fieldName: keyof CommandCabinSettings,
): void {
  if (fieldName in settingsPatch && typeof settingsPatch[fieldName] !== 'string') {
    throwInvalidSettings(`${fieldName} must be a string`);
  }
}

function validateOptionalBoolean(
  settingsPatch: Record<string, unknown>,
  fieldName: keyof CommandCabinSettings,
): void {
  if (fieldName in settingsPatch && typeof settingsPatch[fieldName] !== 'boolean') {
    throwInvalidSettings(`${fieldName} must be a boolean`);
  }
}

function validateOptionalFiniteNumber(
  searchPatch: Record<string, unknown>,
  fieldName: keyof CommandCabinSettings['search'],
): void {
  if (fieldName in searchPatch && typeof searchPatch[fieldName] !== 'number') {
    throwInvalidSettings(`search.${fieldName} must be a number`);
  }
  if (
    fieldName in searchPatch &&
    typeof searchPatch[fieldName] === 'number' &&
    !Number.isFinite(searchPatch[fieldName])
  ) {
    throwInvalidSettings(`search.${fieldName} must be finite`);
  }
}

function validateSettingsPatch(value: unknown): CommandCabinSettingsPatch {
  if (!isStorageJsonObject(value)) {
    throwInvalidSettings('settings must be an object');
  }

  for (const key of Object.keys(value)) {
    if (!SETTINGS_KEYS.has(key)) {
      throwInvalidSettings(`unknown setting "${key}"`);
    }
  }

  validateOptionalString(value, 'hotkey');
  validateOptionalBoolean(value, 'hideOnBlur');
  validateOptionalBoolean(value, 'launchAtLogin');

  if (
    'theme' in value &&
    value.theme !== 'system' &&
    value.theme !== 'light' &&
    value.theme !== 'dark'
  ) {
    throwInvalidSettings('theme must be "system", "light", or "dark"');
  }

  if ('language' in value && value.language !== 'zh-CN' && value.language !== 'en-US') {
    throwInvalidSettings('language must be "zh-CN" or "en-US"');
  }

  if ('search' in value) {
    if (!isStorageJsonObject(value.search)) {
      throwInvalidSettings('search must be an object');
    }

    for (const key of Object.keys(value.search)) {
      if (!SEARCH_SETTINGS_KEYS.has(key)) {
        throwInvalidSettings(`unknown search setting "${key}"`);
      }
    }

    if ('maxResults' in value.search) {
      if (
        typeof value.search.maxResults !== 'number' ||
        !Number.isSafeInteger(value.search.maxResults) ||
        value.search.maxResults < 0
      ) {
        throwInvalidSettings('search.maxResults must be a safe integer >= 0');
      }
    }

    validateOptionalFiniteNumber(value.search, 'historyBoost');
    validateOptionalFiniteNumber(value.search, 'pluginBoost');
    validateOptionalFiniteNumber(value.search, 'appBoost');
    validateOptionalFiniteNumber(value.search, 'fileBoost');
  }

  return value as CommandCabinSettingsPatch;
}

function validateSettings(settings: CommandCabinSettings): CommandCabinSettings {
  return createSettingsFromPatch(validateSettingsPatch(settings));
}

export function createSettingsRepository(
  database: CommandCabinDatabase,
): CommandCabinSettingsStore {
  const selectSettings = database.prepare<{ key: string }, SettingsRow>(
    'SELECT value FROM settings WHERE key = @key',
  );
  const upsertSettings = database.prepare<{
    key: string;
    value: string;
    updatedAt: string;
  }>(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
  );

  function saveSettings(settings: CommandCabinSettings): void {
    const validSettings = validateSettings(settings);

    upsertSettings.run({
      key: SETTINGS_KEY,
      value: stringifyStorageJson(validSettings, SETTINGS_CONTEXT),
      updatedAt: new Date().toISOString(),
    });
  }

  function getSettings(): CommandCabinSettings {
    const row = selectSettings.get({ key: SETTINGS_KEY });

    if (!row) {
      return createDefaultCommandCabinSettings();
    }

    return createSettingsFromPatch(
      validateSettingsPatch(parseStorageJson<StorageJsonValue>(row.value, SETTINGS_CONTEXT)),
    );
  }

  return {
    getSettings,
    updateSettings: (settingsPatch) => {
      validateSettingsPatch(settingsPatch);
      const updatedSettings =
        createInMemorySettingsStore(getSettings()).updateSettings(settingsPatch);
      saveSettings(updatedSettings);
      return cloneSettings(updatedSettings);
    },
    resetSettings: () => {
      const defaultSettings = createDefaultCommandCabinSettings();
      saveSettings(defaultSettings);
      return cloneSettings(defaultSettings);
    },
  };
}
