import { randomUUID } from 'node:crypto';

import {
  type CommandCabinDatabase,
  type StorageJsonObject,
  type StorageJsonValue,
  type StorageValueContext,
  formatStorageValueContext,
  isStorageJsonObject,
  normalizeStorageDate,
  parseStorageJson,
  stringifyStorageJson,
  validateStorageJsonValue,
} from '../storage/database.js';

export type FavoriteKind = 'file' | 'folder' | 'url';

interface FavoriteInputBase {
  id?: string;
  title: string;
  keywords: readonly string[];
  metadata?: StorageJsonObject;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface AddFileFavoriteInput extends FavoriteInputBase {
  kind: 'file';
  path: string;
  url?: never;
}

export interface AddFolderFavoriteInput extends FavoriteInputBase {
  kind: 'folder';
  path: string;
  url?: never;
}

export interface AddUrlFavoriteInput extends FavoriteInputBase {
  kind: 'url';
  path?: never;
  url: string;
}

export type AddFavoriteInput = AddFileFavoriteInput | AddFolderFavoriteInput | AddUrlFavoriteInput;

export interface UpdateFavoriteInput {
  title?: string;
  keywords?: readonly string[];
  metadata?: StorageJsonObject;
  updatedAt?: Date | string;
}

interface FavoriteRecordBase {
  id: string;
  kind: FavoriteKind;
  title: string;
  keywords: string[];
  metadata: StorageJsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface FileFavoriteRecord extends FavoriteRecordBase {
  kind: 'file';
  path: string;
  url?: undefined;
}

export interface FolderFavoriteRecord extends FavoriteRecordBase {
  kind: 'folder';
  path: string;
  url?: undefined;
}

export interface UrlFavoriteRecord extends FavoriteRecordBase {
  kind: 'url';
  path?: undefined;
  url: string;
}

export type FavoriteRecord = FileFavoriteRecord | FolderFavoriteRecord | UrlFavoriteRecord;

interface FavoriteRow {
  id: string;
  kind: FavoriteKind;
  title: string;
  path: string | null;
  url: string | null;
  keywords: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface FavoritesRepository {
  addFavorite: (input: AddFavoriteInput) => FavoriteRecord;
  updateFavorite: (id: string, input: UpdateFavoriteInput) => FavoriteRecord | undefined;
  getFavorite: (id: string) => FavoriteRecord | undefined;
  listFavorites: () => FavoriteRecord[];
  removeFavorite: (id: string) => boolean;
}

function throwInvalidFavorite(message: string): never {
  throw new Error(message);
}

function validateFavoriteId(id: string | undefined): string {
  if (id === undefined) {
    return randomUUID();
  }

  const trimmedId = id.trim();

  if (trimmedId.length === 0) {
    throwInvalidFavorite('Favorite id must be a non-empty string');
  }

  return trimmedId;
}

function validateFavoriteKind(kind: unknown): FavoriteKind {
  if (kind !== 'file' && kind !== 'folder' && kind !== 'url') {
    throwInvalidFavorite('Favorite kind must be "file", "folder", or "url"');
  }

  return kind;
}

function validateNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throwInvalidFavorite(message);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throwInvalidFavorite(message);
  }

  return trimmedValue;
}

function validateFavoriteTitle(title: unknown): string {
  return validateNonEmptyString(title, 'Favorite title must be a non-empty string');
}

function isCanonicalArrayIndexProperty(propertyName: string, arrayLength: number): boolean {
  const index = Number(propertyName);

  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < arrayLength &&
    String(index) === propertyName
  );
}

