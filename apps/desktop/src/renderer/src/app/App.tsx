import './App.css';

import { useReducer } from 'react';

import { LauncherPage } from '../launcher/LauncherPage.js';
import {
  PluginHost,
  type PluginHostEntry,
  type PluginHostFailure,
} from '../plugin-host/PluginHost.js';
import { SettingsPage } from '../settings/SettingsPage.js';

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
  onClosePlugin: () => void;
  onOpenPluginPage: (plugin: PluginHostEntry) => void;
  onOpenSettings: () => void;
  onPluginHostFailure: (failure: PluginHostFailure) => void;
  onReturnToLauncher: () => void;
  state: AppState;
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
  onPluginHostFailure,
  onReturnToLauncher,
  state,
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
    return <SettingsPage onReturnToLauncher={onReturnToLauncher} />;
  }

  return <LauncherPage onOpenPluginPage={onOpenPluginPage} onOpenSettings={onOpenSettings} />;
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialAppState);

  return (
    <AppView
      state={state}
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
