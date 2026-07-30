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

  it('rejects Promise-like transaction handlers and rolls back their synchronous writes', () => {
    const database = openInMemoryCommandCabinDatabase();

    try {
      database.exec('CREATE TABLE transaction_test (value TEXT NOT NULL)');
      const insert = database.prepare<[{ value: string }]>(
        'INSERT INTO transaction_test (value) VALUES (:value)',
      );
      const transaction = database.transaction(async () => {
        insert.run({ value: 'must roll back' });
      });

      expect(() => transaction()).toThrow(/synchronous handlers/i);
      expect(
        database
          .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM transaction_test')
          .get()?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});
