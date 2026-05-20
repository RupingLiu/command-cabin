import type {
  CommandCabinSettings,
  CommandCabinSettingsPatch,
  CommandCabinSettingsStore,
} from '@command-cabin/core';

export interface UpdateSettingsWithHotkeyRegistrationOptions {
  settingsPatch: CommandCabinSettingsPatch;
  settingsStore: CommandCabinSettingsStore;
  tryRegisterLauncherHotkey?: (hotkey: string) => boolean;
  tryRegisterScreenshotHotkey?: (hotkey: string) => boolean;
  tryRegisterHotkey?: (hotkey: string) => boolean;
}

export function updateSettingsWithHotkeyRegistration({
  settingsPatch,
  settingsStore,
  tryRegisterLauncherHotkey,
  tryRegisterScreenshotHotkey,
  tryRegisterHotkey,
}: UpdateSettingsWithHotkeyRegistrationOptions): CommandCabinSettings {
  const currentSettings = settingsStore.getSettings();
  const registerLauncherHotkey = tryRegisterLauncherHotkey ?? tryRegisterHotkey;
  const registerScreenshotHotkey = tryRegisterScreenshotHotkey ?? registerLauncherHotkey;

  if (settingsPatch.hotkey !== undefined && settingsPatch.hotkey !== currentSettings.hotkey) {
    const registered = registerLauncherHotkey?.(settingsPatch.hotkey) ?? false;

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
    const registered = registerScreenshotHotkey?.(settingsPatch.screenshotHotkey) ?? false;

    if (!registered) {
      throw new Error(
        `CommandCabin could not register ${settingsPatch.screenshotHotkey}. Another application or the operating system may already be using this shortcut.`,
      );
    }
  }

  return settingsStore.updateSettings(settingsPatch);
}
