import { describe, expect, it } from 'vitest';

import {
  applyThemePreferenceToRoot,
  applyThemeToRoot,
  resolveThemePreference,
} from './ThemeSettings.js';

describe('ThemeSettings helpers', () => {
  it('applies explicit themes and clears system theme on the document root', () => {
    const attributes = new Map<string, string>();
    const root = {
      removeAttribute: (name: string) => attributes.delete(name),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };

    applyThemeToRoot('dark', root);
    expect(attributes.get('data-theme')).toBe('dark');

    applyThemeToRoot('system', root);
    expect(attributes.has('data-theme')).toBe(false);
  });

  it('resolves system theme through OS color scheme preference', () => {
    expect(resolveThemePreference('dark')).toBe('dark');
    expect(resolveThemePreference('light')).toBe('light');
    expect(resolveThemePreference('system', () => true)).toBe('light');
    expect(resolveThemePreference('system', () => false)).toBe('dark');
  });

  it('applies persisted theme preference to the document root', () => {
    const attributes = new Map<string, string>();
    const root = {
      removeAttribute: (name: string) => attributes.delete(name),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };

    applyThemePreferenceToRoot('system', root, () => true);
    expect(attributes.get('data-theme')).toBe('light');

    applyThemePreferenceToRoot('system', root, () => false);
    expect(attributes.get('data-theme')).toBe('dark');
  });
});
