import type { CommandCabinSettings } from '@command-cabin/core';

import { OPEN_SETTINGS_CHANNEL } from '../shared/ipcChannels.js';
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
type WindowLifecycleEvent = 'blur' | 'close' | 'closed';

export interface PreventableWindowCloseEvent {
  preventDefault: () => void;
}

export interface DesktopApplicationWindow extends Omit<
  LauncherWindow,
  'off' | 'on' | 'removeListener'
> {
  isDestroyed?: () => boolean;
  off?(eventName: 'blur', listener: () => void): unknown;
  off?(eventName: 'close', listener: (event: PreventableWindowCloseEvent) => void): unknown;
  off?(eventName: 'closed', listener: () => void): unknown;
  on(eventName: 'blur', listener: () => void): unknown;
  on(eventName: 'close', listener: (event: PreventableWindowCloseEvent) => void): unknown;
  on(eventName: 'closed', listener: () => void): unknown;
  removeListener?(eventName: 'blur', listener: () => void): unknown;
  removeListener?(
    eventName: 'close',
    listener: (event: PreventableWindowCloseEvent) => void,
  ): unknown;
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
  handleWindowClose: (event: PreventableWindowCloseEvent) => void;
  isQuitRequested: () => boolean;
  openSettings: () => Promise<void>;
  requestQuit: () => void;
  showLauncherWindow: () => Promise<void>;
  start: (options?: { showWindow?: boolean }) => Promise<void>;
  toggleLauncherWindow: () => Promise<void>;
  tryRegisterGlobalHotkey: (accelerator: string) => boolean;
}

interface LauncherState {
  handleClose: (event: PreventableWindowCloseEvent) => void;
  handleClosed: () => void;
  visibilityController: WindowVisibilityController;
  window: DesktopApplicationWindow;
}

function isLiveWindow(window: DesktopApplicationWindow): boolean {
  try {
    return window.isDestroyed?.() !== true;
  } catch {
    return false;
  }
}

function removeWindowListener(
  window: DesktopApplicationWindow,
  eventName: WindowLifecycleEvent,
  listener: (() => void) | ((event: PreventableWindowCloseEvent) => void),
): void {
  if (window.off) {
    if (eventName === 'blur') {
      window.off('blur', listener as () => void);
    } else if (eventName === 'close') {
      window.off('close', listener as (event: PreventableWindowCloseEvent) => void);
    } else {
      window.off('closed', listener as () => void);
    }
    return;
  }

  if (eventName === 'blur') {
    window.removeListener?.('blur', listener as () => void);
  } else if (eventName === 'close') {
    window.removeListener?.('close', listener as (event: PreventableWindowCloseEvent) => void);
  } else {
    window.removeListener?.('closed', listener as () => void);
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
  let quitRequested = false;

  const clearLauncherState = (
    state: LauncherState,
    options: { removeWindowListeners: boolean } = { removeWindowListeners: true },
  ) => {
    if (launcherState !== state) {
      return;
    }

    if (options.removeWindowListeners && isLiveWindow(state.window)) {
      state.visibilityController.dispose();
      removeWindowListener(state.window, 'close', state.handleClose);
      removeWindowListener(state.window, 'closed', state.handleClosed);
    }

    launcherState = undefined;
  };

  const setLauncherWindow = (window: DesktopApplicationWindow): LauncherState => {
    if (launcherState) {
      clearLauncherState(launcherState);
    }

    const nextState: LauncherState = {
      handleClose: (event) => {
        handleWindowClose(event);
      },
      handleClosed: () => {
        clearLauncherState(nextState, { removeWindowListeners: false });
      },
      visibilityController: createWindowVisibilityController({
        getSettings,
        window,
      }),
      window,
    };
    window.on('close', nextState.handleClose);
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

  const openSettings = async () => {
    const state = await ensureLauncherState();
    state.visibilityController.show();
    state.window.webContents.send(OPEN_SETTINGS_CHANNEL);
  };

  const handleWindowClose = (event: PreventableWindowCloseEvent) => {
    if (quitRequested) {
      return;
    }

    event.preventDefault();
    launcherState?.visibilityController.hide();
  };

  const registerHotkey = (): GlobalHotkeyRegistration => {
    if (hotkeyRegistration) {
      return hotkeyRegistration;
    }

    hotkeyRegistration = registerGlobalHotkey({
      accelerator: getSettings().hotkey,
      logger,
      notifyConflict: notifyHotkeyConflict,
      onTriggered: toggleLauncherWindow,
      registry: hotkeyRegistry,
    });
    return hotkeyRegistration;
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
      void showLauncherWindow();
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
    handleWindowClose,
    isQuitRequested: () => quitRequested,
    openSettings,
    requestQuit: () => {
      quitRequested = true;
    },
    showLauncherWindow,
    start: async () => {
      await ensureLauncherState();
      const registration = registerHotkey();

      if (registration.conflict) {
        await showLauncherWindow();
      }
    },
    toggleLauncherWindow,
    tryRegisterGlobalHotkey,
  };
}
