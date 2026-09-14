import { describe, expect, it } from 'vitest';

import { normalizeSearchText, normalizeSearchTextWithMapping } from './tokenize.js';

describe('normalizeSearchTextWithMapping', () => {
  it.each([
    ['simple', 'Settings'],
    ['casing', 'OpEn SeTtInGs'],
    ['diacritics', 'Café déjà vu naïve'],
    ['NFKD compatibility expansion', 'Open ﬃle'],
    ['combining mark', 'Cafe\u0301'],
    ['multiple whitespace', 'open    settings'],
    ['leading and trailing whitespace', '  open settings  '],
    ['mixed tabs and spaces', '\topen \t settings\n'],
    ['empty string', ''],
    ['all whitespace', '   \t  '],
    ['all diacritics', '\u0301\u0300\u0308'],
    ['uppercase dotless i', 'İstanbul'],
    ['german sharp s', 'STRAẞE'],
    ['emoji', '🚀 launch'],
  ])('produces the same normalized text as normalizeSearchText for %s', (_name, value) => {
    const mapping = normalizeSearchTextWithMapping(value);

    expect(mapping.normalizedText).toBe(normalizeSearchText(value));
  });

  it.each([
    ['simple', 'Settings'],
    ['casing', 'OpEn SeTtInGs'],
    ['diacritics', 'Café déjà vu naïve'],
    ['NFKD compatibility expansion', 'Open ﬃle'],
    ['combining mark', 'Cafe\u0301'],
    ['multiple whitespace', 'open    settings'],
    ['leading and trailing whitespace', '  open settings  '],
    ['empty string', ''],
    ['all whitespace', '   \t  '],
    ['emoji', '🚀 launch'],
  ])('keeps one source range per normalized character for %s', (_name, value) => {
    const mapping = normalizeSearchTextWithMapping(value);

    expect(mapping.sourceRanges).toHaveLength(mapping.normalizedText.length);
  });
});
