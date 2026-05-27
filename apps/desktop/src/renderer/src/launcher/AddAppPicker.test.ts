import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AddAppPickerView, getRenderableAppCandidateIcon } from './AddAppPicker.js';
import type { AppCandidate } from '../../../shared/appCandidatesApi.js';

function createCandidate(overrides: Partial<AppCandidate> = {}): AppCandidate {
  return {
    alreadyPinned: false,
    executablePath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
    icon: 'data:image/png;base64,WPS',
    iconPath: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
    id: 'start-menu.wps',
    resolutionStatus: 'resolved',
    shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\WPS Office.lnk',
    source: 'start-menu',
    subtitle: 'C:\\Program Files\\WPS Office\\ksolaunch.exe',
    title: 'WPS Office',
    ...overrides,
  };
}

function renderPicker(candidates: AppCandidate[], status: 'ready' | 'empty' = 'ready'): string {
  return renderToStaticMarkup(
    createElement(AddAppPickerView, {
      candidates,
      isAdding: false,
      language: 'zh-CN',
      query: '',
      selectedIndex: 0,
      status,
      onAddCandidate: vi.fn(),
      onBrowseLocalFile: vi.fn(),
      onClose: vi.fn(),
      onKeyDown: vi.fn(),
      onPinnedAppAdded: vi.fn(),
      onQueryChange: vi.fn(),
    }),
  );
}

describe('AddAppPickerView', () => {
  it('renders candidates with icon, source, and add actions', () => {
    const markup = renderPicker([
      createCandidate(),
      createCandidate({
        alreadyPinned: true,
        icon: undefined,
        id: 'desktop.codex',
        resolutionStatus: 'unresolved-shortcut',
        shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        source: 'desktop',
        subtitle: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        title: 'Codex',
      }),
    ]);

    expect(markup).toContain('添加应用');
    expect(markup).toContain('搜索应用名称或路径');
    expect(markup).toContain('WPS Office');
    expect(markup).toContain('开始菜单');
    expect(markup).toContain('Codex');
    expect(markup).toContain('桌面');
    expect(markup).toContain('快捷方式信息不完整');
    expect(markup).toContain('已添加');
    expect(markup).toContain('浏览本地文件');
  });

  it('uses glyph fallback for raw Windows icon paths', () => {
    const markup = renderPicker([
      createCandidate({
        icon: 'C:\\Program Files\\Codex\\Codex.exe,0',
        id: 'desktop.codex',
        title: 'Codex',
      }),
    ]);

    expect(markup).toContain('class="add-app-candidate__icon"');
    expect(markup).toContain('>C</span>');
    expect(markup).not.toContain('Codex.exe,0');
  });

  it('falls back to the glyph after candidate image load failure', () => {
    const candidate = createCandidate({
      icon: 'data:image/png;base64,WPS',
    });

    expect(getRenderableAppCandidateIcon(candidate)).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,WPS',
    });
    expect(getRenderableAppCandidateIcon(candidate, 'data:image/png;base64,WPS')).toEqual({
      kind: 'glyph',
      value: 'W',
    });
  });

  it('renders a localized empty state', () => {
    const markup = renderPicker([], 'empty');

    expect(markup).toContain('没有找到应用');
    expect(markup).toContain('换个关键词试试');
  });
});
