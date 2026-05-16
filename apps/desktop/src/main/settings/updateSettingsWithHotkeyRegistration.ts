import type {
  CommandCabinSettings,
  CommandCabinSettingsPatch,
  CommandCabinSettingsStore,
} from '@command-cabin/core';

export interface UpdateSettingsWithHotkeyRegistrationOptions {
  settingsPatch: CommandCabinSettingsPatch;
  settingsStore: CommandCabinSettingsStore;
  tryRegisterHotkey: (hotkey: string) => boolean;
}

export function updateSettingsWithHotkeyRegistration({
  settingsPatch,
  settingsStore,
  tryRegisterHotkey,
}: UpdateSettingsWithHotkeyRegistrationOptions): CommandCabinSettings {
  const currentSettings = settingsStore.getSettings();

  if (settingsPatch.hotkey !== undefined && settingsPatch.hotkey !== currentSettings.hotkey) {
    const registered = tryRegisterHotkey(settingsPatch.hotkey);

    if (!registered) {
      throw new Error(
        `CommandCabin could not register ${settingsPatch.hotkey}. Another application or the operating system may already be using this shortcut.`,
      );
    }
  }

  return settingsStore.updateSettings(settingsPatch);
}
