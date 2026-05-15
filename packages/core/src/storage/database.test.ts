import { describe, expect, it } from 'vitest';

import { openCommandCabinDatabase, openInMemoryCommandCabinDatabase } from './database.js';

describe('CommandCabin database helper', () => {
  it('requires an explicit path for the production database opener', () => {
    expect(() =>
      openCommandCabinDatabase(
        undefined as unknown as Parameters<typeof openCommandCabinDatabase>[0],
      ),
    ).toThrow(/requires an explicit database path/i);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects a %s production database path', (_name, path) => {
    expect(() => openCommandCabinDatabase({ path })).toThrow(/requires a non-empty database path/i);
  });

  it('opens in-memory databases through an explicit test helper', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      expect(database.memory).toBe(true);
    } finally {
      database.close();
    }
  });
});
