import { describe, expect, it } from 'vitest';

import {
  parseFavoriteCreateRequest,
  parseFavoriteRecord,
  parseFavoriteRecords,
  parseFavoriteRemovalResult,
  parseFavoriteUpdateRequest,
} from './favoritesApi.js';

describe('favorites API validators', () => {
  it('sanitizes favorite records returned from IPC', () => {
    const record = parseFavoriteRecord({
      extra: 'ignored',
      id: 'favorite-docs',
      kind: 'url',
      title: 'Docs',
      url: 'https://example.com/docs',
      keywords: ['docs'],
      metadata: {
        pinned: true,
      },
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:01:00.000Z',
    });

    expect(record).toEqual({
      id: 'favorite-docs',
      kind: 'url',
      title: 'Docs',
      url: 'https://example.com/docs',
      keywords: ['docs'],
      metadata: {
        pinned: true,
      },
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:01:00.000Z',
    });
    expect(parseFavoriteRecords([record])).toEqual([record]);
  });

  it('rejects malformed favorite records from IPC', () => {
    expect(() =>
      parseFavoriteRecord({
        id: 'favorite-docs',
        kind: 'url',
        title: 'Docs',
        url: 'javascript:alert(1)',
        keywords: [],
        metadata: {},
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      }),
    ).toThrow(/Invalid favorite record\.url must be an http or https URL/);
  });

  it('sanitizes favorite create and update requests before IPC', () => {
    expect(
      parseFavoriteCreateRequest({
        kind: 'file',
        title: 'Readme',
        path: 'C:\\WorkingFolder\\command-cabin\\README.md',
        keywords: ['docs'],
        metadata: {
          pinned: false,
        },
      }),
    ).toEqual({
      kind: 'file',
      title: 'Readme',
      path: 'C:\\WorkingFolder\\command-cabin\\README.md',
      keywords: ['docs'],
      metadata: {
        pinned: false,
      },
    });

    expect(
      parseFavoriteUpdateRequest({
        title: 'Product Docs',
        keywords: ['manual'],
      }),
    ).toEqual({
      title: 'Product Docs',
      keywords: ['manual'],
    });
  });

  it('rejects malformed favorite requests before IPC', () => {
    expect(() =>
      parseFavoriteCreateRequest({
        kind: 'folder',
        title: 'Workspace',
        path: '   ',
        keywords: [],
      }),
    ).toThrow(/Invalid favorite create request\.path must be a non-empty string/);

    expect(() =>
      parseFavoriteUpdateRequest({
        keywords: ['ok', 7],
      }),
    ).toThrow(/Invalid favorite update request\.keywords\[1\] must be a string/);
  });

  it('sanitizes favorite removal results', () => {
    expect(parseFavoriteRemovalResult(true)).toBe(true);
    expect(() => parseFavoriteRemovalResult('true')).toThrow(
      /Invalid favorite removal response must be a boolean/,
    );
  });
});
