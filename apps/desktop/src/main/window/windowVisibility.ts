import { FOCUS_SEARCH_INPUT_CHANNEL } from '../../shared/ipcChannels.js';

export { FOCUS_SEARCH_INPUT_CHANNEL };

export interface LauncherWindowWebContents {
  send: (channel: string) => void;
}

export interface LauncherWindow {
  center: () => void;
  focus: () => void;
  hide: () => void;
  isVisible: () => boolean;
  on: (eventName: 'blur', listener: () => void) => unknown;
  off?: (eventName: 'blur', listener: () => void) => unknown;
  removeListener?: (eventName: 'blur', listener: () => void) => unknown;
  show: () => void;
  webContents: LauncherWindowWebContents;
}

export interface WindowVisibilitySettings {
  hideOnBlur: boolean;
}

export interface CreateWindowVisibilityControllerOptions {
  focusSearchInputChannel?: string;
  getSettings: () => WindowVisibilitySettings;
  window: LauncherWindow;
}

export interface WindowVisibilityController {
  dispose: () => void;
  hide: () => void;
  show: () => void;
  toggle: () => void;
}

function removeBlurListener(window: LauncherWindow, listener: () => void): void {
  if (window.off) {
    window.off('blur', listener);
    return;
  }

  window.removeListener?.('blur', listener);
}

export function createWindowVisibilityController({
  focusSearchInputChannel = FOCUS_SEARCH_INPUT_CHANNEL,
  getSettings,
  window,
}: CreateWindowVisibilityControllerOptions): WindowVisibilityController {
  const show = () => {
    window.center();
    window.show();
    window.focus();
    window.webContents.send(focusSearchInputChannel);
  };

  const hide = () => {
    window.hide();
  };

  const toggle = () => {
    if (window.isVisible()) {
      hide();
      return;
    }

    show();
  };

  const handleBlur = () => {
    if (getSettings().hideOnBlur && window.isVisible()) {
      hide();
    }
  };

  window.on('blur', handleBlur);

  return {
    dispose: () => {
      removeBlurListener(window, handleBlur);
    },
    hide,
    show,
    toggle,
  };
}
