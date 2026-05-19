export type UpdateStatusPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unavailable';

export interface UpdateStatus {
  canCheck: boolean;
  canInstall: boolean;
  error?: string | undefined;
  percent?: number | undefined;
  phase: UpdateStatusPhase;
  version?: string | undefined;
}

export type UpdateCheckResult = UpdateStatus;

export type UpdateInstallResult =
  | {
      ok: true;
    }
  | {
      error: string;
      ok: false;
    };

const phases = new Set<UpdateStatusPhase>([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
  'error',
  'unavailable',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

function parseOptionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function parseOptionalPercent(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('Invalid update status percent must be between 0 and 100.');
  }

  return value;
}

export function parseUpdateStatus(value: unknown): UpdateStatus {
  if (!isRecord(value)) {
    throw new Error('Invalid update status must be an object.');
  }

  if (typeof value.phase !== 'string' || !phases.has(value.phase as UpdateStatusPhase)) {
    throw new Error('Invalid update status phase.');
  }

  return {
    canCheck: parseBoolean(value.canCheck, 'Invalid update status canCheck'),
    canInstall: parseBoolean(value.canInstall, 'Invalid update status canInstall'),
    error: parseOptionalString(value.error, 'Invalid update status error'),
    percent: parseOptionalPercent(value.percent),
    phase: value.phase as UpdateStatusPhase,
    version: parseOptionalString(value.version, 'Invalid update status version'),
  };
}

export function parseUpdateInstallResult(value: unknown): UpdateInstallResult {
  if (!isRecord(value)) {
    throw new Error('Invalid update install result must be an object.');
  }

  if (value.ok === true) {
    return { ok: true };
  }

  if (value.ok === false) {
    const error = parseOptionalString(value.error, 'Invalid update install result error');

    return {
      error: error && error.trim().length > 0 ? error : 'Update install failed.',
      ok: false,
    };
  }

  throw new Error('Invalid update install result ok flag.');
}
