import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { createSearchEngine } from './searchEngine.js';
import type { Command } from '../command/types.js';

function createCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'app.notepad',
    source: 'app',
    title: 'Notepad',
    keywords: ['notepad', 'notes'],
    action: {
      type: 'open-app',
      payload: {
        executablePath: 'C:\\Windows\\System32\\notepad.exe',
      },
    },
    ...overrides,
  };
}

describe('search engine', () => {
  it('prefers title matches over subtitle matches and subtitle matches over keyword matches', () => {
    const engine = createSearchEngine([
      createCommand({
        id: 'keyword',
        title: 'Preferences',
        keywords: ['settings'],
      }),
      createCommand({
        id: 'subtitle',
        title: 'Preferences',
        subtitle: 'Settings',
        keywords: [],
      }),
      createCommand({
        id: 'title',
        title: 'Settings',
        keywords: [],
      }),
    ]);

    expect(engine.search('settings').map((result) => result.command.id)).toEqual([
      'title',
      'subtitle',
      'keyword',
    ]);
  });

  it('applies pinned, history, and recent boosts from explicit ranking context', () => {
    const engine = createSearchEngine([
      createCommand({ id: 'plain', title: 'Calendar Plain', keywords: ['calendar'] }),
      createCommand({ id: 'pinned', title: 'Calendar Pinned', keywords: ['calendar'] }),
      createCommand({ id: 'recent', title: 'Calendar Recent', keywords: ['calendar'] }),
      createCommand({ id: 'frequent', title: 'Calendar Frequent', keywords: ['calendar'] }),
    ]);

    const results = engine.search('calendar', {
      ranking: {
        pinnedCommandIds: ['pinned'],
        now: '2026-05-15T12:00:00.000Z',
        history: {
          recent: {
            executionCount: 1,
            lastUsedAt: '2026-05-15T11:59:00.000Z',
          },
          frequent: {
            executionCount: 6,
            lastUsedAt: '2026-05-12T12:00:00.000Z',
          },
        },
      },
    });

    expect(results[0]?.command.id).toBe('pinned');
    expect(
      results.find((result) => result.command.id === 'pinned')?.ranking.components.pinned,
    ).toBe(0.35);
    expect(
      results.find((result) => result.command.id === 'recent')?.ranking.components.recent,
    ).toBeGreaterThan(0);
    expect(
      results.find((result) => result.command.id === 'frequent')?.ranking.components.history,
    ).toBeGreaterThan(0);
  });

  it('ranks boosted commands beyond the default Fuse candidate window', () => {
    const commands = Array.from({ length: 150 }, (_value, index) =>
      createCommand({
        id: `shared.${index.toString().padStart(3, '0')}`,
        title: 'Open Shared',
        keywords: [],
      }),
    );
    const engine = createSearchEngine(commands);

    const results = engine.search('open shared', {
      limit: 2,
      ranking: {
        pinnedCommandIds: ['shared.149'],
        now: '2026-05-15T12:00:00.000Z',
        history: {
          'shared.148': {
            executionCount: 3,
            lastUsedAt: '2026-05-01T12:00:00.000Z',
          },
        },
      },
    });

    expect(results.map((result) => result.command.id)).toEqual(['shared.149', 'shared.148']);
  });

  it('ranks recent-only commands beyond the default candidate window', () => {
    const commands = Array.from({ length: 150 }, (_value, index) =>
      createCommand({
        id: `recent.${index.toString().padStart(3, '0')}`,
        title: 'Open Recent Shared',
        keywords: [],
      }),
    );
    const engine = createSearchEngine(commands);

    const results = engine.search('open recent shared', {
      limit: 1,
      ranking: {
        now: '2026-05-15T12:00:00.000Z',
        history: {
          'recent.149': {
            executionCount: 1,
            lastUsedAt: '2026-05-15T11:59:00.000Z',
          },
        },
      },
    });

    expect(results.map((result) => result.command.id)).toEqual(['recent.149']);
    expect(results[0]?.ranking.components.recent).toBeGreaterThan(0);
  });

  it('keeps boosted fuzzy candidates eligible when exact matches fill the normal window', () => {
    const commands = [
      ...Array.from({ length: 150 }, (_value, index) =>
        createCommand({
          id: `exact.${index.toString().padStart(3, '0')}`,
          title: 'Open Workspace',
          keywords: [],
        }),
      ),
      createCommand({
        id: 'boosted.fuzzy',
        title: 'Open Wrokspace',
        keywords: [],
      }),
    ];
    const engine = createSearchEngine(commands);

    const results = engine.search('open workspace', {
      limit: 1,
      ranking: {
        pinnedCommandIds: ['boosted.fuzzy'],
        now: '2026-05-15T12:00:00.000Z',
        history: {
          'boosted.fuzzy': {
            executionCount: 20,
            lastUsedAt: '2026-05-15T11:59:00.000Z',
          },
        },
      },
    });

    expect(results.map((result) => result.command.id)).toEqual(['boosted.fuzzy']);
    expect(results[0]?.ranking.components.pinned).toBeGreaterThan(0);
  });

  it('orders otherwise equal matches by command source weight', () => {
    const engine = createSearchEngine([
      createCommand({ id: 'plugin.command', source: 'plugin', title: 'Open Shared' }),
      createCommand({ id: 'system.command', source: 'system', title: 'Open Shared' }),
    ]);

    const results = engine.search('open shared');

    expect(results.map((result) => result.command.id)).toEqual([
      'system.command',
      'plugin.command',
    ]);
    expect(results[0]?.ranking.components.source).toBeGreaterThan(
      results[1]?.ranking.components.source ?? 0,
    );
  });

  it('prioritizes exact title matches over fuzzy title matches', () => {
    const engine = createSearchEngine([
      createCommand({ id: 'settings-panel', title: 'Open Settings Panel', keywords: [] }),
      createCommand({ id: 'settings', title: 'Open Settings', keywords: [] }),
    ]);

    const results = engine.search('open settings');

    expect(results[0]?.command.id).toBe('settings');
    expect(results[0]?.ranking.components.exactTitle).toBeGreaterThan(0);
  });

  it('returns matchedBy fields with Fuse match indices for debugging', () => {
    const engine = createSearchEngine([
      createCommand({
        id: 'vpn',
        title: 'Network Preferences',
        subtitle: 'Configure VPN connections',
        keywords: ['wireguard', 'vpn'],
      }),
    ]);

    const [result] = engine.search('vpn');

    expect(result?.matchedBy.map((match) => match.field)).toEqual(['subtitle', 'keywords']);
    expect(result?.matchedBy[0]).toMatchObject({
      field: 'subtitle',
      value: 'Configure VPN connections',
    });
    expect(result?.matchedBy[0]?.indices.length).toBeGreaterThan(0);
  });

  it('uses Fuse fuzzy matching when a query has a typo', () => {
    const engine = createSearchEngine([
      createCommand({ id: 'calendar', title: 'Calendar', keywords: ['schedule'] }),
    ]);

    const [result] = engine.search('calendr');

    expect(result?.command.id).toBe('calendar');
    expect(result?.fuseScore).toBeGreaterThan(0);
    expect(result?.matchedBy[0]?.field).toBe('title');
  });

  it('returns ranked commands for an empty query when enabled', () => {
    const engine = createSearchEngine([
      createCommand({ id: 'plain', title: 'Plain', keywords: [] }),
      createCommand({ id: 'pinned', title: 'Pinned', keywords: [] }),
      createCommand({ id: 'recent', title: 'Recent', keywords: [] }),
    ]);

    const results = engine.search('  ', {
      limit: 2,
      includeAllOnEmptyQuery: true,
      ranking: {
        pinnedCommandIds: ['pinned'],
        now: '2026-05-15T12:00:00.000Z',
        history: {
          recent: {
            executionCount: 1,
            lastUsedAt: '2026-05-15T11:58:00.000Z',
          },
        },
      },
    });

    expect(results.map((result) => result.command.id)).toEqual(['pinned', 'recent']);
    expect(results.every((result) => result.fuseScore === 1)).toBe(true);
    expect(results.every((result) => result.matchedBy[0]?.field === 'empty-query')).toBe(true);
  });

  it('returns no commands for an empty query when disabled', () => {
    const engine = createSearchEngine([createCommand()]);

    expect(engine.search('', { includeAllOnEmptyQuery: false })).toEqual([]);
  });

  it('respects limits and sorts ties deterministically by title and command id', () => {
    const engine = createSearchEngine([
      createCommand({ id: 'z-command', title: 'Same Match', keywords: [] }),
      createCommand({ id: 'a-command', title: 'Same Match', keywords: [] }),
      createCommand({ id: 'middle-command', title: 'Same Match', keywords: [] }),
    ]);

    const results = engine.search('same match', { limit: 2 });

    expect(results.map((result) => result.command.id)).toEqual(['a-command', 'middle-command']);
  });

  it('updates the index and returns isolated command snapshots', () => {
    const engine = createSearchEngine([createCommand({ id: 'notepad', title: 'Notepad' })]);

    engine.update([createCommand({ id: 'calculator', title: 'Calculator', keywords: ['math'] })]);
    const [result] = engine.search('calculator');
    result!.command.keywords.push('caller-mutation');

    expect(engine.search('notepad')).toEqual([]);
    expect(engine.search('calculator')[0]?.command.keywords).toEqual(['math']);
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -0.1],
    ['greater than one', 1.1],
  ])('rejects a %s Fuse threshold', (_name, threshold) => {
    expect(() => createSearchEngine([], { threshold })).toThrow(
      /Search threshold must be a finite number between 0 and 1/,
    );
  });

  it('searches 5000 commands within the interactive budget', () => {
    const commands = Array.from({ length: 5_000 }, (_value, index) =>
      createCommand({
        id: `command.${index.toString().padStart(4, '0')}`,
        title: `Command ${index}`,
        subtitle: index % 10 === 0 ? 'Needle workspace command' : 'Workspace command',
        keywords: [`command-${index}`, index === 4_999 ? 'needle-unique' : 'general'],
      }),
    );
    const engine = createSearchEngine(commands);

    const measureAverageSearchMs = (query: string): number => {
      engine.search(query, { limit: 10 });
      const startedAt = performance.now();

      for (let index = 0; index < 10; index += 1) {
        engine.search(query, { limit: 10 });
      }

      return (performance.now() - startedAt) / 10;
    };

    // Vitest runs suites concurrently in CI, so the default budget allows runner noise while
    // still catching a search implementation that stops feeling interactive. Set
    // COMMAND_CABIN_STRICT_PERF=1 for a sequential/local check against the 50ms target.
    const ciBudgetMs = 100;
    const strictBudgetMs = 50;
    const averageMsByQuery = {
      selective: measureAverageSearchMs('needle'),
      broad: measureAverageSearchMs('workspace'),
    };

    for (const [queryKind, averageMs] of Object.entries(averageMsByQuery)) {
      expect(
        averageMs,
        `5000-command ${queryKind} search averaged ${averageMs.toFixed(
          2,
        )}ms; CI budget is ${ciBudgetMs}ms`,
      ).toBeLessThan(ciBudgetMs);
    }

    if (process.env.COMMAND_CABIN_STRICT_PERF === '1') {
      for (const [queryKind, averageMs] of Object.entries(averageMsByQuery)) {
        expect(
          averageMs,
          `5000-command ${queryKind} strict local target is ${strictBudgetMs}ms; averaged ${averageMs.toFixed(
            2,
          )}ms`,
        ).toBeLessThan(strictBudgetMs);
      }
    }
  });
});
