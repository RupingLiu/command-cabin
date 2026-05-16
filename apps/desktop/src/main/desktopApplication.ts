import type { CommandCabinSettings } from '@command-cabin/core';

import {
  type GlobalHotkeyRegistration,
  type GlobalShortcutRegistry,
  type HotkeyConflictLogger,
  registerGlobalHotkey,
} from './hotkey/registerGlobalHotkey.js';
import {
  type LauncherWindow,
  type WindowVisibilityController,
  createWindowVisibilityController,
} from './window/windowVisibility.js';

type DesktopApplicationSettings = Pick<CommandCabinSettings, 'hideOnBlur' | 'hotkey'>;
type WindowLifecycleEvent = 'blur' | 'closed';

export interface DesktopApplicationWindow extends Omit<
  LauncherWindow,
  'off' | 'on' | 'removeListener'
> {
  isDestroyed?: () => boolean;
  off?(eventName: 'blur', listener: () => void): unknown;
  off?(eventName: 'closed', listener: () => void): unknown;
  on(eventName: 'blur', listener: () => void): unknown;
  on(eventName: 'closed', listener: () => void): unknown;
  removeListener?(eventName: 'blur', listener: () => void): unknown;
  removeListener?(eventName: 'closed', listener: () => void): unknown;
}

export interface CreateDesktopApplicationControllerOptions {
  createWindow: () => Promise<DesktopApplicationWindow>;
  getSettings: () => DesktopApplicationSettings;
  hotkeyRegistry: GlobalShortcutRegistry;
  logger?: HotkeyConflictLogger;
  notifyHotkeyConflict?: (message: string) => void;
}

export interface DesktopApplicationController {
  dispose: () => void;
  handleActivate: () => Promise<void>;
  start: () => Promise<void>;
  toggleLauncherWindow: () => Promise<void>;
  tryRegisterGlobalHotkey: (accelerator: string) => boolean;
}

interface LauncherState {
  handleClosed: () => void;
  visibilityController: WindowVisibilityController;
  window: DesktopApplicationWindow;
}

function isLiveWindow(window: DesktopApplicationWindow): boolean {
  return !window.isDestroyed?.();
}

function removeWindowListener(
  window: DesktopApplicationWindow,
  eventName: WindowLifecycleEvent,
  listener: () => void,
): void {
  if (window.off) {
    if (eventName === 'blur') {
      window.off('blur', listener);
    } else {
      window.off('closed', listener);
    }
    return;
  }

  if (eventName === 'blur') {
    window.removeListener?.('blur', listener);
  } else {
    window.removeListener?.('closed', listener);
  }
}

export function createDesktopApplicationController({
  createWindow,
  getSettings,
  hotkeyRegistry,
  logger = console,
  notifyHotkeyConflict,
}: CreateDesktopApplicationControllerOptions): DesktopApplicationController {
  let hotkeyRegistration: GlobalHotkeyRegistration | undefined;
  let launcherState: LauncherState | undefined;
  let pendingWindowCreation: Promise<LauncherState> | undefined;

  const clearLauncherState = (state: LauncherState) => {
    if (launcherState !== state) {
      return;
    }

    state.visibilityController.dispose();
    removeWindowListener(state.window, 'closed', state.handleClosed);
    launcherState = undefined;
  };

  const setLauncherWindow = (window: DesktopApplicationWindow): LauncherState => {
    if (launcherState) {
      clearLauncherState(launcherState);
    }

    const nextState: LauncherState = {
      handleClosed: () => {
        clearLauncherState(nextState);
      },
      visibilityController: createWindowVisibilityController({
        getSettings,
        window,
      }),
      window,
    };
    window.on('closed', nextState.handleClosed);
    launcherState = nextState;

    return nextState;
  };

  const ensureLauncherState = async (): Promise<LauncherState> => {
    if (launcherState && isLiveWindow(launcherState.window)) {
      return launcherState;
    }

    if (launcherState) {
      clearLauncherState(launcherState);
    }

    pendingWindowCreation ??= createWindow()
      .then(setLauncherWindow)
      .finally(() => {
        pendingWindowCreation = undefined;
      });

    return pendingWindowCreation;
  };

  const toggleLauncherWindow = async () => {
    const state = await ensureLauncherState();
    state.visibilityController.toggle();
  };

  const showLauncherWindow = async () => {
    const state = await ensureLauncherState();
    state.visibilityController.show();
  };

  const registerHotkey = () => {
    if (hotkeyRegistration) {
      return;
    }

    hotkeyRegistration = registerGlobalHotkey({
      accelerator: getSettings().hotkey,
      logger,
      notifyConflict: notifyHotkeyConflict,
      onTriggered: toggleLauncherWindow,
      registry: hotkeyRegistry,
    });
  };

  const tryRegisterGlobalHotkey = (accelerator: string): boolean => {
    if (hotkeyRegistration?.accelerator === accelerator && hotkeyRegistration.registered) {
      return true;
    }

    const nextRegistration = registerGlobalHotkey({
      accelerator,
      logger,
      notifyConflict: notifyHotkeyConflict,
      onTriggered: toggleLauncherWindow,
      registry: hotkeyRegistry,
    });

    if (!nextRegistration.registered) {
      return false;
    }

    hotkeyRegistration?.dispose();
    hotkeyRegistration = nextRegistration;
    return true;
  };

  return {
    dispose: () => {
      hotkeyRegistration?.dispose();
      hotkeyRegistration = undefined;

      if (launcherState) {
        clearLauncherState(launcherState);
      }

      pendingWindowCreation = undefined;
    },
    handleActivate: showLauncherWindow,
    start: async () => {
      await ensureLauncherState();
      registerHotkey();
    },
    toggleLauncherWindow,
    tryRegisterGlobalHotkey,
  };
}
