import type {
  ScreenshotOcrLanguage,
  ScreenshotOcrResult,
  ScreenshotTranslateSelectionRequest,
  ScreenshotTranslationLanguage,
  ScreenshotTranslationResult,
} from '../../shared/screenshotApi.js';
import { runLocalOcr } from './localOcr.js';
import { runOnlineTranslate } from './onlineTranslate.js';

type RunOcrForTranslation = (request: {
  fallbackLanguages?: readonly ScreenshotOcrLanguage[] | undefined;
  imageDataUrl: string;
  language: ScreenshotOcrLanguage;
}) => Promise<ScreenshotOcrResult>;

type RunOnlineTranslateForTranslation = (request: {
  sourceLanguage: ScreenshotTranslationLanguage;
  targetLanguage: ScreenshotTranslationLanguage;
  text: string;
}) => Promise<ScreenshotTranslationResult>;

export interface RunScreenshotTranslationDependencies {
  runOcr?: RunOcrForTranslation | undefined;
  translate?: RunOnlineTranslateForTranslation | undefined;
}

function pushUniqueLanguage(
  languages: ScreenshotOcrLanguage[],
  language: ScreenshotOcrLanguage,
): void {
  if (!languages.includes(language)) {
    languages.push(language);
  }
}

export function getScreenshotTranslationOcrLanguageCandidates(
  request: Pick<ScreenshotTranslateSelectionRequest, 'ocrLanguage' | 'targetLanguage'>,
): ScreenshotOcrLanguage[] {
  const candidates: ScreenshotOcrLanguage[] = [];

  pushUniqueLanguage(candidates, request.ocrLanguage);
  pushUniqueLanguage(candidates, request.targetLanguage);

  if (request.targetLanguage === 'zh-CN') {
    pushUniqueLanguage(candidates, 'zh-TW');
  } else if (request.targetLanguage === 'zh-TW') {
    pushUniqueLanguage(candidates, 'zh-CN');
  }

  return candidates;
}

export function getScreenshotTranslationSourceLanguage(
  request: Pick<ScreenshotTranslateSelectionRequest, 'ocrLanguage' | 'targetLanguage'>,
  actualOcrLanguage: ScreenshotOcrLanguage,
): ScreenshotTranslationLanguage {
  if (request.ocrLanguage !== request.targetLanguage) {
    return request.ocrLanguage;
  }

  return actualOcrLanguage;
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
      sourceLanguage: getScreenshotTranslationSourceLanguage(request, ocrResult.language),
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
