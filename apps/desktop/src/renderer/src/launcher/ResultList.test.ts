import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ResultList } from './ResultList.js';
import type { LauncherResultItem } from './useLauncherController.js';

function createAppResult(overrides: Partial<LauncherResultItem> = {}): LauncherResultItem {
  return {
    id: 'app.wps',
    icon: 'data:image/png;base64,WPS',
    score: 1,
    source: 'app',
    subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
    title: 'WPS Office',
    ...overrides,
  };
}

function renderResultList({
  onAddPinnedApp,
  onRemoveRecentApp,
  query,
  results,
}: {
  onAddPinnedApp?: (() => void) | undefined;
  onRemoveRecentApp?: ((commandId: string) => void) | undefined;
  query: string;
  results: LauncherResultItem[];
}): string {
  return renderToStaticMarkup(
    createElement(ResultList, {
      errorMessage: undefined,
      isExecutionDisabled: false,
      listboxId: 'launcher-results-listbox',
      onAddPinnedApp,
      onExecute: vi.fn(),
      onRemoveRecentApp,
      onSelect: vi.fn(),
      query,
      results,
      selectedIndex: 0,
      status: 'ready',
    }),
  );
}

describe('ResultList', () => {
  it('renders blank-query app results as a compact recent-app grid', () => {
    const markup = renderResultList({
      query: '',
      results: [
        createAppResult(),
        createAppResult({
          id: 'app.wechat',
          title: '微信',
          subtitle: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
        }),
      ],
    });

    expect(markup).toContain('result-list--recent-apps');
    expect(markup).toContain('result-item--recent-app');
    expect(markup).toContain('WPS Office');
    expect(markup).not.toContain('添加应用');
    expect(markup).not.toContain('ksolaunch.exe');
    expect(markup).not.toContain('class="result-source"');
  });

  it('renders an add app tile in the blank-query app grid when provided', () => {
    const markup = renderResultList({
      onAddPinnedApp: vi.fn(),
      query: '',
      results: [createAppResult()],
    });

    expect(markup).toContain('result-list--recent-apps');
    expect(markup).toContain('result-item--add-app');
    expect(markup).toContain('添加应用');
  });

  it('lets recent app tiles expose a context menu when recent removal is available', () => {
    const markup = renderResultList({
      onRemoveRecentApp: vi.fn(),
      query: '',
      results: [createAppResult()],
    });

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('data-manageable="true"');
  });

  it('renders an add app tile for an empty blank query instead of an empty state', () => {
    const markup = renderToStaticMarkup(
      createElement(ResultList, {
        errorMessage: undefined,
        isExecutionDisabled: false,
        listboxId: 'launcher-results-listbox',
        onAddPinnedApp: vi.fn(),
        onExecute: vi.fn(),
        onSelect: vi.fn(),
        query: '',
        results: [],
        selectedIndex: -1,
        status: 'empty',
      }),
    );

    expect(markup).toContain('result-list--recent-apps');
    expect(markup).toContain('result-item--add-app');
    expect(markup).not.toContain('无结果');
  });

  it('keeps searched app results in the detailed list layout', () => {
    const markup = renderResultList({
      query: 'wps',
      results: [createAppResult()],
    });

    expect(markup).not.toContain('result-list--recent-apps');
    expect(markup).toContain('C:\\Program Files\\WPS Office\\ksolaunch.exe');
    expect(markup).toContain('class="result-source"');
  });

  it('localizes empty and error states', () => {
    const emptyMarkup = renderToStaticMarkup(
      createElement(ResultList, {
        errorMessage: undefined,
        isExecutionDisabled: false,
        language: 'zh-TW',
        listboxId: 'launcher-results-listbox',
        onExecute: vi.fn(),
        onSelect: vi.fn(),
        query: 'wps',
        results: [],
        selectedIndex: -1,
        status: 'empty',
      }),
    );

    expect(emptyMarkup).toContain('沒有結果');
    expect(emptyMarkup).toContain('沒有符合的指令。');
  });
});
