import type {
  CommandCabinLanguage,
  CommandCabinSearchSettings,
  CommandCabinSettings,
  CommandCabinSettingsPatch,
  CommandCabinTheme,
  PluginRecord,
} from '@command-cabin/core';

export type SettingsReadResponse = CommandCabinSettings;
export type SettingsUpdateRequest = CommandCabinSettingsPatch;
export type SettingsUpdateResponse = CommandCabinSettings;
export type PluginListRecord = PluginRecord;

export interface DataDirectoryResponse {
  path: string;
}

export interface PluginInstallRequest {
  pluginRoot: string;
}

const settingsKeys = new Set([
  'hotkey',
  'screenshotHotkey',
  'delayedScreenshotHotkey',
  'hideOnBlur',
  'theme',
  'language',
  'launchAtLogin',
  'preserveSearchQuery',
  'search',
]);
const searchSettingsKeys = new Set([
  'maxResults',
  'historyBoost',
  'pluginBoost',
  'appBoost',
  'fileBoost',
]);
const themes = new Set<CommandCabinTheme>(['system', 'light', 'dark']);
const languages = new Set<CommandCabinLanguage>(['zh-CN', 'zh-TW', 'en-US']);
const hotkeyModifiers = new Set([
  'Alt',
  'Command',
  'CommandOrControl',
  'Control',
  'Ctrl',
  'Meta',
  'Shift',
  'Super',
]);
const hotkeyNamedKeys = new Set([
  'Space',
  'Tab',
  'Esc',
  'Escape',
  'Enter',
  'Return',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Up',
  'Down',
  'Left',
  'Right',
  'Plus',
  'Minus',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function parseNonEmptyString(value: unknown, context: string): string {
  const stringValue = parseString(value, context).trim();

  if (stringValue.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return stringValue;
}

export function parseHotkeyAccelerator(value: unknown, context = 'Hotkey'): string {
  const accelerator = parseNonEmptyString(value, context);
  const parts = accelerator.split('+').map((part) => part.trim());

  if (parts.some((part) => part.length === 0)) {
    throw new Error(`${context} contains an empty key part.`);
  }

  if (parts.length < 2) {
    throw new Error(`${context} must include at least one modifier.`);
  }

  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  const seenModifiers = new Set<string>();

  for (const modifier of modifiers) {
    if (!hotkeyModifiers.has(modifier)) {
      throw new Error(`${context} contains unsupported modifier "${modifier}".`);
    }

    if (seenModifiers.has(modifier)) {
      throw new Error(`${context} contains duplicate modifier "${modifier}".`);
    }

    seenModifiers.add(modifier);
  }

  if (hotkeyModifiers.has(key)) {
    throw new Error(`${context} must include a non-modifier key.`);
  }

  if (
    /^[A-Z0-9]$/i.test(key) ||
    /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) ||
    hotkeyNamedKeys.has(key)
  ) {
    return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join('+');
  }

  throw new Error(`${context} contains unsupported key "${key}".`);
}

function parseBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

function parseFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number.`);
  }

  return value;
}

function parseNonNegativeInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative integer.`);
  }

  return value;
}

function parseTheme(value: unknown, context: string): CommandCabinTheme {
  const theme = parseString(value, context);

  if (!themes.has(theme as CommandCabinTheme)) {
    throw new Error(`${context} must be "system", "light", or "dark".`);
  }

  return theme as CommandCabinTheme;
}

function parseLanguage(value: unknown, context: string): CommandCabinLanguage {
  const language = parseString(value, context);

  if (!languages.has(language as CommandCabinLanguage)) {
    throw new Error(`${context} must be "zh-CN", "zh-TW", or "en-US".`);
  }

  return language as CommandCabinLanguage;
}

function parseSearchSettings(value: unknown, context: string): CommandCabinSearchSettings {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  return {
    appBoost: parseFiniteNumber(value.appBoost, `${context}.appBoost`),
    fileBoost: parseFiniteNumber(value.fileBoost, `${context}.fileBoost`),
    historyBoost: parseFiniteNumber(value.historyBoost, `${context}.historyBoost`),
    maxResults: parseNonNegativeInteger(value.maxResults, `${context}.maxResults`),
    pluginBoost: parseFiniteNumber(value.pluginBoost, `${context}.pluginBoost`),
  };
}

function parseSearchSettingsPatch(
  value: unknown,
  context: string,
): Partial<CommandCabinSearchSettings> {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!searchSettingsKeys.has(key)) {
      throw new Error(`${context} contains unknown search setting "${key}".`);
    }
  }

  const patch: Partial<CommandCabinSearchSettings> = {};

  if ('appBoost' in value) {
    patch.appBoost = parseFiniteNumber(value.appBoost, `${context}.appBoost`);
  }
  if ('fileBoost' in value) {
    patch.fileBoost = parseFiniteNumber(value.fileBoost, `${context}.fileBoost`);
  }
  if ('historyBoost' in value) {
    patch.historyBoost = parseFiniteNumber(value.historyBoost, `${context}.historyBoost`);
  }
  if ('maxResults' in value) {
    patch.maxResults = parseNonNegativeInteger(value.maxResults, `${context}.maxResults`);
  }
  if ('pluginBoost' in value) {
    patch.pluginBoost = parseFiniteNumber(value.pluginBoost, `${context}.pluginBoost`);
  }

  return patch;
}

