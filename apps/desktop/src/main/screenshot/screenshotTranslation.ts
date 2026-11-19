import type {
  ScreenshotOcrLanguage,
  ScreenshotOcrResult,
  ScreenshotTranslateSelectionRequest,
  ScreenshotTranslationResult,
} from '../../shared/screenshotApi.js';
import { runLocalOcr } from './localOcr.js';
import { runOnlineTranslate, type OnlineTranslateRequest } from './onlineTranslate.js';

type RunOcrForTranslation = (request: {
  fallbackLanguages?: readonly ScreenshotOcrLanguage[] | undefined;
  imageDataUrl: string;
  language: ScreenshotOcrLanguage;
}) => Promise<ScreenshotOcrResult>;

type RunOnlineTranslateForTranslation = (
  request: OnlineTranslateRequest,
) => Promise<ScreenshotTranslationResult>;

export interface RunScreenshotTranslationDependencies {
  runOcr?: RunOcrForTranslation | undefined;
  translate?: RunOnlineTranslateForTranslation | undefined;
}

export function getScreenshotTranslationOcrLanguageCandidates(
  request: Pick<ScreenshotTranslateSelectionRequest, 'ocrLanguage' | 'targetLanguage'>,
): ScreenshotOcrLanguage[] {
  // A Chinese pack recognizes both Han and Latin text. Keep the other variant
  // ahead of English if the preferred Chinese pack is unavailable.
  const chineseVariants: ScreenshotOcrLanguage[] =
    request.ocrLanguage === 'zh-TW' || request.targetLanguage === 'zh-TW'
      ? ['zh-TW', 'zh-CN']
      : ['zh-CN', 'zh-TW'];
  return [...new Set<ScreenshotOcrLanguage>([request.ocrLanguage, ...chineseVariants, 'en-US'])];
}

export async function runScreenshotTranslation(
  request: ScreenshotTranslateSelectionRequest,
  {
    runOcr = runLocalOcr,
    translate = runOnlineTranslate,
  }: RunScreenshotTranslationDependencies = {},
): Promise<ScreenshotTranslationResult> {
  const [language, ...fallbackLanguages] = getScreenshotTranslationOcrLanguageCandidates(request);
  const ocrResult = await runOcr({
    fallbackLanguages,
    imageDataUrl: request.imageDataUrl,
    language: language ?? request.ocrLanguage,
  });

  if (ocrResult.status === 'success' && ocrResult.text.trim().length > 0) {
    return translate({
      detectSourceLanguage: true,
      sourceLanguage: ocrResult.language,
      targetLanguage: request.targetLanguage,
      text: ocrResult.text,
    });
  }

  if (ocrResult.status === 'success') {
    return {
      message: 'No OCR text found.',
      ocrLanguage: ocrResult.language,
      status: 'unavailable',
      targetLanguage: request.targetLanguage,
    };
  }

  if (ocrResult.status === 'error') {
    return {
      message: ocrResult.message,
      ocrLanguage: ocrResult.language,
      status: 'error',
      targetLanguage: request.targetLanguage,
    };
  }

  return {
    message: ocrResult.message,
    ocrLanguage: ocrResult.language,
    status: 'unavailable',
    targetLanguage: request.targetLanguage,
  };
}
