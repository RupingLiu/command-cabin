import { parseBoolean, parseString } from './parsers.js';

export interface HotkeyInputCapturePayload {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

// Kept private (instead of the strict shared `isRecord`) to preserve the
// existing behavior of accepting any object-like value without a plain-object
// prototype check.
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseHotkeyInputCapturePayload(value: unknown): HotkeyInputCapturePayload {
  if (!isRecord(value)) {
    throw new Error('Hotkey input capture payload must be an object.');
  }

  return {
    altKey: parseBoolean(value.altKey, 'Hotkey input altKey'),
    ctrlKey: parseBoolean(value.ctrlKey, 'Hotkey input ctrlKey'),
    key: parseString(value.key, 'Hotkey input key'),
    metaKey: parseBoolean(value.metaKey, 'Hotkey input metaKey'),
    shiftKey: parseBoolean(value.shiftKey, 'Hotkey input shiftKey'),
  };
}
