import './App.css';

import { useReducer } from 'react';

import { LauncherPage } from '../launcher/LauncherPage.js';
import {
  PluginHost,
  type PluginHostEntry,
  type PluginHostFailure,
} from '../plugin-host/PluginHost.js';

export interface AppState {
  activePlugin: PluginHostEntry | undefined;
  lastPluginFailure: PluginHostFailure | undefined;
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
    };

export interface AppViewProps {
  onClosePlugin: () => void;
  onOpenPluginPage: (plugin: PluginHostEntry) => void;
  onPluginHostFailure: (failure: PluginHostFailure) => void;
  state: AppState;
}

export const initialAppState: AppState = {
  activePlugin: undefined,
  lastPluginFailure: undefined,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'open-plugin':
      return {
        activePlugin: action.plugin,
        lastPluginFailure: undefined,
      };
    case 'close-plugin':
      return initialAppState;
    case 'plugin-failed':
      return {
        activePlugin: undefined,
        lastPluginFailure: action.failure,
      };
  }
}

export function AppView({
  onClosePlugin,
  onOpenPluginPage,
  onPluginHostFailure,
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

  return <LauncherPage onOpenPluginPage={onOpenPluginPage} />;
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
      onClosePlugin={() =>
        dispatch({
          type: 'close-plugin',
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
