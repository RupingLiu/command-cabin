import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_COMMAND_CABIN_SETTINGS,
  type CommandCabinLanguage,
  type CommandCabinSettings,
  type CommandCabinSettingsPatch,
  type CommandCabinTheme,
} from '@command-cabin/core';

import { getUiStrings } from '../i18n.js';
import { AboutSettings } from './AboutSettings.js';
import { ClipboardHistorySettings } from './ClipboardHistorySettings.js';
import { DataSettings } from './DataSettings.js';
import { FavoritesSettings } from './FavoritesSettings.js';
import { HotkeySettings } from './HotkeySettings.js';
import { LanguageSettings } from './LanguageSettings.js';
import { LauncherSettings } from './LauncherSettings.js';
import { PluginSettings } from './PluginSettings.js';
import { StartupSettings } from './StartupSettings.js';
import { ThemeSettings } from './ThemeSettings.js';

export interface SettingsPageApi {
  getAppInfo?: Window['desktopApi']['getAppInfo'] | undefined;
  getSettings: () => Promise<CommandCabinSettings>;
  updateSettings: (patch: CommandCabinSettingsPatch) => Promise<CommandCabinSettings>;
}

export interface SettingsPageProps {
  api?: SettingsPageApi;
  language?: CommandCabinLanguage | undefined;
  onLanguageUpdated?: (language: CommandCabinLanguage) => void;
  onReturnToLauncher: () => void;
  onThemeUpdated?: (theme: CommandCabinTheme) => void;
  theme?: CommandCabinTheme | undefined;
}

export type SettingsHotkeyRecorderId = 'launcher' | 'screenshot';

export function createSettingsHotkeyPatch(
  recorderId: SettingsHotkeyRecorderId,
  hotkey: string,
): CommandCabinSettingsPatch {
  return recorderId === 'launcher' ? { hotkey } : { screenshotHotkey: hotkey };
}

export function startSettingsHotkeyRecorder(
  recorderId: SettingsHotkeyRecorderId,
): SettingsHotkeyRecorderId {
  return recorderId;
}

export function isSettingsHotkeyRecorderActive(
  activeRecorderId: SettingsHotkeyRecorderId | undefined,
  recorderId: SettingsHotkeyRecorderId,
): boolean {
  return activeRecorderId === recorderId;
}

function getDefaultSettingsPageApi(): SettingsPageApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.desktopApi;
}

