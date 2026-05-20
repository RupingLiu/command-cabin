import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import type { CommandCabinSettings } from '@command-cabin/core';
import type { HotkeyInputCapturePayload } from '../../../shared/hotkeyInputApi.js';
import { getUiStrings, type UiStrings } from '../i18n.js';

export interface HotkeyEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export type HotkeySettingsStrings = UiStrings['settings']['hotkey'];

export interface HotkeySettingsProps {
  activeRecorderId?: string | null | undefined;
  errorMessage?: string | undefined;
  isSaving?: boolean;
  onHotkeyChange?: (hotkey: string) => Promise<CommandCabinSettings | void> | void;
  onRecordingStart?: (recorderId: string) => void;
  onRecordingStop?: (recorderId: string) => void;
  recorderId?: string | undefined;
  strings?: HotkeySettingsStrings | undefined;
  value?: string | undefined;
}

export interface HotkeySettingsState {
  currentHotkey: string;
  errorMessage: string | undefined;
  isRecording: boolean;
  persistedHotkey: string;
}

export interface HotkeyRecorderActivity {
  activeRecorderId?: string | null | undefined;
  localIsRecording: boolean;
  recorderId?: string | undefined;
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

export function isModifierOnlyHotkeyEvent(event: HotkeyEventLike): boolean {
  return modifierKeys.has(event.key);
}

export function isHotkeyRecorderActive({
  activeRecorderId,
  localIsRecording,
  recorderId,
}: HotkeyRecorderActivity): boolean {
  return activeRecorderId !== undefined && recorderId !== undefined
    ? activeRecorderId === recorderId
    : localIsRecording;
}

function formatHotkeyError(
  error: unknown,
  fallbackMessage = getUiStrings(undefined).settings.hotkey.saveError,
): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallbackMessage;
}

function getDesktopApi():
  | Pick<
      Window['desktopApi'],
      'onHotkeyInputCapture' | 'startHotkeyInputCapture' | 'stopHotkeyInputCapture'
    >
  | undefined {
  return typeof window !== 'undefined' && 'desktopApi' in window ? window.desktopApi : undefined;
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
  activeRecorderId,
  errorMessage,
  isSaving = false,
  onHotkeyChange,
  onRecordingStart,
  onRecordingStop,
  recorderId,
  strings = getUiStrings(undefined).settings.hotkey,
  value = 'Alt+Space',
}: HotkeySettingsProps) {
  const [localIsRecording, setLocalIsRecording] = useState(false);
  const [draftHotkey, setDraftHotkey] = useState<string | undefined>();
  const [localError, setLocalError] = useState<string | undefined>();
  const isRecording = isHotkeyRecorderActive({
    activeRecorderId,
    localIsRecording,
    recorderId,
  });
  const recordingStateRef = useRef({ isRecording, isSaving });
  const currentHotkey = draftHotkey ?? value;
  const displayedError = localError ?? errorMessage;
  recordingStateRef.current = { isRecording, isSaving };

  function startHotkeyInputCapture(): void {
    void getDesktopApi()
      ?.startHotkeyInputCapture()
      .catch(() => undefined);
  }

  function stopHotkeyInputCapture(): void {
    void getDesktopApi()
      ?.stopHotkeyInputCapture()
      .catch(() => undefined);
  }

  useEffect(() => () => stopHotkeyInputCapture(), []);

  function startRecording(): void {
    if (recorderId !== undefined) {
      onRecordingStart?.(recorderId);
    }

    setLocalIsRecording(true);
    startHotkeyInputCapture();
  }

  function stopRecording(): void {
    if (recorderId !== undefined) {
      onRecordingStop?.(recorderId);
    }

    setLocalIsRecording(false);
  }

  async function saveHotkey(hotkey: string): Promise<void> {
    setLocalError(undefined);
    setDraftHotkey(hotkey);

    try {
      await onHotkeyChange?.(hotkey);
      stopHotkeyInputCapture();
      stopRecording();
    } catch (error) {
      setDraftHotkey(undefined);
      startRecording();
      setLocalError(formatHotkeyError(error, strings.saveError));
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
      if (isModifierOnlyHotkeyEvent(event)) {
        setLocalError(undefined);
        return;
      }

      setLocalError(strings.conflictHint);
      return;
    }

    void saveHotkey(accelerator);
  }

  function handleCapturedHotkeyInput(event: HotkeyInputCapturePayload): void {
    if (!recordingStateRef.current.isRecording || recordingStateRef.current.isSaving) {
      return;
    }

    const accelerator = formatHotkeyFromKeyEvent(event);

    if (!accelerator) {
      return;
    }

    void saveHotkey(accelerator);
  }

  useEffect(() => {
    const desktopApi = getDesktopApi();

    return desktopApi?.onHotkeyInputCapture(handleCapturedHotkeyInput);
  });

  return (
    <section className="settings-section hotkey-settings" aria-label={strings.ariaLabel}>
      <header className="settings-section__header">
        <h2>{strings.title}</h2>
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
          startRecording();
        }}
        onKeyDown={handleKeyDown}
      >
        {isRecording ? strings.waiting : strings.record}
      </button>
    </section>
  );
}
