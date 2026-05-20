import type { CommandCabinSettings } from '@command-cabin/core';

import {
  type GlobalHotkeyRegistration,
  type GlobalShortcutRegistry,
  type HotkeyConflictLogger,
  registerGlobalHotkey,
} from '../hotkey/registerGlobalHotkey.js';
import type { ScreenshotLaunchMode } from '../../shared/screenshotApi.js';

export type ScreenshotHotkeyRegistrationField = 'screenshotHotkey' | 'delayedScreenshotHotkey';

export interface ScreenshotShortcutController {
  dispose: () => void;
  start: () => Promise<void>;
  tryRegisterGlobalHotkey: (
    field: ScreenshotHotkeyRegistrationField,
    accelerator: string,
  ) => boolean;
}

export interface CreateScreenshotShortcutControllerOptions {
  getAccelerators: () => Pick<
    CommandCabinSettings,
    'screenshotHotkey' | 'delayedScreenshotHotkey'
  >;
  logger?: HotkeyConflictLogger;
  notifyHotkeyConflict?: (message: string) => void;
  registry: GlobalShortcutRegistry;
  startScreenshotCapture: (mode: ScreenshotLaunchMode) => Promise<void> | void;
}

export function createScreenshotShortcutController({
  getAccelerators,
  logger = console,
  notifyHotkeyConflict,
  registry,
  startScreenshotCapture,
}: CreateScreenshotShortcutControllerOptions): ScreenshotShortcutController {
  const hotkeyRegistrations = new Map<ScreenshotHotkeyRegistrationField, GlobalHotkeyRegistration>();
  const modeByField = new Map<ScreenshotHotkeyRegistrationField, ScreenshotLaunchMode>([
    ['screenshotHotkey', 'capture'],
    ['delayedScreenshotHotkey', 'capture-delay-3'],
  ]);

  const register = (
    field: ScreenshotHotkeyRegistrationField,
    accelerator: string,
  ): GlobalHotkeyRegistration =>
    registerGlobalHotkey({
      accelerator,
      logger,
      notifyConflict: notifyHotkeyConflict,
      onTriggered: () => startScreenshotCapture(modeByField.get(field)!),
      registry,
    });

  const findRegisteredField = (
    accelerator: string,
  ): ScreenshotHotkeyRegistrationField | undefined => {
    for (const [registeredField, hotkeyRegistration] of hotkeyRegistrations) {
      if (hotkeyRegistration.registered && hotkeyRegistration.accelerator === accelerator) {
        return registeredField;
      }
    }

    return undefined;
  };

  const tryRegisterGlobalHotkey = (
    field: ScreenshotHotkeyRegistrationField,
    accelerator: string,
  ): boolean => {
    const hotkeyRegistration = hotkeyRegistrations.get(field);

    if (hotkeyRegistration?.accelerator === accelerator && hotkeyRegistration.registered) {
      return true;
    }

    const displacedField = findRegisteredField(accelerator);
    const displacedRegistration =
      displacedField === undefined ? undefined : hotkeyRegistrations.get(displacedField);

    if (displacedField !== undefined) {
      displacedRegistration?.dispose();
      hotkeyRegistrations.delete(displacedField);
    }

    const nextRegistration = register(field, accelerator);

    if (!nextRegistration.registered) {
      if (displacedField !== undefined && displacedRegistration !== undefined) {
        hotkeyRegistrations.set(
          displacedField,
          register(displacedField, displacedRegistration.accelerator),
        );
      }

      return false;
    }

    hotkeyRegistration?.dispose();
    hotkeyRegistrations.set(field, nextRegistration);
    return true;
  };

  return {
    dispose: () => {
      for (const hotkeyRegistration of hotkeyRegistrations.values()) {
        hotkeyRegistration.dispose();
      }
      hotkeyRegistrations.clear();
    },
    start: async () => {
      const accelerators = getAccelerators();

      for (const field of modeByField.keys()) {
        if (!hotkeyRegistrations.has(field)) {
          hotkeyRegistrations.set(field, register(field, accelerators[field]));
        }
      }
    },
    tryRegisterGlobalHotkey,
  };
}
