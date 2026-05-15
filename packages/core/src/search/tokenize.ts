const MULTIPLE_WHITESPACE_PATTERN = /\s+/g;
const DIACRITIC_PATTERN = /\p{Diacritic}/gu;

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(DIACRITIC_PATTERN, '')
    .toLowerCase()
    .trim()
    .replace(MULTIPLE_WHITESPACE_PATTERN, ' ');
}

export function tokenizeSearchText(value: string): string[] {
  const normalizedValue = normalizeSearchText(value);

  return normalizedValue.length === 0 ? [] : normalizedValue.split(' ');
}

export function normalizeSearchKeywords(keywords: readonly string[]): string[] {
  const normalizedKeywords = new Set<string>();

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeSearchText(keyword);

    if (normalizedKeyword.length > 0) {
      normalizedKeywords.add(normalizedKeyword);
    }
  }

  return Array.from(normalizedKeywords);
}
