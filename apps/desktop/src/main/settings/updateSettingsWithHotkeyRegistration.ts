import type {
  CommandCabinSettings,
  CommandCabinSettingsPatch,
  CommandCabinSettingsStore,
} from '@command-cabin/core';

export interface UpdateSettingsWithHotkeyRegistrationOptions {
  settingsPatch: CommandCabinSettingsPatch;
  settingsStore: CommandCabinSettingsStore;
  tryRegisterLauncherHotkey: (hotkey: string) => boolean;
  tryRegisterScreenshotHotkey: (hotkey: string) => boolean;
}

export function updateSettingsWithHotkeyRegistration({
  settingsPatch,
  settingsStore,
  tryRegisterLauncherHotkey,
  tryRegisterScreenshotHotkey,
}: UpdateSettingsWithHotkeyRegistrationOptions): CommandCabinSettings {
  const currentSettings = settingsStore.getSettings();

  if (settingsPatch.hotkey !== undefined && settingsPatch.hotkey !== currentSettings.hotkey) {
    const registered = tryRegisterLauncherHotkey(settingsPatch.hotkey);

    if (!registered) {
      throw new Error(
        `CommandCabin could not register ${settingsPatch.hotkey}. Another application or the operating system may already be using this shortcut.`,
      );
    }
  }

  if (
    settingsPatch.screenshotHotkey !== undefined &&
    settingsPatch.screenshotHotkey !== currentSettings.screenshotHotkey
  ) {
    const registered = tryRegisterScreenshotHotkey(settingsPatch.screenshotHotkey);

    if (!registered) {
      throw new Error(
        `CommandCabin could not register ${settingsPatch.screenshotHotkey}. Another application or the operating system may already be using this shortcut.`,
      );
    }
  }

  return settingsStore.updateSettings(settingsPatch);
}
