const MULTIPLE_WHITESPACE_PATTERN = /\s+/g;
const DIACRITIC_PATTERN = /\p{Diacritic}/gu;
const DIACRITIC_CHARACTER_PATTERN = /^\p{Diacritic}$/u;
const WHITESPACE_CHARACTER_PATTERN = /^\s$/u;

export type SearchTextSourceRange = readonly [number, number];

export interface NormalizedSearchTextMapping {
  normalizedText: string;
  sourceRanges: readonly SearchTextSourceRange[];
}

interface MappedSearchText {
  text: string;
  sourceRanges: SearchTextSourceRange[];
}

function normalizeSearchTextValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(DIACRITIC_PATTERN, '')
    .toLowerCase()
    .trim()
    .replace(MULTIPLE_WHITESPACE_PATTERN, ' ');
}

function alignSourceRanges(
  sourceRanges: readonly SearchTextSourceRange[],
  targetLength: number,
  sourceLength: number,
): SearchTextSourceRange[] {
  if (sourceRanges.length === targetLength) {
    return [...sourceRanges];
  }

  if (targetLength === 0) {
    return [];
  }

  const fallbackRange: SearchTextSourceRange = [0, Math.max(0, sourceLength - 1)];

  if (sourceRanges.length === 0) {
    return Array.from({ length: targetLength }, () => fallbackRange);
  }

  return Array.from({ length: targetLength }, (_value, index) => {
    const sourceIndex = Math.min(
      sourceRanges.length - 1,
      Math.floor((index * sourceRanges.length) / targetLength),
    );

    return sourceRanges[sourceIndex] ?? fallbackRange;
  });
}

function getSourceRange(
  sourceRanges: readonly SearchTextSourceRange[],
  startIndex: number,
  length: number,
): SearchTextSourceRange {
  const firstRange = sourceRanges[startIndex] ?? [startIndex, startIndex];
  const lastRange = sourceRanges[startIndex + length - 1] ?? firstRange;

  return [firstRange[0], lastRange[1]];
}

function createDecomposedMappedText(value: string): MappedSearchText {
  const text = value.normalize('NFKD');
  const sourceRanges: SearchTextSourceRange[] = [];
  let sourceIndex = 0;

  for (const character of value) {
    const sourceRange: SearchTextSourceRange = [sourceIndex, sourceIndex + character.length - 1];
    const decomposedCharacter = character.normalize('NFKD');

    for (let index = 0; index < decomposedCharacter.length; index += 1) {
      sourceRanges.push(sourceRange);
    }

    sourceIndex += character.length;
  }

  return {
    text,
    sourceRanges: alignSourceRanges(sourceRanges, text.length, value.length),
  };
}

function removeDiacritics(mappedText: MappedSearchText): MappedSearchText {
  let text = '';
  const sourceRanges: SearchTextSourceRange[] = [];
  let textIndex = 0;
  let leadingDiacriticStart: number | undefined;

  for (const character of mappedText.text) {
    const sourceRange = getSourceRange(mappedText.sourceRanges, textIndex, character.length);

    if (DIACRITIC_CHARACTER_PATTERN.test(character)) {
      const previousRange = sourceRanges[sourceRanges.length - 1];

      if (previousRange) {
        sourceRanges[sourceRanges.length - 1] = [
          previousRange[0],
          Math.max(previousRange[1], sourceRange[1]),
        ];
      } else {
        leadingDiacriticStart = Math.min(leadingDiacriticStart ?? sourceRange[0], sourceRange[0]);
      }

      textIndex += character.length;
      continue;
    }

    const outputRange: SearchTextSourceRange = [
      leadingDiacriticStart ?? sourceRange[0],
      sourceRange[1],
    ];

    text += character;
    for (let index = 0; index < character.length; index += 1) {
      sourceRanges.push(outputRange);
    }

    leadingDiacriticStart = undefined;
    textIndex += character.length;
  }

  return {
    text,
    sourceRanges,
  };
}

function lowercaseMappedText(mappedText: MappedSearchText): MappedSearchText {
  const text = mappedText.text.toLowerCase();
  const sourceRanges: SearchTextSourceRange[] = [];
  let textIndex = 0;

  for (const character of mappedText.text) {
    const sourceRange = getSourceRange(mappedText.sourceRanges, textIndex, character.length);
    const lowercasedCharacter = character.toLowerCase();

    for (let index = 0; index < lowercasedCharacter.length; index += 1) {
      sourceRanges.push(sourceRange);
    }

    textIndex += character.length;
  }

  return {
    text,
    sourceRanges: alignSourceRanges(sourceRanges, text.length, mappedText.text.length),
  };
}

function collapseMappedWhitespace(mappedText: MappedSearchText): MappedSearchText {
  let text = '';
  const sourceRanges: SearchTextSourceRange[] = [];
  let pendingWhitespaceRange: SearchTextSourceRange | undefined;
  let textIndex = 0;

  for (const character of mappedText.text) {
    const sourceRange = getSourceRange(mappedText.sourceRanges, textIndex, character.length);

    if (WHITESPACE_CHARACTER_PATTERN.test(character)) {
      if (sourceRanges.length > 0) {
        pendingWhitespaceRange =
          pendingWhitespaceRange === undefined
            ? sourceRange
            : [pendingWhitespaceRange[0], sourceRange[1]];
      }

      textIndex += character.length;
      continue;
    }

    if (pendingWhitespaceRange !== undefined) {
      text += ' ';
      sourceRanges.push(pendingWhitespaceRange);
      pendingWhitespaceRange = undefined;
    }

    text += character;
    for (let index = 0; index < character.length; index += 1) {
      sourceRanges.push(sourceRange);
    }

    textIndex += character.length;
  }

  return {
    text,
    sourceRanges,
  };
}

export function normalizeSearchText(value: string): string {
  return normalizeSearchTextValue(value);
}

export function normalizeSearchTextWithMapping(value: string): NormalizedSearchTextMapping {
  const normalizedText = normalizeSearchTextValue(value);
  const mappedText = collapseMappedWhitespace(
    lowercaseMappedText(removeDiacritics(createDecomposedMappedText(value))),
  );

  return {
    normalizedText,
    sourceRanges: alignSourceRanges(mappedText.sourceRanges, normalizedText.length, value.length),
  };
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
