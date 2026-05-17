import './App.css';

import { useEffect, useReducer, useState } from 'react';

import type { CommandCabinLanguage, CommandCabinTheme } from '@command-cabin/core';

import { DEFAULT_UI_LANGUAGE } from '../i18n.js';
import { LauncherPage } from '../launcher/LauncherPage.js';
import {
  PluginHost,
  type PluginHostEntry,
  type PluginHostFailure,
} from '../plugin-host/PluginHost.js';
import { SettingsPage } from '../settings/SettingsPage.js';
import { applyThemePreferenceToRoot } from '../settings/ThemeSettings.js';

export interface AppState {
  activePlugin: PluginHostEntry | undefined;
  lastPluginFailure: PluginHostFailure | undefined;
  view: 'launcher' | 'settings';
}

type AppAction =
  | {
      plugin: PluginHostEntry;
      type: 'open-plugin';
    }
  | {
      type: 'close-plugin';
    }
  | {
      failure: PluginHostFailure;
      type: 'plugin-failed';
    }
  | {
      type: 'open-settings';
    }
  | {
      type: 'open-launcher';
    };

export interface AppViewProps {
  language: CommandCabinLanguage;
  onClosePlugin: () => void;
  onLanguageUpdated: (language: CommandCabinLanguage) => void;
  onOpenPluginPage: (plugin: PluginHostEntry) => void;
  onOpenSettings: () => void;
  onPluginHostFailure: (failure: PluginHostFailure) => void;
  onReturnToLauncher: () => void;
  onThemeUpdated: (theme: CommandCabinTheme) => void;
  state: AppState;
  theme?: CommandCabinTheme | undefined;
}

export const initialAppState: AppState = {
  activePlugin: undefined,
  lastPluginFailure: undefined,
  view: 'launcher',
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'open-plugin':
      return {
        activePlugin: action.plugin,
        lastPluginFailure: undefined,
        view: 'launcher',
      };
    case 'close-plugin':
      return initialAppState;
    case 'plugin-failed':
      return {
        activePlugin: undefined,
        lastPluginFailure: action.failure,
        view: 'launcher',
      };
    case 'open-settings':
      return {
        activePlugin: undefined,
        lastPluginFailure: undefined,
        view: 'settings',
      };
    case 'open-launcher':
      return initialAppState;
  }
}

export function AppView({
  onClosePlugin,
  onOpenPluginPage,
  onOpenSettings,
  onLanguageUpdated,
  onPluginHostFailure,
  onReturnToLauncher,
  onThemeUpdated,
  language,
  state,
  theme,
}: AppViewProps) {
  if (state.activePlugin) {
    return (
      <PluginHost
        plugin={state.activePlugin}
        onClose={onClosePlugin}
        onFallbackToLauncher={onPluginHostFailure}
      />
    );
  }

  if (state.view === 'settings') {
    return (
      <SettingsPage
        language={language}
        theme={theme}
        onLanguageUpdated={onLanguageUpdated}
        onReturnToLauncher={onReturnToLauncher}
        onThemeUpdated={onThemeUpdated}
      />
    );
  }

  return (
    <LauncherPage
      language={language}
      onOpenPluginPage={onOpenPluginPage}
      onOpenSettings={onOpenSettings}
    />
  );
}

export function subscribeToOpenSettings(
  desktopApi: Window['desktopApi'] | undefined,
  listener: () => void,
): (() => void) | undefined {
  return desktopApi?.onOpenSettings(listener);
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [language, setLanguage] = useState<CommandCabinLanguage>(DEFAULT_UI_LANGUAGE);
  const [theme, setTheme] = useState<CommandCabinTheme | undefined>();

  useEffect(() => {
    const desktopApi =
      typeof window !== 'undefined' && 'desktopApi' in window ? window.desktopApi : undefined;

    void desktopApi
      ?.getSettings()
      .then((settings) => {
        setLanguage(settings.language);
        setTheme(settings.theme);
      })
      .catch(() => undefined);

    return subscribeToOpenSettings(desktopApi, () => {
      dispatch({
        type: 'open-settings',
      });
    });
  }, []);

  useEffect(() => {
    if (theme && typeof document !== 'undefined') {
      applyThemePreferenceToRoot(theme, document.documentElement);
    }
  }, [theme]);

  return (
    <AppView
      language={language}
      state={state}
      theme={theme}
      onLanguageUpdated={setLanguage}
      onThemeUpdated={setTheme}
      onOpenPluginPage={(plugin) =>
        dispatch({
          plugin,
          type: 'open-plugin',
        })
      }
      onOpenSettings={() =>
        dispatch({
          type: 'open-settings',
        })
      }
      onClosePlugin={() =>
        dispatch({
          type: 'close-plugin',
        })
      }
      onReturnToLauncher={() =>
        dispatch({
          type: 'open-launcher',
        })
      }
      onPluginHostFailure={(failure) => {
        console.error('Plugin page failed.', failure);
        dispatch({
          failure,
          type: 'plugin-failed',
        });
      }}
    />
  );
}