export function SettingsPage({
  api,
  language,
  onLanguageUpdated,
  onReturnToLauncher,
  onThemeUpdated,
  theme,
}: SettingsPageProps) {
  const settingsApi = useMemo(() => api ?? getDefaultSettingsPageApi(), [api]);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<CommandCabinSettings | undefined>();
  const [activeHotkeyRecorder, setActiveHotkeyRecorder] = useState<
    SettingsHotkeyRecorderId | undefined
  >();
  const currentLanguage = settings?.language ?? language;
  const currentTheme = settings?.theme ?? theme;
  const strings = getUiStrings(currentLanguage);
  const appInfo = settingsApi?.getAppInfo?.() ?? {
    name: 'CommandCabin',
    version: '0.0.0',
    versions: {
      chrome: '',
      electron: '',
      node: '',
    },
  };

  useEffect(() => {
    if (!settingsApi) {
      return;
    }

    let isCurrent = true;

    settingsApi
      .getSettings()
      .then((loadedSettings) => {
        if (isCurrent) {
          setSettings(loadedSettings);
          onLanguageUpdated?.(loadedSettings.language);
          onThemeUpdated?.(loadedSettings.theme);
        }
      })
      .catch((error: unknown) => {
        if (isCurrent) {
          setErrorMessage(error instanceof Error ? error.message : strings.settings.loadError);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [onLanguageUpdated, onThemeUpdated, settingsApi, strings.settings.loadError]);

  const updateSettings = useCallback(
    async (patch: CommandCabinSettingsPatch) => {
      if (!settingsApi) {
        throw new Error('Settings API unavailable.');
      }

      setIsSaving(true);
      setErrorMessage(undefined);

      try {
        const updatedSettings = await settingsApi.updateSettings(patch);
        setSettings(updatedSettings);
        onLanguageUpdated?.(updatedSettings.language);
        onThemeUpdated?.(updatedSettings.theme);
        return updatedSettings;
      } catch (error) {
        const message = error instanceof Error ? error.message : strings.settings.saveError;
        setErrorMessage(message);
        throw new Error(message, { cause: error });
      } finally {
        setIsSaving(false);
      }
    },
    [onLanguageUpdated, onThemeUpdated, settingsApi, strings.settings.saveError],
  );

  const stopHotkeyRecording = useCallback((recorderId: SettingsHotkeyRecorderId) => {
    setActiveHotkeyRecorder((currentRecorderId) =>
      currentRecorderId === recorderId ? undefined : currentRecorderId,
    );
  }, []);

  return (
    <main className="settings-shell">
      <section className="settings-frame" aria-label={strings.settings.ariaLabel}>
        <header className="settings-titlebar">
          <div>
            <p className="launcher-kicker">{strings.settings.title}</p>
            <h1>CommandCabin</h1>
          </div>
          <button className="settings-back" type="button" onClick={onReturnToLauncher}>
            {strings.settings.back}
          </button>
        </header>

        {errorMessage ? (
          <p className="settings-section__error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <div className="settings-grid">
          <AboutSettings appInfo={appInfo} strings={strings.settings.about} />
          <HotkeySettings
            activeRecorderId={activeHotkeyRecorder ?? null}
            errorMessage={settingsApi ? undefined : strings.settings.settingsUnavailable}
            isSaving={isSaving}
            recorderId="launcher"
            strings={strings.settings.hotkey}
            value={settings?.hotkey ?? DEFAULT_COMMAND_CABIN_SETTINGS.hotkey}
            onHotkeyChange={(hotkey) =>
              updateSettings(createSettingsHotkeyPatch('launcher', hotkey))
            }
            onRecordingStart={() =>
              setActiveHotkeyRecorder(startSettingsHotkeyRecorder('launcher'))
            }
            onRecordingStop={() => stopHotkeyRecording('launcher')}
          />
          <HotkeySettings
            activeRecorderId={activeHotkeyRecorder ?? null}
            errorMessage={settingsApi ? undefined : strings.settings.settingsUnavailable}
            isSaving={isSaving}
            recorderId="screenshot"
            strings={strings.settings.screenshotHotkey}
            value={settings?.screenshotHotkey ?? DEFAULT_COMMAND_CABIN_SETTINGS.screenshotHotkey}
            onHotkeyChange={(hotkey) =>
              updateSettings(createSettingsHotkeyPatch('screenshot', hotkey))
            }
            onRecordingStart={() =>
              setActiveHotkeyRecorder(startSettingsHotkeyRecorder('screenshot'))
            }
            onRecordingStop={() => stopHotkeyRecording('screenshot')}
          />
          <ThemeSettings
            isSaving={isSaving}
            strings={strings.settings.theme}
            value={currentTheme}
            onThemeChange={(theme: CommandCabinTheme) => updateSettings({ theme })}
          />
          <LanguageSettings
            isSaving={isSaving}
            strings={strings.settings.language}
            value={currentLanguage}
            onLanguageChange={(language: CommandCabinLanguage) => updateSettings({ language })}
          />
          <LauncherSettings
            isSaving={isSaving}
            strings={strings.settings.launcher}
            value={settings?.preserveSearchQuery}
            onPreserveSearchQueryChange={(preserveSearchQuery) =>
              updateSettings({ preserveSearchQuery })
            }
          />
          <StartupSettings
            isSaving={isSaving}
            strings={strings.settings.startup}
            value={settings?.launchAtLogin}
            onLaunchAtLoginChange={(launchAtLogin) => updateSettings({ launchAtLogin })}
          />
          <PluginSettings strings={strings.settings.plugin} />
          <DataSettings strings={strings.settings.data} />
          <FavoritesSettings commonStrings={strings.common} strings={strings.settings.favorites} />
          <ClipboardHistorySettings strings={strings.settings.clipboardHistory} />
        </div>
      </section>
    </main>
  );
}
