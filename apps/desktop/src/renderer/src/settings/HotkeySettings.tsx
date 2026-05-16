import { type KeyboardEvent, useState } from 'react';

import type { CommandCabinSettings } from '@command-cabin/core';

export interface HotkeyEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface HotkeySettingsProps {
  errorMessage?: string | undefined;
  isSaving?: boolean;
  onHotkeyChange?: (hotkey: string) => Promise<CommandCabinSettings | void> | void;
  value?: string | undefined;
}

export interface HotkeySettingsState {
  currentHotkey: string;
  errorMessage: string | undefined;
  isRecording: boolean;
  persistedHotkey: string;
}

const modifierKeys = new Set(['Alt', 'Control', 'Meta', 'Shift']);
const keyNames = new Map<string, string>([
  [' ', 'Space'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['ArrowUp', 'Up'],
  ['Escape', 'Esc'],
]);

function normalizeAcceleratorKey(key: string): string | undefined {
  if (key.trim().length === 0 && key !== ' ') {
    return undefined;
  }

  if (modifierKeys.has(key)) {
    return undefined;
  }

  if (keyNames.has(key)) {
    return keyNames.get(key);
  }

  if (key.length === 1) {
    return key.toUpperCase();
  }

  return key;
}

export function formatHotkeyFromKeyEvent(event: HotkeyEventLike): string | undefined {
  const key = normalizeAcceleratorKey(event.key);

  if (!key) {
    return undefined;
  }

  const modifiers = [
    event.ctrlKey ? 'Ctrl' : undefined,
    event.altKey ? 'Alt' : undefined,
    event.shiftKey ? 'Shift' : undefined,
    event.metaKey ? 'Meta' : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);

  if (modifiers.length === 0) {
    return undefined;
  }

  return [...modifiers, key].join('+');
}

function formatHotkeyError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Hotkey could not be saved.';
}

export function createHotkeySettingsState(persistedHotkey: string): HotkeySettingsState {
  return {
    currentHotkey: persistedHotkey,
    errorMessage: undefined,
    isRecording: false,
    persistedHotkey,
  };
}

export async function saveRecordedHotkey(
  state: HotkeySettingsState,
  hotkey: string,
  saveHotkey: (hotkey: string) => Promise<unknown>,
): Promise<HotkeySettingsState> {
  state.currentHotkey = hotkey;
  state.errorMessage = undefined;

  try {
    await saveHotkey(hotkey);
    state.persistedHotkey = hotkey;
    state.isRecording = false;
  } catch (error) {
    state.currentHotkey = state.persistedHotkey;
    state.errorMessage = formatHotkeyError(error);
    state.isRecording = true;
  }

  return { ...state };
}

export function HotkeySettings({
  errorMessage,
  isSaving = false,
  onHotkeyChange,
  value = 'Alt+Space',
}: HotkeySettingsProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [draftHotkey, setDraftHotkey] = useState<string | undefined>();
  const [localError, setLocalError] = useState<string | undefined>();
  const currentHotkey = draftHotkey ?? value;
  const displayedError = localError ?? errorMessage;

  async function saveHotkey(hotkey: string): Promise<void> {
    setLocalError(undefined);
    setDraftHotkey(hotkey);

    try {
      await onHotkeyChange?.(hotkey);
      setIsRecording(false);
    } catch (error) {
      setDraftHotkey(undefined);
      setIsRecording(true);
      setLocalError(formatHotkeyError(error));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!isRecording || isSaving) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const accelerator = formatHotkeyFromKeyEvent(event);

    if (!accelerator) {
      setLocalError('Press at least one modifier with a non-modifier key.');
      return;
    }

    void saveHotkey(accelerator);
  }

  return (
    <section className="settings-section hotkey-settings" aria-label="Hotkey settings">
      <header className="settings-section__header">
        <h2>Hotkey</h2>
        <span>{currentHotkey}</span>
      </header>
      {displayedError ? (
        <p className="settings-section__error" role="alert">
          {displayedError}
        </p>
      ) : null}
      <button
        aria-busy={isSaving}
        className="settings-record-button"
        disabled={isSaving}
        type="button"
        onClick={() => {
          setLocalError(undefined);
          setIsRecording(true);
        }}
        onKeyDown={handleKeyDown}
      >
        {isRecording ? 'Press shortcut' : 'Record shortcut'}
      </button>
    </section>
  );
}
