export const DEFAULT_GLOBAL_HOTKEY = 'Alt+Space';

export type GlobalHotkeyTrigger = () => Promise<void> | void;

export interface GlobalShortcutRegistry {
  register: (accelerator: string, callback: GlobalHotkeyTrigger) => boolean;
  unregister: (accelerator: string) => void;
}

export interface HotkeyConflictLogger {
  warn: (message: string) => void;
}

export interface RegisterGlobalHotkeyOptions {
  accelerator?: string;
  logger?: HotkeyConflictLogger;
  notifyConflict?: ((message: string) => void) | undefined;
  onTriggered: GlobalHotkeyTrigger;
  registry: GlobalShortcutRegistry;
}

export interface GlobalHotkeyRegistration {
  accelerator: string;
  conflict: boolean;
  dispose: () => void;
  registered: boolean;
}

export function registerGlobalHotkey({
  accelerator = DEFAULT_GLOBAL_HOTKEY,
  logger = console,
  notifyConflict,
  onTriggered,
  registry,
}: RegisterGlobalHotkeyOptions): GlobalHotkeyRegistration {
  const registered = registry.register(accelerator, onTriggered);

  if (!registered) {
    logger.warn(`CommandCabin global hotkey conflict: failed to register ${accelerator}.`);
    notifyConflict?.(
      `CommandCabin could not register ${accelerator}. Another application or the operating system may already be using this shortcut.`,
    );
  }

  return {
    accelerator,
    conflict: !registered,
    registered,
    dispose: () => {
      if (registered) {
        registry.unregister(accelerator);
      }
    },
  };
}
