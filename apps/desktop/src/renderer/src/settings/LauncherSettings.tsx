import type { CommandCabinSettings } from '@command-cabin/core';
import { getUiStrings, type UiStrings } from '../i18n.js';

export interface LauncherSettingsProps {
  isSaving?: boolean;
  onPreserveSearchQueryChange?: (enabled: boolean) => Promise<CommandCabinSettings | void> | void;
  strings?: UiStrings['settings']['launcher'] | undefined;
  value?: boolean | undefined;
}

export function LauncherSettings({
  isSaving = false,
  onPreserveSearchQueryChange,
  strings = getUiStrings(undefined).settings.launcher,
  value = false,
}: LauncherSettingsProps) {
  return (
    <section className="settings-section launcher-settings" aria-label={strings.ariaLabel}>
      <header className="settings-section__header">
        <h2>{strings.title}</h2>
        <span>{value ? strings.enabled : strings.disabled}</span>
      </header>
      <label className="settings-toggle">
        <input
          checked={value}
          disabled={isSaving}
          type="checkbox"
          onChange={(event) => void onPreserveSearchQueryChange?.(event.currentTarget.checked)}
        />
        <span>{strings.preserveSearchQuery}</span>
      </label>
    </section>
  );
}
