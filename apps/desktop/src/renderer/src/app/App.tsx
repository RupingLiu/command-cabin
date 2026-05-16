import './App.css';

import { useReducer } from 'react';

import { LauncherPage } from '../launcher/LauncherPage.js';
import {
  PluginHost,
  type PluginHostEntry,
  type PluginHostFailure,
} from '../plugin-host/PluginHost.js';
import { ClipboardHistorySettings } from '../settings/ClipboardHistorySettings.js';

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

function SettingsView({ onReturnToLauncher }: { onReturnToLauncher: () => void }) {
  return (
    <main className="settings-shell">
      <section className="settings-frame" aria-label="CommandCabin settings">
        <header className="settings-titlebar">
          <div>
            <p className="launcher-kicker">Settings</p>
            <h1>CommandCabin</h1>
          </div>
          <button className="settings-back" type="button" onClick={onReturnToLauncher}>
            Back
          </button>
        </header>
        <ClipboardHistorySettings />
      </section>
    </main>
  );
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
    return <SettingsView onReturnToLauncher={onReturnToLauncher} />;
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
