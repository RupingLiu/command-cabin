import type { CommandCabinLanguage, CommandCabinSettings } from '@command-cabin/core';
import { getUiStrings, type UiStrings } from '../i18n.js';

export interface LanguageSettingsProps {
  isSaving?: boolean;
  onLanguageChange?: (
    language: CommandCabinLanguage,
  ) => Promise<CommandCabinSettings | void> | void;
  strings?: UiStrings['settings']['language'] | undefined;
  value?: CommandCabinLanguage | undefined;
}

const languageOptions: readonly CommandCabinLanguage[] = ['zh-CN', 'zh-TW', 'en-US'];
const languageLabels = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'en-US': 'English',
} satisfies Record<CommandCabinLanguage, string>;

export function getLanguageLabel(language: CommandCabinLanguage): string {
  return languageLabels[language];
}

export function LanguageSettings({
  isSaving = false,
  onLanguageChange,
  strings = getUiStrings(undefined).settings.language,
  value = 'zh-CN',
}: LanguageSettingsProps) {
  return (
    <section className="settings-section language-settings" aria-label={strings.ariaLabel}>
      <header className="settings-section__header">
        <h2>{strings.title}</h2>
        <span>{getLanguageLabel(value)}</span>
      </header>
      <fieldset className="settings-segmented-control" disabled={isSaving}>
        <legend>{strings.displayLanguage}</legend>
        {languageOptions.map((language) => (
          <label key={language} data-selected={value === language}>
            <input
              checked={value === language}
              name="language"
              type="radio"
              value={language}
              onChange={() => void onLanguageChange?.(language)}
            />
            <span>{getLanguageLabel(language)}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
