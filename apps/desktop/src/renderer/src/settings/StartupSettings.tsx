import type { CommandCabinSettings } from '@command-cabin/core';
import { getUiStrings, type UiStrings } from '../i18n.js';

export interface StartupSettingsProps {
  isSaving?: boolean;
  onLaunchAtLoginChange?: (enabled: boolean) => Promise<CommandCabinSettings | void> | void;
  strings?: UiStrings['settings']['startup'] | undefined;
  value?: boolean | undefined;
}

export function StartupSettings({
  isSaving = false,
  onLaunchAtLoginChange,
  strings = getUiStrings(undefined).settings.startup,
  value = false,
}: StartupSettingsProps) {
  return (
    <section className="settings-section startup-settings" aria-label={strings.ariaLabel}>
      <header className="settings-section__header">
        <h2>{strings.title}</h2>
        <span>{value ? strings.enabled : strings.disabled}</span>
      </header>
      <label className="settings-toggle">
        <input
          checked={value}
          disabled={isSaving}
          type="checkbox"
          onChange={(event) => void onLaunchAtLoginChange?.(event.currentTarget.checked)}
        />
        <span>{strings.launchAtLogin}</span>
      </label>
    </section>
  );
}
