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

type HotkeyRegistrar = (hotkey: string) => boolean;
type RollbackAction = () => void;
type HotkeyRegistrationField = 'hotkey' | 'screenshotHotkey';

function rollbackRegistrations(rollbackActions: RollbackAction[]): void {
  for (const rollbackAction of rollbackActions.slice().reverse()) {
    rollbackAction();
  }
}

function registerChangedHotkey(
  nextHotkey: string | undefined,
  currentHotkey: string,
  registerHotkey: HotkeyRegistrar,
  rollbackActions: RollbackAction[],
): void {
  if (nextHotkey === undefined || nextHotkey === currentHotkey) {
    return;
  }

  const registered = registerHotkey(nextHotkey);

  if (!registered) {
    throw new Error(
      `CommandCabin could not register ${nextHotkey}. Another application or the operating system may already be using this shortcut.`,
    );
  }

  rollbackActions.push(() => {
    registerHotkey(currentHotkey);
  });
}

export function updateSettingsWithHotkeyRegistration({
  settingsPatch,
  settingsStore,
  tryRegisterLauncherHotkey,
  tryRegisterScreenshotHotkey,
}: UpdateSettingsWithHotkeyRegistrationOptions): CommandCabinSettings {
  const currentSettings = settingsStore.getSettings();
  const rollbackActions: RollbackAction[] = [];
  const registrationFields = Object.keys(settingsPatch).filter(
    (field): field is HotkeyRegistrationField => field === 'hotkey' || field === 'screenshotHotkey',
  );

  try {
    for (const field of registrationFields) {
      if (field === 'hotkey') {
        registerChangedHotkey(
          settingsPatch.hotkey,
          currentSettings.hotkey,
          tryRegisterLauncherHotkey,
          rollbackActions,
        );
      } else {
        registerChangedHotkey(
          settingsPatch.screenshotHotkey,
          currentSettings.screenshotHotkey,
          tryRegisterScreenshotHotkey,
          rollbackActions,
        );
      }
    }

    return settingsStore.updateSettings(settingsPatch);
  } catch (error) {
    rollbackRegistrations(rollbackActions);
    throw error;
  }
}