function validateFavoriteKeywords(
  keywords: unknown,
  context: StorageValueContext = {
    table: 'favorites',
    field: 'keywords',
  },
): string[] {
  if (!Array.isArray(keywords)) {
    throwInvalidFavorite(
      `Invalid favorite keywords in ${formatStorageValueContext(
        context,
      )}: favorite keywords must be an array`,
    );
  }

  for (const propertyName of Object.getOwnPropertyNames(keywords)) {
    if (propertyName === 'length') {
      continue;
    }

    if (!isCanonicalArrayIndexProperty(propertyName, keywords.length)) {
      throwInvalidFavorite(
        `Invalid favorite keywords in ${formatStorageValueContext(
          context,
        )}: favorite keywords cannot contain non-index property "${propertyName}"`,
      );
    }
  }

  const normalizedKeywords: string[] = [];
  const seenKeywords = new Set<string>();

  for (let index = 0; index < keywords.length; index += 1) {
    if (!Object.hasOwn(keywords, index)) {
      throwInvalidFavorite(
        `Invalid favorite keywords in ${formatStorageValueContext(
          context,
        )}: favorite keywords[${index}] is missing`,
      );
    }

    const keyword = keywords[index];

    if (typeof keyword !== 'string') {
      throwInvalidFavorite(
        `Invalid favorite keywords in ${formatStorageValueContext(
          context,
        )}: favorite keywords[${index}] must be a string`,
      );
    }

    const trimmedKeyword = keyword.trim();

    if (trimmedKeyword.length === 0) {
      throwInvalidFavorite(
        `Invalid favorite keywords in ${formatStorageValueContext(
          context,
        )}: favorite keywords[${index}] must be a non-empty string`,
      );
    }

    if (!seenKeywords.has(trimmedKeyword)) {
      normalizedKeywords.push(trimmedKeyword);
      seenKeywords.add(trimmedKeyword);
    }
  }

  return normalizedKeywords;
}

function validateFavoriteMetadata(
  metadata: unknown,
  context: StorageValueContext = {
    table: 'favorites',
    field: 'metadata',
  },
): StorageJsonObject {
  const metadataValue = metadata ?? {};

  validateStorageJsonValue(metadataValue, context, 'metadata');

  if (!isStorageJsonObject(metadataValue)) {
    throwInvalidFavorite(
      `Invalid favorite metadata in ${formatStorageValueContext(
        context,
      )}: metadata must be an object`,
    );
  }

  return metadataValue;
}

function validateFavoriteUrl(url: unknown): string {
  const trimmedUrl = validateNonEmptyString(url, 'URL favorite url must be an http or https URL');
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throwInvalidFavorite('URL favorite url must be an http or https URL');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throwInvalidFavorite('URL favorite url must be an http or https URL');
  }

  return trimmedUrl;
}

function validateFavoriteTarget(input: AddFavoriteInput): Pick<FavoriteRow, 'path' | 'url'> {
  if (input.kind === 'url') {
    return {
      path: null,
      url: validateFavoriteUrl(input.url),
    };
  }

  return {
    path: validateNonEmptyString(
      input.path,
      `${input.kind === 'file' ? 'File' : 'Folder'} favorite path must be a non-empty string`,
    ),
    url: null,
  };
}

function validateStorageFavoriteKind(kind: unknown, id: string): FavoriteKind {
  if (kind !== 'file' && kind !== 'folder' && kind !== 'url') {
    throwInvalidFavorite(`Invalid favorite kind in favorites key "${id}": unsupported kind`);
  }

  return kind;
}

function mapFavoriteRow(row: FavoriteRow): FavoriteRecord {
  const kind = validateStorageFavoriteKind(row.kind, row.id);
  const title = validateFavoriteTitle(row.title);
  const createdAt = normalizeFavoriteDate(row.created_at, 'createdAt');
  const updatedAt = normalizeFavoriteDate(row.updated_at, 'updatedAt');
  const keywordsContext = {
    table: 'favorites',
    field: 'keywords',
    key: row.id,
  };
  const keywords = validateFavoriteKeywords(
    parseStorageJson<StorageJsonValue>(row.keywords, keywordsContext),
    keywordsContext,
  );
  const metadataContext = {
    table: 'favorites',
    field: 'metadata',
    key: row.id,
  };
  const metadata = validateFavoriteMetadata(
    parseStorageJson<StorageJsonValue>(row.metadata, metadataContext),
    metadataContext,
  );
  const baseRecord = {
    id: row.id,
    title,
    keywords,
    metadata,
    createdAt,
    updatedAt,
  };

  if (kind === 'url') {
    if (row.url === null) {
      throwInvalidFavorite(`Invalid favorite target in favorites key "${row.id}": URL is missing`);
    }

    return {
      ...baseRecord,
      kind,
      url: validateFavoriteUrl(row.url),
    };
  }

  if (row.path === null) {
    throwInvalidFavorite(`Invalid favorite target in favorites key "${row.id}": path is missing`);
  }

  return {
    ...baseRecord,
    kind,
    path: validateNonEmptyString(row.path, 'Stored favorite path must be a non-empty string'),
  };
}

