import { describe, expect, it } from 'vitest';

import { rankSearchCandidate } from './ranking.js';
import type { SearchMatchedBy, SearchRankingContext } from './ranking.js';
import { normalizeSearchKeywords, tokenizeSearchText } from './tokenize.js';
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

function match(field: SearchMatchedBy['field'], value: string): SearchMatchedBy {
  return {
    field,
    value,
    indices: [[0, value.length - 1]],
  };
}

describe('search ranking', () => {
  it('weights title matches above subtitles and keywords', () => {
    const titleRank = rankSearchCandidate({
      command: createCommand({ id: 'title', title: 'Settings', keywords: [] }),
      query: 'settings',
      fuseScore: 0.2,
      matchedBy: [match('title', 'Settings')],
    });
    const subtitleRank = rankSearchCandidate({
      command: createCommand({
        id: 'subtitle',
        title: 'Preferences',
        subtitle: 'Settings',
        keywords: [],
      }),
      query: 'settings',
      fuseScore: 0.2,
      matchedBy: [match('subtitle', 'Settings')],
    });
    const keywordRank = rankSearchCandidate({
      command: createCommand({
        id: 'keyword',
        title: 'Preferences',
        keywords: ['settings'],
      }),
      query: 'settings',
      fuseScore: 0.2,
      matchedBy: [match('keywords', 'settings')],
    });

    expect(titleRank.score).toBeGreaterThan(subtitleRank.score);
    expect(subtitleRank.score).toBeGreaterThan(keywordRank.score);
    expect(titleRank.explanation.components.field).toBeGreaterThan(
      subtitleRank.explanation.components.field,
    );
    expect(subtitleRank.explanation.components.field).toBeGreaterThan(
      keywordRank.explanation.components.field,
    );
  });

  it('weights command sources and supports context source overrides', () => {
    const systemRank = rankSearchCandidate({
      command: createCommand({ id: 'system', source: 'system', title: 'Open Settings' }),
      query: 'settings',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Settings')],
    });
    const pluginRank = rankSearchCandidate({
      command: createCommand({ id: 'plugin', source: 'plugin', title: 'Open Settings' }),
      query: 'settings',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Settings')],
    });
    const boostedPluginRank = rankSearchCandidate({
      command: createCommand({ id: 'plugin', source: 'plugin', title: 'Open Settings' }),
      query: 'settings',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Settings')],
      context: {
        sourceWeights: {
          plugin: 0.25,
          system: 0,
        },
      },
    });

    expect(systemRank.score).toBeGreaterThan(pluginRank.score);
    expect(systemRank.explanation.components.source).toBeGreaterThan(
      pluginRank.explanation.components.source,
    );
    expect(boostedPluginRank.score).toBeGreaterThan(systemRank.score);
  });

  it('adds explicit history, pinned, and recent-use boosts', () => {
    const context: SearchRankingContext = {
      pinnedCommandIds: ['pinned'],
      now: '2026-05-15T12:00:00.000Z',
      history: {
        frequent: {
          executionCount: 8,
          lastUsedAt: '2026-05-14T12:00:00.000Z',
        },
        recent: {
          executionCount: 1,
          lastUsedAt: '2026-05-15T11:50:00.000Z',
        },
      },
    };

    const pinnedRank = rankSearchCandidate({
      command: createCommand({ id: 'pinned', title: 'Open Calendar' }),
      query: 'calendar',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Calendar')],
      context,
    });
    const frequentRank = rankSearchCandidate({
      command: createCommand({ id: 'frequent', title: 'Open Calendar' }),
      query: 'calendar',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Calendar')],
      context,
    });
    const recentRank = rankSearchCandidate({
      command: createCommand({ id: 'recent', title: 'Open Calendar' }),
      query: 'calendar',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Calendar')],
      context,
    });
    const plainRank = rankSearchCandidate({
      command: createCommand({ id: 'plain', title: 'Open Calendar' }),
      query: 'calendar',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Calendar')],
      context,
    });

    expect(pinnedRank.explanation.components.pinned).toBeGreaterThan(0);
    expect(frequentRank.explanation.components.history).toBeGreaterThan(0);
    expect(recentRank.explanation.components.recent).toBeGreaterThan(0);
    expect(pinnedRank.score).toBeGreaterThan(plainRank.score);
    expect(frequentRank.score).toBeGreaterThan(plainRank.score);
    expect(recentRank.score).toBeGreaterThan(plainRank.score);
  });

  it('boosts exact title matches after query normalization', () => {
    const exactRank = rankSearchCandidate({
      command: createCommand({ id: 'exact', title: 'Open Settings' }),
      query: '  open   settings ',
      fuseScore: 0.15,
      matchedBy: [match('title', 'Open Settings')],
    });
    const partialRank = rankSearchCandidate({
      command: createCommand({ id: 'partial', title: 'Open Settings Panel' }),
      query: 'open settings',
      fuseScore: 0.15,
      matchedBy: [match('title', 'Open Settings')],
    });

    expect(exactRank.score).toBeGreaterThan(partialRank.score);
    expect(exactRank.explanation.components.exactTitle).toBeGreaterThan(0);
    expect(partialRank.explanation.components.exactTitle).toBe(0);
  });

  it('keeps invalid history dates from contributing recent-use boosts', () => {
    const rank = rankSearchCandidate({
      command: createCommand({ id: 'bad-date', title: 'Open Calendar' }),
      query: 'calendar',
      fuseScore: 0.1,
      matchedBy: [match('title', 'Calendar')],
      context: {
        now: '2026-05-15T12:00:00.000Z',
        history: {
          'bad-date': {
            executionCount: 2,
            lastUsedAt: 'not-a-date',
          },
        },
      },
    });

    expect(rank.explanation.components.history).toBeGreaterThan(0);
    expect(rank.explanation.components.recent).toBe(0);
  });
});

describe('search tokenization', () => {
  it('normalizes whitespace, casing, diacritics, and duplicate keywords', () => {
    expect(tokenizeSearchText('  Café   SETTINGS  ')).toEqual(['cafe', 'settings']);
    expect(normalizeSearchKeywords([' Notes ', 'notes', 'Café'])).toEqual(['notes', 'cafe']);
  });
});
