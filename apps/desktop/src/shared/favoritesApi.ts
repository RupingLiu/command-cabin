import type {
  AddFavoriteInput,
  FavoriteKind,
  FavoriteRecord,
  StorageJsonObject,
  UpdateFavoriteInput,
} from '@command-cabin/core';

import {
  isRecord,
  parseIsoDateString,
  parseNonEmptyString,
  parseOptionalNonEmptyString,
  parseString,
  sanitizeJsonObject,
} from './parsers.js';

export type FavoriteCreateRequest = AddFavoriteInput;
export type FavoriteUpdateRequest = UpdateFavoriteInput;
export type FavoriteListRecord = FavoriteRecord;

const favoriteKinds = new Set<FavoriteKind>(['file', 'folder', 'url']);

function parseFavoriteKind(value: unknown, context: string): FavoriteKind {
  const kind = parseString(value, context);

  if (!favoriteKinds.has(kind as FavoriteKind)) {
    throw new Error(`${context} must be "file", "folder", or "url".`);
  }

  return kind as FavoriteKind;
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
