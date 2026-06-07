import type { ScreenshotAnnotation, ScreenshotPoint, ScreenshotRect } from './screenshotState.js';

const translationTextColor = '#111827';

function isCjkCharacter(character: string): boolean {
  return /[\u3000-\u9fff\uf900-\ufaff]/u.test(character);
}

function getCharacterWidthUnits(character: string): number {
  if (character === '\t') {
    return 2;
  }

  if (character === ' ') {
    return 0.35;
  }

  return isCjkCharacter(character) ? 1 : 0.55;
}

function getLineWidthUnits(line: string): number {
  return [...line].reduce((total, character) => total + getCharacterWidthUnits(character), 0);
}

function getMaxLineUnits(rect: ScreenshotRect, fontSize: number): number {
  const availableWidth = Math.max(1, rect.width - getTranslationOverlayPadding(fontSize) * 2);

  return Math.max(4, availableWidth / Math.max(1, fontSize));
}

export function getTranslationOverlayPadding(fontSize: number): number {
  return Math.max(8, Math.round(fontSize * 0.55));
}

export function getTranslationOverlayLineHeight(fontSize: number): number {
  return fontSize * 1.35;
}

export function getTranslationOverlayTextOrigin(
  rect: ScreenshotRect,
  fontSize: number,
  lineCount = 1,
): ScreenshotPoint {
  const padding = getTranslationOverlayPadding(fontSize);
  const lineHeight = getTranslationOverlayLineHeight(fontSize);
  const textBlockHeight = Math.max(1, lineCount) * lineHeight;

  return {
    x: rect.x + padding,
    y: rect.y + Math.max(padding, (rect.height - textBlockHeight) / 2),
  };
}

export function wrapTranslationOverlayText(
  text: string,
  rect: ScreenshotRect,
  fontSize: number,
): string[] {
  const maxLineUnits = getMaxLineUnits(rect, fontSize);
  const lines: string[] = [];

  for (const paragraph of text.trim().split(/\r?\n/)) {
    let currentLine = '';
    let currentUnits = 0;

    for (const character of paragraph.trim()) {
      const nextUnits = getCharacterWidthUnits(character);

      if (currentLine && currentUnits + nextUnits > maxLineUnits) {
        lines.push(currentLine);
        currentLine = character.trimStart();
        currentUnits = getLineWidthUnits(currentLine);
      } else {
        currentLine += character;
        currentUnits += nextUnits;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [text.trim()];
}

export function resolveTranslationOverlayFontSize(text: string, rect: ScreenshotRect): number {
  const maxFontSize = Math.max(14, Math.min(32, Math.floor(rect.height / 2.2)));
  const minFontSize = 12;

  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
    const padding = getTranslationOverlayPadding(fontSize);
    const lines = wrapTranslationOverlayText(text, rect, fontSize);
    const textBlockHeight = lines.length * getTranslationOverlayLineHeight(fontSize);

    if (textBlockHeight + padding * 2 <= rect.height) {
      return fontSize;
    }
  }

  return minFontSize;
}

export function createTranslationOverlayAnnotation(
  selection: ScreenshotRect,
  translatedText: string,
): ScreenshotAnnotation | undefined {
  const text = translatedText.trim();

  if (!text) {
    return undefined;
  }

  const overlayRect = {
    height: selection.height,
    width: selection.width,
    x: 0,
    y: 0,
  };
  const fontSize = resolveTranslationOverlayFontSize(text, overlayRect);

  return {
    rect: overlayRect,
    style: {
      color: translationTextColor,
      fontSize,
      lineWidth: 1,
    },
    text,
    type: 'translation',
  };
}
