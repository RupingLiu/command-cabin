import type { CommandCabinSettings } from '@command-cabin/core';

import {
  type GlobalHotkeyRegistration,
  type GlobalShortcutRegistry,
  type HotkeyConflictLogger,
  registerGlobalHotkey,
} from '../hotkey/registerGlobalHotkey.js';
import type { ScreenshotLaunchMode } from '../../shared/screenshotApi.js';

export interface ScreenshotShortcutController {
  dispose: () => void;
  start: () => Promise<void>;
  tryRegisterGlobalHotkey: (accelerator: string) => boolean;
}

export interface CreateScreenshotShortcutControllerOptions {
  getAccelerator: () => Pick<CommandCabinSettings, 'screenshotHotkey'>['screenshotHotkey'];
  logger?: HotkeyConflictLogger;
  notifyHotkeyConflict?: (message: string) => void;
  registry: GlobalShortcutRegistry;
  startScreenshotCapture: (mode: ScreenshotLaunchMode) => Promise<void> | void;
}

export function createScreenshotShortcutController({
  getAccelerator,
  logger = console,
  notifyHotkeyConflict,
  registry,
  startScreenshotCapture,
}: CreateScreenshotShortcutControllerOptions): ScreenshotShortcutController {
  let hotkeyRegistration: GlobalHotkeyRegistration | undefined;

  const register = (accelerator: string): GlobalHotkeyRegistration =>
    registerGlobalHotkey({
      accelerator,
      logger,
      notifyConflict: notifyHotkeyConflict,
      onTriggered: () => startScreenshotCapture('capture'),
      registry,
    });

  const tryRegisterGlobalHotkey = (accelerator: string): boolean => {
    if (hotkeyRegistration?.accelerator === accelerator && hotkeyRegistration.registered) {
      return true;
    }

    const nextRegistration = register(accelerator);

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
    },
    start: async () => {
      if (!hotkeyRegistration) {
        hotkeyRegistration = register(getAccelerator());
      }
    },
    tryRegisterGlobalHotkey,
  };
}
