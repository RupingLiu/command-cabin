import { useEffect } from 'react';

import type { CommandCabinSettings, CommandCabinTheme } from '@command-cabin/core';

export interface ThemeRoot {
  removeAttribute: (name: string) => unknown;
  setAttribute: (name: string, value: string) => unknown;
}

export interface ThemeSettingsProps {
  errorMessage?: string | undefined;
  isSaving?: boolean;
  onThemeChange?: (theme: CommandCabinTheme) => Promise<CommandCabinSettings | void> | void;
  value?: CommandCabinTheme | undefined;
}

const themeOptions: readonly CommandCabinTheme[] = ['system', 'dark', 'light'];

function prefersLightTheme(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  );
}

export function resolveThemePreference(
  theme: CommandCabinTheme,
  prefersLight: () => boolean = prefersLightTheme,
): 'dark' | 'light' {
  if (theme === 'system') {
    return prefersLight() ? 'light' : 'dark';
  }

  return theme;
}

export function applyThemeToRoot(theme: CommandCabinTheme, root: ThemeRoot): void {
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    return;
  }

  root.setAttribute('data-theme', theme);
}

export function applyThemePreferenceToRoot(
  theme: CommandCabinTheme,
  root: ThemeRoot,
  prefersLight?: () => boolean,
): void {
  root.setAttribute('data-theme', resolveThemePreference(theme, prefersLight));
}

export function ThemeSettings({
  errorMessage,
  isSaving = false,
  onThemeChange,
  value = 'system',
}: ThemeSettingsProps) {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      applyThemePreferenceToRoot(value, document.documentElement);
    }
  }, [value]);

  return (
    <section className="settings-section theme-settings" aria-label="Theme settings">
      <header className="settings-section__header">
        <h2>Theme</h2>
        <span>{value}</span>
      </header>
      {errorMessage ? (
        <p className="settings-section__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <fieldset className="settings-segmented-control" disabled={isSaving}>
        <legend>Theme mode</legend>
        {themeOptions.map((theme) => (
          <label key={theme} data-selected={value === theme}>
            <input
              checked={value === theme}
              name="theme"
              type="radio"
              value={theme}
              onChange={() => void onThemeChange?.(theme)}
            />
            <span>{theme}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
