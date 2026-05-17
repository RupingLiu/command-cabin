import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LanguageSettings, getLanguageLabel } from './LanguageSettings.js';

describe('LanguageSettings', () => {
  it('labels supported languages for the settings UI', () => {
    expect(getLanguageLabel('zh-CN')).toBe('简体中文');
    expect(getLanguageLabel('zh-TW')).toBe('繁體中文');
    expect(getLanguageLabel('en-US')).toBe('English');
  });

  it('renders Simplified Chinese as the default selected language', () => {
    const markup = renderToStaticMarkup(createElement(LanguageSettings));

    expect(markup).toContain('语言');
    expect(markup).toContain('简体中文');
    expect(markup).toContain('繁體中文');
    expect(markup).toContain('English');
    expect(markup).toContain('checked=""');
  });
});