function parseIsoDateString(value: unknown, context: string): string {
  const dateString = parseString(value, context);

  if (!Number.isFinite(new Date(dateString).getTime())) {
    throw new Error(`${context} must be a valid ISO date string.`);
  }

  return dateString;
}

function parseStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`);
  }

  return value.map((item, index) => parseString(item, `${context}[${index}]`));
}

export function parseSettings(value: unknown): CommandCabinSettings {
  const context = 'Invalid settings response';

  if (!isRecord(value)) {
    throw new Error(`${context}: settings must be an object.`);
  }

  return {
    hideOnBlur: parseBoolean(value.hideOnBlur, `${context}.hideOnBlur`),
    hotkey: parseHotkeyAccelerator(value.hotkey, `${context}.hotkey`),
    screenshotHotkey: parseHotkeyAccelerator(value.screenshotHotkey, `${context}.screenshotHotkey`),
    delayedScreenshotHotkey: parseHotkeyAccelerator(
      value.delayedScreenshotHotkey,
      `${context}.delayedScreenshotHotkey`,
    ),
    language: parseLanguage(value.language, `${context}.language`),
    launchAtLogin: parseBoolean(value.launchAtLogin, `${context}.launchAtLogin`),
    preserveSearchQuery: parseBoolean(value.preserveSearchQuery, `${context}.preserveSearchQuery`),
    search: parseSearchSettings(value.search, `${context}.search`),
    theme: parseTheme(value.theme, `${context}.theme`),
  };
}

export function parseSettingsPatch(value: unknown): CommandCabinSettingsPatch {
  const context = 'Invalid settings update request';

  if (!isRecord(value)) {
    throw new Error(`${context}: patch must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!settingsKeys.has(key)) {
      throw new Error(`${context} contains unknown setting "${key}".`);
    }
  }

  const patch: CommandCabinSettingsPatch = {};

  if ('hideOnBlur' in value) {
    patch.hideOnBlur = parseBoolean(value.hideOnBlur, `${context}.hideOnBlur`);
  }
  if ('hotkey' in value) {
    patch.hotkey = parseHotkeyAccelerator(value.hotkey, `${context}.hotkey`);
  }
  if ('screenshotHotkey' in value) {
    patch.screenshotHotkey = parseHotkeyAccelerator(
      value.screenshotHotkey,
      `${context}.screenshotHotkey`,
    );
  }
  if ('delayedScreenshotHotkey' in value) {
    patch.delayedScreenshotHotkey = parseHotkeyAccelerator(
      value.delayedScreenshotHotkey,
      `${context}.delayedScreenshotHotkey`,
    );
  }
  if ('language' in value) {
    patch.language = parseLanguage(value.language, `${context}.language`);
  }
  if ('launchAtLogin' in value) {
    patch.launchAtLogin = parseBoolean(value.launchAtLogin, `${context}.launchAtLogin`);
  }
  if ('preserveSearchQuery' in value) {
    patch.preserveSearchQuery = parseBoolean(
      value.preserveSearchQuery,
      `${context}.preserveSearchQuery`,
    );
  }
  if ('search' in value) {
    patch.search = parseSearchSettingsPatch(value.search, `${context}.search`);
  }
  if ('theme' in value) {
    patch.theme = parseTheme(value.theme, `${context}.theme`);
  }

  return patch;
}

export function parsePluginRecord(value: unknown): PluginRecord {
  const context = 'Invalid plugin record';

  if (!isRecord(value)) {
    throw new Error(`${context}: record must be an object.`);
  }

  const record = {
    enabled: parseBoolean(value.enabled, `${context}.enabled`),
    id: parseNonEmptyString(value.id, `${context}.id`),
    installedAt: parseIsoDateString(value.installedAt, `${context}.installedAt`),
    main: parseNonEmptyString(value.main, `${context}.main`),
    name: parseNonEmptyString(value.name, `${context}.name`),
    permissions: parseStringArray(value.permissions, `${context}.permissions`),
    updatedAt: parseIsoDateString(value.updatedAt, `${context}.updatedAt`),
    version: parseNonEmptyString(value.version, `${context}.version`),
  };
  const description =
    value.description === undefined
      ? undefined
      : parseString(value.description, `${context}.description`);
  const pluginRoot =
    value.pluginRoot === undefined
      ? undefined
      : parseNonEmptyString(value.pluginRoot, `${context}.pluginRoot`);
  const ui = value.ui === undefined ? undefined : parseString(value.ui, `${context}.ui`);

  return {
    ...record,
    ...(description === undefined ? {} : { description }),
    ...(pluginRoot === undefined ? {} : { pluginRoot }),
    ...(ui === undefined ? {} : { ui }),
  };
}

export function parsePluginRecords(value: unknown): PluginRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid plugin list response must be an array.');
  }

  return value.map(parsePluginRecord);
}

export function parseUpdatedPluginRecord(value: unknown): PluginRecord | undefined {
  return value === undefined ? undefined : parsePluginRecord(value);
}

export function parsePluginRemovalResult(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Invalid plugin removal response must be a boolean.');
  }

  return value;
}

export function parsePluginInstallRequest(value: unknown): PluginInstallRequest {
  return {
    pluginRoot: parseNonEmptyString(value, 'Plugin folder path'),
  };
}

export function parseDataDirectoryResponse(value: unknown): DataDirectoryResponse {
  if (!isRecord(value)) {
    throw new Error('Invalid data directory response must be an object.');
  }

  return {
    path: parseNonEmptyString(value.path, 'Data directory path'),
  };
}
