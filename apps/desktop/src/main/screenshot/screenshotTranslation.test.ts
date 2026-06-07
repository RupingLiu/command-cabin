import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => 'C:\\Temp',
  },
  nativeImage: {
    createFromDataURL: () => ({
      toPNG: () => Buffer.from('png'),
    }),
  },
}));

import {
  getScreenshotTranslationOcrLanguageCandidates,
  getScreenshotTranslationSourceLanguage,
  runScreenshotTranslation,
} from './screenshotTranslation.js';

const imageDataUrl = 'data:image/png;base64,AAAA';

describe('getScreenshotTranslationOcrLanguageCandidates', () => {
  it('tries the preferred OCR language before target-language fallbacks', () => {
    expect(
      getScreenshotTranslationOcrLanguageCandidates({
        ocrLanguage: 'en-US',
        targetLanguage: 'zh-CN',
      }),
    ).toEqual(['en-US', 'zh-CN', 'zh-TW']);
    expect(
      getScreenshotTranslationOcrLanguageCandidates({
        ocrLanguage: 'zh-CN',
        targetLanguage: 'en-US',
      }),
    ).toEqual(['zh-CN', 'en-US']);
  });
});

describe('getScreenshotTranslationSourceLanguage', () => {
  it('keeps the intended source language even when OCR falls back to another engine', () => {
    expect(
      getScreenshotTranslationSourceLanguage(
        {
          ocrLanguage: 'en-US',
          targetLanguage: 'zh-CN',
        },
        'zh-CN',
      ),
    ).toBe('en-US');
  });

  it('uses the actual OCR language when source and target are intentionally the same', () => {
    expect(
      getScreenshotTranslationSourceLanguage(
        {
          ocrLanguage: 'zh-CN',
          targetLanguage: 'zh-CN',
        },
        'zh-TW',
      ),
    ).toBe('zh-TW');
  });
});

describe('runScreenshotTranslation', () => {
  it('falls back to the target OCR language when the preferred OCR language is unavailable', async () => {
    const runOcr = vi.fn(async () => ({
      language: 'zh-CN' as const,
      lines: ['Google News'],
      status: 'success' as const,
      text: 'Google News',
    }));
    const translate = vi.fn(async () => ({
      ocrLanguage: 'en-US' as const,
      sourceText: 'Google News',
      status: 'success' as const,
      targetLanguage: 'zh-CN' as const,
      translatedText: '谷歌新闻',
    }));

    await expect(
      runScreenshotTranslation(
        {
          imageDataUrl,
          ocrLanguage: 'en-US',
          targetLanguage: 'zh-CN',
        },
        { runOcr, translate },
      ),
    ).resolves.toMatchObject({
      ocrLanguage: 'en-US',
      status: 'success',
      translatedText: '谷歌新闻',
    });

    expect(runOcr).toHaveBeenCalledTimes(1);
    expect(runOcr).toHaveBeenCalledWith({
      fallbackLanguages: ['zh-CN', 'zh-TW'],
      imageDataUrl,
      language: 'en-US',
    });
    expect(translate).toHaveBeenCalledWith({
      sourceLanguage: 'en-US',
      targetLanguage: 'zh-CN',
      text: 'Google News',
    });
  });

  it('does not translate when one-shot OCR returns no text', async () => {
    const runOcr = vi.fn(async () => ({
      language: 'en-US' as const,
      lines: [],
      status: 'success' as const,
      text: '   ',
    }));
    const translate = vi.fn();

    await expect(
      runScreenshotTranslation(
        {
          imageDataUrl,
          ocrLanguage: 'en-US',
          targetLanguage: 'zh-CN',
        },
        { runOcr, translate },
      ),
    ).resolves.toEqual({
      message: 'No OCR text found.',
      ocrLanguage: 'en-US',
      status: 'unavailable',
      targetLanguage: 'zh-CN',
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('returns a no-text result when OCR produces empty text', async () => {
    const runOcr = vi.fn(async ({ language }) => ({
      language,
      lines: [],
      status: 'success' as const,
      text: '',
    }));

    await expect(
      runScreenshotTranslation(
        {
          imageDataUrl,
          ocrLanguage: 'en-US',
          targetLanguage: 'zh-CN',
        },
        { runOcr, translate: vi.fn() },
      ),
    ).resolves.toEqual({
      message: 'No OCR text found.',
      ocrLanguage: 'en-US',
      status: 'unavailable',
      targetLanguage: 'zh-CN',
    });
  });
});