function normalizeFavoriteDate(value: Date | string, field: string): string {
  return normalizeStorageDate(value, {
    operation: 'favorite',
    field,
  });
}

export function createFavoritesRepository(database: CommandCabinDatabase): FavoritesRepository {
  const selectFavorite = database.prepare<[string], FavoriteRow>(
    `
      SELECT id, kind, title, path, url, keywords, metadata, created_at, updated_at
      FROM favorites
      WHERE id = ?
    `,
  );
  const selectFavorites = database.prepare<[], FavoriteRow>(
    `
      SELECT id, kind, title, path, url, keywords, metadata, created_at, updated_at
      FROM favorites
      ORDER BY title COLLATE NOCASE, id
    `,
  );
  const insertFavorite = database.prepare<{
    id: string;
    kind: FavoriteKind;
    title: string;
    path: string | null;
    url: string | null;
    keywords: string;
    metadata: string;
    createdAt: string;
    updatedAt: string;
  }>(
    `
      INSERT INTO favorites (
        id,
        kind,
        title,
        path,
        url,
        keywords,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        @id,
        @kind,
        @title,
        @path,
        @url,
        @keywords,
        @metadata,
        @createdAt,
        @updatedAt
      )
    `,
  );
  const updateFavorite = database.prepare<{
    id: string;
    title: string;
    keywords: string;
    metadata: string;
    updatedAt: string;
  }>(
    `
      UPDATE favorites
      SET title = @title,
          keywords = @keywords,
          metadata = @metadata,
          updated_at = @updatedAt
      WHERE id = @id
    `,
  );
  const deleteFavorite = database.prepare<[string]>('DELETE FROM favorites WHERE id = ?');

  function getFavorite(id: string): FavoriteRecord | undefined {
    const row = selectFavorite.get(id);
    return row ? mapFavoriteRow(row) : undefined;
  }

  return {
    addFavorite: (input) => {
      const kind = validateFavoriteKind(input.kind);
      const id = validateFavoriteId(input.id);
      const title = validateFavoriteTitle(input.title);
      const target = validateFavoriteTarget(input);
      const keywords = validateFavoriteKeywords(input.keywords);
      const metadata = validateFavoriteMetadata(input.metadata);
      const createdAt = normalizeFavoriteDate(input.createdAt ?? new Date(), 'createdAt');
      const updatedAt = normalizeFavoriteDate(input.updatedAt ?? createdAt, 'updatedAt');

      insertFavorite.run({
        id,
        kind,
        title,
        ...target,
        keywords: stringifyStorageJson(keywords, {
          table: 'favorites',
          field: 'keywords',
          key: id,
        }),
        metadata: stringifyStorageJson(metadata, {
          table: 'favorites',
          field: 'metadata',
          key: id,
        }),
        createdAt,
        updatedAt,
      });

      const favorite = getFavorite(id);

      if (!favorite) {
        throw new Error(`Favorite was not saved: ${id}`);
      }

      return favorite;
    },
    updateFavorite: (id, input) => {
      const existingFavorite = getFavorite(id);

      if (!existingFavorite) {
        return undefined;
      }

      const title =
        input.title === undefined ? existingFavorite.title : validateFavoriteTitle(input.title);
      const keywords =
        input.keywords === undefined
          ? existingFavorite.keywords
          : validateFavoriteKeywords(input.keywords);
      const metadata =
        input.metadata === undefined
          ? existingFavorite.metadata
          : validateFavoriteMetadata(input.metadata);
      const updatedAt = normalizeFavoriteDate(input.updatedAt ?? new Date(), 'updatedAt');

      updateFavorite.run({
        id,
        title,
        keywords: stringifyStorageJson(keywords, {
          table: 'favorites',
          field: 'keywords',
          key: id,
        }),
        metadata: stringifyStorageJson(metadata, {
          table: 'favorites',
          field: 'metadata',
          key: id,
        }),
        updatedAt,
      });

      return getFavorite(id);
    },
    getFavorite,
    listFavorites: () => selectFavorites.all().map(mapFavoriteRow),
    removeFavorite: (id) => deleteFavorite.run(id).changes > 0,
  };
}
