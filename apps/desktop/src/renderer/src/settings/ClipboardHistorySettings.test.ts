import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  ClipboardHistorySettings,
  clipboardHistorySettingsReducer,
  runClipboardHistoryClear,
  type ClipboardHistorySettingsState,
} from './ClipboardHistorySettings.js';

describe('ClipboardHistorySettings', () => {
  it('renders a disabled loading button and error message from state', () => {
    const markup = renderToStaticMarkup(
      createElement(ClipboardHistorySettings, {
        state: {
          clearError: 'Clear failed.',
          isClearing: true,
        },
      }),
    );

    expect(markup).toContain('正在清空历史');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Clear failed.');
  });

  it('tracks clear loading, success, and error states', () => {
    const initialState: ClipboardHistorySettingsState = {
      clearError: undefined,
      isClearing: false,
    };

    expect(
      clipboardHistorySettingsReducer(initialState, {
        type: 'clear-started',
      }),
    ).toEqual({
      clearError: undefined,
      isClearing: true,
    });

    expect(
      clipboardHistorySettingsReducer(
        {
          clearError: undefined,
          isClearing: true,
        },
        {
          error: 'Clear failed.',
          type: 'clear-failed',
        },
      ),
    ).toEqual({
      clearError: 'Clear failed.',
      isClearing: false,
    });
  });

  it('runs the clear API through dispatchable loading states', async () => {
    const dispatch = vi.fn();
    const clearClipboardHistory = vi.fn(async () => 3);

    await expect(runClipboardHistoryClear({ clearClipboardHistory }, dispatch)).resolves.toBe(3);

    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: 'clear-started',
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      removedCount: 3,
      type: 'clear-succeeded',
    });
  });

  it('surfaces clear API failures without leaving the button busy', async () => {
    const dispatch = vi.fn();

    await expect(
      runClipboardHistoryClear(
        {
          clearClipboardHistory: async () => {
            throw new Error('Database is closed.');
          },
        },
        dispatch,
      ),
    ).resolves.toBeUndefined();

    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: 'clear-started',
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      error: 'Database is closed.',
      type: 'clear-failed',
    });
  });
});
