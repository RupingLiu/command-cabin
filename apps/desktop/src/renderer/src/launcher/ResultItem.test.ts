import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ResultItem, getResultIconGlyph } from './ResultItem.js';
import type { LauncherResultItem } from './useLauncherController.js';

function createResult(overrides: Partial<LauncherResultItem> = {}): LauncherResultItem {
  return {
    id: 'app.wps',
    score: 1.74,
    source: 'app',
    title: 'WPS Office',
    subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
    icon: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
    ...overrides,
  };
}

describe('ResultItem', () => {
  it('uses a short title glyph instead of rendering Windows icon paths as text', () => {
    expect(getResultIconGlyph(createResult())).toBe('W');

    const markup = renderToStaticMarkup(
      createElement(ResultItem, {
        id: 'launcher-option-app-wps',
        index: 0,
        isDisabled: false,
        isSelected: true,
        onExecute: vi.fn(),
        onSelect: vi.fn(),
        result: createResult(),
      }),
    );

    expect(markup).toContain('class="result-icon"');
    expect(markup).not.toContain('ksolaunch.exe,0');
  });

  it('renders data URL icons as images', () => {
    const markup = renderToStaticMarkup(
      createElement(ResultItem, {
        id: 'launcher-option-app-wps',
        index: 0,
        isDisabled: false,
        isSelected: true,
        onExecute: vi.fn(),
        onSelect: vi.fn(),
        result: createResult({
          icon: 'data:image/png;base64,WPS',
        }),
      }),
    );

    expect(markup).toContain('src="data:image/png;base64,WPS"');
    expect(markup).toContain('alt=""');
  });

  it('localizes the source label for detailed results', () => {
    const markup = renderToStaticMarkup(
      createElement(ResultItem, {
        id: 'launcher-option-app-wps',
        index: 0,
        isDisabled: false,
        isSelected: true,
        language: 'zh-CN',
        onExecute: vi.fn(),
        onSelect: vi.fn(),
        result: createResult(),
      }),
    );

    expect(markup).toContain('应用');
    expect(markup).not.toContain('>App</span>');
  });

  it('marks pinned app results as context-menu manageable', () => {
    const markup = renderToStaticMarkup(
      createElement(ResultItem, {
        id: 'launcher-option-app-codex',
        index: 0,
        isManageable: true,
        isDisabled: false,
        isSelected: true,
        onExecute: vi.fn(),
        onOpenAppMenu: vi.fn(),
        onSelect: vi.fn(),
        result: createResult({
          favoriteId: 'favorite-codex',
          id: 'favorite.codex',
          title: 'Codex',
        }),
        variant: 'compact',
      }),
    );

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('data-manageable="true"');
  });

  it('marks recent app results as context-menu manageable when the list can remove them', () => {
    const markup = renderToStaticMarkup(
      createElement(ResultItem, {
        id: 'launcher-option-app-codex',
        index: 0,
        isManageable: true,
        isDisabled: false,
        isSelected: true,
        onExecute: vi.fn(),
        onOpenAppMenu: vi.fn(),
        onSelect: vi.fn(),
        result: createResult({
          id: 'app.codex',
          title: 'Codex',
        }),
        variant: 'compact',
      }),
    );

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('data-manageable="true"');
  });

  it('does not expose pinned app management for non-app favorites', () => {
    const markup = renderToStaticMarkup(
      createElement(ResultItem, {
        id: 'launcher-option-file-docs',
        index: 0,
        isManageable: true,
        isDisabled: false,
        isSelected: false,
        onExecute: vi.fn(),
        onOpenAppMenu: vi.fn(),
        onSelect: vi.fn(),
        result: createResult({
          favoriteId: 'favorite-docs',
          id: 'favorite.docs',
          source: 'file',
          title: 'Docs',
        }),
      }),
    );

    expect(markup).not.toContain('aria-haspopup="menu"');
    expect(markup).toContain('data-manageable="false"');
  });
});
