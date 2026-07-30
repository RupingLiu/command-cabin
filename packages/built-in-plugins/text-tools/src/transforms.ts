export type TextTransformKind =
  | 'uppercase'
  | 'lowercase'
  | 'remove-blank-lines'
  | 'format-json'
  | 'url-encode'
  | 'url-decode';

export class TextTransformError extends Error {
  constructor(
    message: string,
    readonly kind: TextTransformKind,
  ) {
    super(message);
    this.name = 'TextTransformError';
  }
}

const JSON_NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function assertJsonNumbersCanBeFormattedLosslessly(input: string): void {
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character !== '-' && (character < '0' || character > '9')) {
      continue;
    }

    JSON_NUMBER_PATTERN.lastIndex = index;
    const match = JSON_NUMBER_PATTERN.exec(input);

    if (!match) {
      continue;
    }

    const literal = match[0];
    const value = Number(literal);

    if (!Number.isFinite(value)) {
      throw new Error(`JSON number is outside the supported finite range: ${literal}`);
    }

    if (!literal.includes('.') && !/[eE]/u.test(literal) && !Number.isSafeInteger(value)) {
      throw new Error(`JSON integer cannot be formatted without precision loss: ${literal}`);
    }

    index = JSON_NUMBER_PATTERN.lastIndex - 1;
  }
}

export function formatJson(input: string): string {
  try {
    assertJsonNumbersCanBeFormattedLosslessly(input);
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch (error) {
    throw new TextTransformError(`Invalid JSON: ${formatErrorMessage(error)}`, 'format-json');
  }
}

export function removeBlankLines(input: string): string {
  return input
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

export function applyTextTransform(kind: TextTransformKind, input: string): string {
  switch (kind) {
    case 'uppercase':
      return input.toUpperCase();
    case 'lowercase':
      return input.toLowerCase();
    case 'remove-blank-lines':
      return removeBlankLines(input);
    case 'format-json':
      return formatJson(input);
    case 'url-encode':
      return encodeURIComponent(input);
    case 'url-decode':
      try {
        return decodeURIComponent(input);
      } catch (error) {
        throw new TextTransformError(
          `Invalid URL encoded text: ${formatErrorMessage(error)}`,
          'url-decode',
        );
      }
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
