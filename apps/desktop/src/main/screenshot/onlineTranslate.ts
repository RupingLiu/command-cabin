import type {
  ScreenshotTranslationLanguage,
  ScreenshotTranslationResult,
} from '../../shared/screenshotApi.js';

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
const DEFAULT_TRANSLATION_TIMEOUT_MS = 6_000;

export interface OnlineTranslateRequest {
  sourceLanguage: ScreenshotTranslationLanguage;
  targetLanguage: ScreenshotTranslationLanguage;
  text: string;
}

export interface RunOnlineTranslateDependencies {
  endpoint?: string | undefined;
  fetch?: typeof fetch | undefined;
  googleEndpoint?: string | undefined;
  myMemoryEndpoint?: string | undefined;
  timeoutMs?: number | undefined;
}

function toOnlineLanguage(language: ScreenshotTranslationLanguage): string {
  switch (language) {
    case 'zh-CN':
      return 'zh-CN';
    case 'zh-TW':
      return 'zh-TW';
    case 'en-US':
      return 'en';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeTextForOnlineTranslation(
  text: string,
  sourceLanguage: ScreenshotTranslationLanguage,
): string {
  let normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=\S)/g, '$1 ');

  if (sourceLanguage === 'en-US') {
    for (let index = 0; index < 3; index += 1) {
      normalized = normalized
        .replace(/\b([B-HJ-Z])\s+([a-z]{2,})\b/g, '$1$2')
        .replace(/\b([A-Za-z]{3,})\s+([a-z])\b/g, '$1$2');
    }
  }

  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseMyMemoryTranslatedText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const responseData = value.responseData;

  if (!isRecord(responseData)) {
    return undefined;
  }

  return typeof responseData.translatedText === 'string'
    ? responseData.translatedText.trim()
    : undefined;
}

function parseGoogleTranslatedText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const segments = value[0];

  if (!Array.isArray(segments)) {
    return undefined;
  }

  const translatedText = segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')
    .trim();

  return translatedText.length > 0 ? translatedText : undefined;
}

function formatTranslationError(reason: unknown): string {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return 'Online translation timed out.';
  }

  return reason instanceof Error ? reason.message : 'Online translation failed.';
}

async function fetchJson(url: URL, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Online translation failed with HTTP ${response.status}.`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function translateWithGoogle({
  endpoint,
  fetchImpl,
  sourceLanguage,
  sourceText,
  targetLanguage,
  timeoutMs,
}: {
  endpoint: string;
  fetchImpl: typeof fetch;
  sourceLanguage: string;
  sourceText: string;
  targetLanguage: string;
  timeoutMs: number;
}): Promise<string> {
  const url = new URL(endpoint);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', sourceLanguage);
  url.searchParams.set('tl', targetLanguage);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', sourceText);

  const translatedText = parseGoogleTranslatedText(await fetchJson(url, fetchImpl, timeoutMs));

  if (!translatedText) {
    throw new Error('Online translation returned no text.');
  }

  return translatedText;
}

async function translateWithMyMemory({
  endpoint,
  fetchImpl,
  sourceLanguage,
  sourceText,
  targetLanguage,
  timeoutMs,
}: {
  endpoint: string;
  fetchImpl: typeof fetch;
  sourceLanguage: string;
  sourceText: string;
  targetLanguage: string;
  timeoutMs: number;
}): Promise<string> {
  const url = new URL(endpoint);
  url.searchParams.set('q', sourceText);
  url.searchParams.set('langpair', `${sourceLanguage}|${targetLanguage}`);

  const translatedText = parseMyMemoryTranslatedText(await fetchJson(url, fetchImpl, timeoutMs));

  if (!translatedText) {
    throw new Error('Online translation returned no text.');
  }

  return translatedText;
}

export async function runOnlineTranslate(
  request: OnlineTranslateRequest,
  dependencies: RunOnlineTranslateDependencies = {},
): Promise<ScreenshotTranslationResult> {
  const sourceText = normalizeTextForOnlineTranslation(request.text, request.sourceLanguage);

  if (sourceText.length === 0) {
    return {
      message: 'No OCR text found.',
      ocrLanguage: request.sourceLanguage,
      status: 'unavailable',
      targetLanguage: request.targetLanguage,
    };
  }

  const sourceLanguage = toOnlineLanguage(request.sourceLanguage);
  const targetLanguage = toOnlineLanguage(request.targetLanguage);

  if (sourceLanguage === targetLanguage) {
    return {
      ocrLanguage: request.sourceLanguage,
      sourceText,
      status: 'success',
      targetLanguage: request.targetLanguage,
      translatedText: sourceText,
    };
  }

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TRANSLATION_TIMEOUT_MS;

  if (typeof fetchImpl !== 'function') {
    return {
      message: 'Online translation is unavailable in this runtime.',
      ocrLanguage: request.sourceLanguage,
      status: 'unavailable',
      targetLanguage: request.targetLanguage,
    };
  }

  try {
    const translatedText = dependencies.endpoint
      ? await translateWithMyMemory({
          endpoint: dependencies.endpoint,
          fetchImpl,
          sourceLanguage,
          sourceText,
          targetLanguage,
          timeoutMs,
        })
      : await translateWithGoogle({
          endpoint: dependencies.googleEndpoint ?? GOOGLE_TRANSLATE_ENDPOINT,
          fetchImpl,
          sourceLanguage,
          sourceText,
          targetLanguage,
          timeoutMs,
        }).catch(() =>
          translateWithMyMemory({
            endpoint: dependencies.myMemoryEndpoint ?? MYMEMORY_ENDPOINT,
            fetchImpl,
            sourceLanguage,
            sourceText,
            targetLanguage,
            timeoutMs,
          }),
        );

    return {
      ocrLanguage: request.sourceLanguage,
      sourceText,
      status: 'success',
      targetLanguage: request.targetLanguage,
      translatedText,
    };
  } catch (reason) {
    return {
      message: formatTranslationError(reason),
      ocrLanguage: request.sourceLanguage,
      status: 'error',
      targetLanguage: request.targetLanguage,
    };
  }
}
