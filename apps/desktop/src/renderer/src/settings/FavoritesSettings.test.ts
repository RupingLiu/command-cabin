import { describe, expect, it } from 'vitest';

import {
  createFavoriteDraftFromRecord,
  createFavoritesLoadGate,
  createFavoritesOperationGate,
  favoriteDraftToCreateRequest,
  favoriteDraftToUpdateRequest,
  parseFavoriteKeywordsInput,
} from './FavoritesSettings.js';

describe('FavoritesSettings helpers', () => {
  it('parses comma and newline separated favorite keywords', () => {
    expect(parseFavoriteKeywordsInput('docs, project\nmanual')).toEqual([
      'docs',
      'project',
      'manual',
    ]);
  });

  it('creates favorite requests from add form drafts', () => {
    expect(
      favoriteDraftToCreateRequest({
        kind: 'url',
        keywordsText: 'docs, manual',
        target: 'https://example.com/docs',
        title: 'Docs',
      }),
    ).toEqual({
      kind: 'url',
      keywords: ['docs', 'manual'],
      metadata: {},
      title: 'Docs',
      url: 'https://example.com/docs',
    });
  });

  it('creates edit drafts and update requests for title and keyword changes', () => {
    const draft = createFavoriteDraftFromRecord({
      id: 'favorite-docs',
      kind: 'file',
      title: 'Docs',
      path: 'C:\\Docs\\Project.md',
      keywords: ['docs', 'project'],
      metadata: {},
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:00:00.000Z',
    });

    expect(draft).toEqual({
      kind: 'file',
      keywordsText: 'docs, project',
      target: 'C:\\Docs\\Project.md',
      title: 'Docs',
    });

    expect(
      favoriteDraftToUpdateRequest({
        ...draft,
        keywordsText: 'manual',
        title: 'Product Manual',
      }),
    ).toEqual({
      keywords: ['manual'],
      title: 'Product Manual',
    });
  });

  it('allows only one save or delete operation at a time', () => {
    const gate = createFavoritesOperationGate();

    expect(gate.tryStart('saving')).toBe(true);
    expect(gate.tryStart('saving')).toBe(false);
    expect(gate.tryStart('deleting')).toBe(false);

    gate.finish('deleting');
    expect(gate.isBusy()).toBe(true);

    gate.finish('saving');
    expect(gate.isBusy()).toBe(false);
    expect(gate.tryStart('deleting')).toBe(true);
  });

  it('accepts only the newest favorites list load token', () => {
    const gate = createFavoritesLoadGate();
    const firstLoad = gate.start();
    const secondLoad = gate.start();

    expect(gate.isCurrent(firstLoad)).toBe(false);
    expect(gate.isCurrent(secondLoad)).toBe(true);

    gate.finish(firstLoad);
    expect(gate.isCurrent(secondLoad)).toBe(true);

    gate.finish(secondLoad);
    expect(gate.isCurrent(secondLoad)).toBe(false);
  });
});
