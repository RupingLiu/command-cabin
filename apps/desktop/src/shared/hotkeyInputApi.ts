export interface HotkeyInputCapturePayload {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
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
