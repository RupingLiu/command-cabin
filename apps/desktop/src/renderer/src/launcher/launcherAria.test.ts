import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LauncherPage } from './LauncherPage.js';
import { ResultList } from './ResultList.js';
import { SearchInput } from './SearchInput.js';

describe('launcher ARIA markup', () => {
  it('wires search input as a combobox controlling the result listbox', () => {
    const html = renderToStaticMarkup(
      createElement(SearchInput, {
        activeDescendantId: 'launcher-option-system-settings',
        inputRef: null,
        isBusy: false,
        isExpanded: true,
        listboxId: 'launcher-results-listbox',
        onKeyDown: vi.fn(),
        onQueryChange: vi.fn(),
        query: 'settings',
        searchInputId: 'launcher-search-input',
      }),
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="launcher-results-listbox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-activedescendant="launcher-option-system-settings"');
  });

  it('renders stable listbox and option ids', () => {
    const html = renderToStaticMarkup(
      createElement(ResultList, {
        errorMessage: undefined,
        isExecutionDisabled: false,
        listboxId: 'launcher-results-listbox',
        onExecute: vi.fn(),
        onSelect: vi.fn(),
        query: '',
        results: [
          {
            id: 'system.settings',
            score: 1,
            source: 'system',
            subtitle: 'Preferences',
            title: 'Open Settings',
          },
        ],
        selectedIndex: 0,
        status: 'ready',
      }),
    );

    expect(html).toContain('id="launcher-results-listbox"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="launcher-option-system-settings"');
    expect(html).toContain('role="option"');
  });

  it('marks options disabled while command execution is in progress', () => {
    const html = renderToStaticMarkup(
      createElement(ResultList, {
        errorMessage: undefined,
        isExecutionDisabled: true,
        listboxId: 'launcher-results-listbox',
        onExecute: vi.fn(),
        onSelect: vi.fn(),
        query: '',
        results: [
          {
            id: 'system.settings',
            score: 1,
            source: 'system',
            title: 'Open Settings',
          },
        ],
        selectedIndex: 0,
        status: 'executing',
      }),
    );

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-disabled="true"');
  });

  it('exposes home action buttons for unit conversion and screenshot capture', () => {
    const html = renderToStaticMarkup(
      createElement(LauncherPage, {
        language: 'zh-CN',
        onOpenSettings: vi.fn(),
        onOpenUnitConverter: vi.fn(),
      }),
    );

    expect(html).toContain('单位换算');
    expect(html).toContain('截图');
    expect(html).toContain('class="launcher-home-actions"');
    expect(html.indexOf('launcher-results-listbox')).toBeLessThan(
      html.indexOf('launcher-home-actions'),
    );
  });

  it('shows a downloaded update prompt on the launcher home screen', () => {
    const html = renderToStaticMarkup(
      createElement(LauncherPage, {
        language: 'zh-CN',
        onOpenSettings: vi.fn(),
        onOpenUnitConverter: vi.fn(),
        updateState: {
          errorMessage: undefined,
          isInstalling: false,
          status: {
            canCheck: false,
            canInstall: true,
            phase: 'downloaded',
            version: '0.8.0',
          },
        },
      }),
    );

    expect(html).toContain('新版本 0.8.0 已下载');
    expect(html).toContain('立即安装');
    expect(html).toContain('class="launcher-update-banner"');
    expect(html.indexOf('launcher-results-listbox')).toBeLessThan(
      html.indexOf('launcher-update-banner'),
    );
  });
});
