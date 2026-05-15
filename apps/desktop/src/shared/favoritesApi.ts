import type {
  AddFavoriteInput,
  FavoriteKind,
  FavoriteRecord,
  StorageJsonObject,
  StorageJsonValue,
  UpdateFavoriteInput,
} from '@command-cabin/core';

export type FavoriteCreateRequest = AddFavoriteInput;
export type FavoriteUpdateRequest = UpdateFavoriteInput;
export type FavoriteListRecord = FavoriteRecord;

const favoriteKinds = new Set<FavoriteKind>(['file', 'folder', 'url']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function parseNonEmptyString(value: unknown, context: string): string {
  const stringValue = parseString(value, context).trim();

  if (stringValue.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return stringValue;
}

function parseOptionalNonEmptyString(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, context);
}

function parseFavoriteKind(value: unknown, context: string): FavoriteKind {
  const kind = parseString(value, context);

  if (!favoriteKinds.has(kind as FavoriteKind)) {
    throw new Error(`${context} must be "file", "folder", or "url".`);
  }

  return kind as FavoriteKind;
}

function parseIsoDateString(value: unknown, context: string): string {
  const dateString = parseString(value, context);

  if (!Number.isFinite(new Date(dateString).getTime())) {
    throw new Error(`${context} must be a valid ISO date string.`);
  }

  return dateString;
}

function parseHttpUrl(value: unknown, context: string): string {
  const url = parseNonEmptyString(value, context);
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${context} must be an http or https URL.`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`${context} must be an http or https URL.`);
  }

  return url;
}

function sanitizeJsonValue(value: unknown, context: string): StorageJsonValue {
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

function sanitizeJsonObject(value: unknown, context: string): StorageJsonObject {
  if (!isRecord(value)) {
    throw new Error(`${context} must be a plain object.`);
  }

  const sanitized: StorageJsonObject = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = sanitizeJsonValue(nestedValue, `${context}.${key}`);
  }

  return sanitized;
}

function parseMetadata(value: unknown, context: string): StorageJsonObject {
  return value === undefined ? {} : sanitizeJsonObject(value, context);
}

function parseKeywords(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`);
  }

  return value.map((keyword, index) => parseNonEmptyString(keyword, `${context}[${index}]`));
}

function parseFavoritePayload(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  return value;
}

export function parseFavoriteRecord(value: unknown): FavoriteRecord {
  const context = 'Invalid favorite record';
  const record = parseFavoritePayload(value, context);
  const kind = parseFavoriteKind(record.kind, `${context}.kind`);
  const baseRecord = {
    id: parseNonEmptyString(record.id, `${context}.id`),
    title: parseNonEmptyString(record.title, `${context}.title`),
    keywords: parseKeywords(record.keywords, `${context}.keywords`),
    metadata: parseMetadata(record.metadata, `${context}.metadata`),
    createdAt: parseIsoDateString(record.createdAt, `${context}.createdAt`),
    updatedAt: parseIsoDateString(record.updatedAt, `${context}.updatedAt`),
  };

  if (kind === 'url') {
    return {
      ...baseRecord,
      kind,
      url: parseHttpUrl(record.url, `${context}.url`),
    };
  }

  return {
    ...baseRecord,
    kind,
    path: parseNonEmptyString(record.path, `${context}.path`),
  };
}

export function parseFavoriteId(value: unknown, context = 'Invalid favorite id request'): string {
  return parseNonEmptyString(value, context);
}

export function parseFavoriteRecords(value: unknown): FavoriteRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid favorites list response must be an array.');
  }

  return value.map(parseFavoriteRecord);
}

export function parseFavoriteCreateRequest(value: unknown): FavoriteCreateRequest {
  const context = 'Invalid favorite create request';
  const record = parseFavoritePayload(value, context);
  const kind = parseFavoriteKind(record.kind, `${context}.kind`);
  const baseRequest = {
    title: parseNonEmptyString(record.title, `${context}.title`),
    keywords: parseKeywords(record.keywords, `${context}.keywords`),
    metadata: parseMetadata(record.metadata, `${context}.metadata`),
  };

  if (kind === 'url') {
    return {
      ...baseRequest,
      kind,
      url: parseHttpUrl(record.url, `${context}.url`),
    };
  }

  return {
    ...baseRequest,
    kind,
    path: parseNonEmptyString(record.path, `${context}.path`),
  };
}

export function parseFavoriteUpdateRequest(value: unknown): FavoriteUpdateRequest {
  const context = 'Invalid favorite update request';
  const record = parseFavoritePayload(value, context);
  const request: FavoriteUpdateRequest = {};
  const title = parseOptionalNonEmptyString(record.title, `${context}.title`);

  if (title !== undefined) {
    request.title = title;
  }

  if (record.keywords !== undefined) {
    request.keywords = parseKeywords(record.keywords, `${context}.keywords`);
  }

  if (record.metadata !== undefined) {
    request.metadata = parseMetadata(record.metadata, `${context}.metadata`);
  }

  return request;
}

export function parseFavoriteRemovalResult(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Invalid favorite removal response must be a boolean.');
  }

  return value;
}
