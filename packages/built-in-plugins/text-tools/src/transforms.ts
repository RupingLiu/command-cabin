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

export function formatJson(input: string): string {
  try {
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
