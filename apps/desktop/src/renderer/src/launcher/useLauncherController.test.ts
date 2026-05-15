import { describe, expect, it } from 'vitest';

import {
  getExecutableSelectedResult,
  getLauncherKeyIntent,
  launcherReducer,
  type LauncherResultItem,
  type LauncherState,
} from './useLauncherController.js';

const baseState: LauncherState = {
  errorMessage: undefined,
  query: '',
  requestId: 0,
  results: [],
  selectedIndex: -1,
  status: 'idle',
};

function createResult(id: string): LauncherResultItem {
  return {
    id,
    source: 'system',
    title: `Command ${id}`,
    subtitle: 'System command',
  };
}

describe('launcher controller state', () => {
  it('clears stale results and selection while a new search is loading', () => {
    const ready: LauncherState = {
      ...baseState,
      requestId: 1,
      results: [createResult('old')],
      selectedIndex: 0,
      status: 'ready',
    };

    const queryChanged = launcherReducer(ready, {
      query: 'new query',
      type: 'query-changed',
    });

    expect(queryChanged).toMatchObject({
      query: 'new query',
      results: [],
      selectedIndex: -1,
      status: 'loading',
    });

    const loading = launcherReducer(ready, {
      requestId: 2,
      type: 'search-started',
    });

    expect(loading).toMatchObject({
      errorMessage: undefined,
      requestId: 2,
      results: [],
      selectedIndex: -1,
      status: 'loading',
    });
  });

  it('ignores stale search results', () => {
    const loading = launcherReducer(baseState, {
      requestId: 2,
      type: 'search-started',
    });

    const staleSuccess = launcherReducer(loading, {
      requestId: 1,
      results: [createResult('stale')],
      type: 'search-succeeded',
    });

    expect(staleSuccess).toBe(loading);
  });

  it('selects the first result after a successful search and wraps arrow navigation', () => {
    const loading = launcherReducer(baseState, {
      requestId: 1,
      type: 'search-started',
    });
    const ready = launcherReducer(loading, {
      requestId: 1,
      results: [createResult('alpha'), createResult('bravo')],
      type: 'search-succeeded',
    });

    expect(ready.status).toBe('ready');
    expect(ready.selectedIndex).toBe(0);

    const previous = launcherReducer(ready, {
      direction: 'previous',
      type: 'move-selection',
    });

    expect(previous.selectedIndex).toBe(1);

    const next = launcherReducer(previous, {
      direction: 'next',
      type: 'move-selection',
    });

    expect(next.selectedIndex).toBe(0);
  });

  it('represents empty and error states without a selected item', () => {
    const loading = launcherReducer(baseState, {
      requestId: 1,
      type: 'search-started',
    });
    const empty = launcherReducer(loading, {
      requestId: 1,
      results: [],
      type: 'search-succeeded',
    });

    expect(empty).toMatchObject({
      results: [],
      selectedIndex: -1,
      status: 'empty',
    });

    const error = launcherReducer(
      {
        ...empty,
        requestId: 2,
      },
      {
        errorMessage: 'Search failed.',
        requestId: 2,
        type: 'search-failed',
      },
    );

    expect(error).toMatchObject({
      errorMessage: 'Search failed.',
      results: [],
      selectedIndex: -1,
      status: 'error',
    });
  });
});

describe('launcher execution guard', () => {
  it('returns only the selected result from a ready launcher state', () => {
    const ready: LauncherState = {
      ...baseState,
      results: [createResult('alpha'), createResult('bravo')],
      selectedIndex: 1,
      status: 'ready',
    };

    expect(getExecutableSelectedResult(ready)?.id).toBe('bravo');
  });

  it('does not expose a stale executable result when Enter is pressed after the query changes', () => {
    const ready: LauncherState = {
      ...baseState,
      results: [createResult('old')],
      selectedIndex: 0,
      status: 'ready',
    };
    const loading = launcherReducer(ready, {
      query: 'new query',
      type: 'query-changed',
    });

    expect(getLauncherKeyIntent('Enter')).toBe('execute');
    expect(getExecutableSelectedResult(loading)).toBeUndefined();
  });

  it('does not expose an executable result while execution is already in progress', () => {
    const executing: LauncherState = {
      ...baseState,
      results: [createResult('alpha')],
      selectedIndex: 0,
      status: 'executing',
    };

    expect(getExecutableSelectedResult(executing)).toBeUndefined();
  });
});

describe('launcher keyboard intent', () => {
  it.each([
    ['ArrowDown', 'select-next'],
    ['ArrowUp', 'select-previous'],
    ['Enter', 'execute'],
    ['Escape', 'hide'],
  ] as const)('maps %s to %s', (key, expectedIntent) => {
    expect(getLauncherKeyIntent(key)).toBe(expectedIntent);
  });

  it('ignores unrelated keys', () => {
    expect(getLauncherKeyIntent('Tab')).toBeUndefined();
  });
});
