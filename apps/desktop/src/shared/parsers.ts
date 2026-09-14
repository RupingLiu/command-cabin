import type { StorageJsonObject, StorageJsonValue } from '@command-cabin/core';

// Shared parsing helpers used by the IPC boundary parsers in this directory.
//
// NOTE: hotkeyInputApi keeps its own private `isRecord` because it intentionally
// accepts any object-like value (no plain-object prototype check), unlike the
// strict version exported here which requires `Object.prototype` or a null
// prototype.

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

export function parseNonEmptyString(value: unknown, context: string): string {
  const stringValue = parseString(value, context).trim();

  if (stringValue.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return stringValue;
}

export function parseOptionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseString(value, context);
}

export function parseOptionalNonEmptyString(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, context);
}

export function parseBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

export function parseFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number.`);
  }

  return value;
}

export function parseIsoDateString(value: unknown, context: string): string {
  const dateString = parseString(value, context);

  if (!Number.isFinite(new Date(dateString).getTime())) {
    throw new Error(`${context} must be a valid ISO date string.`);
  }

  return dateString;
}

export function parseStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`);
  }

  return value.map((item, index) => parseString(item, `${context}[${index}]`));
}

export function sanitizeJsonValue(value: unknown, context: string): StorageJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeJsonValue(item, `${context}[${index}]`));
  }

  if (isRecord(value)) {
    return sanitizeJsonObject(value, context);
  }

  throw new Error(`${context} must be JSON-compatible.`);
}

export function sanitizeJsonObject(value: unknown, context: string): StorageJsonObject {
  if (!isRecord(value)) {
    throw new Error(`${context} must be a plain object.`);
  }

  const sanitized: StorageJsonObject = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = sanitizeJsonValue(nestedValue, `${context}.${key}`);
  }

  return sanitized;
}
