import { describe, expect, it, vi } from 'vitest';

import { normalizeTextForOnlineTranslation, runOnlineTranslate } from './onlineTranslate.js';

function createJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    json: async () => body,
    ok,
    status,
  } as Response;
}

describe('runOnlineTranslate', () => {
  it('normalizes common English OCR split-word artifacts before translating', () => {
    expect(
      normalizeTextForOnlineTranslation(
        "U pdates about Google N ews, organizing what's happening in the worl d tO help you",
        'en-US',
      ),
    ).toBe("Updates about Google News, organizing what's happening in the world tO help you");
  });

  it('uses the primary online translation endpoint by default', async () => {
    const fetch = vi.fn(async () =>
      createJsonResponse([[['有关 Google 新闻的更新', 'Updates about Google News']]]),
    );

    await expect(
      runOnlineTranslate(
        {
          sourceLanguage: 'en-US',
          targetLanguage: 'zh-CN',
          text: 'Updates about Google News',
        },
        {
          fetch,
          googleEndpoint: 'https://example.test/google',
        },
      ),
    ).resolves.toEqual({
      ocrLanguage: 'en-US',
      sourceText: 'Updates about Google News',
      status: 'success',
      targetLanguage: 'zh-CN',
      translatedText: '有关 Google 新闻的更新',
    });

    const url = fetch.mock.calls[0]?.[0];

    expect(url).toBeInstanceOf(URL);
    expect((url as URL).searchParams.get('sl')).toBe('en');
    expect((url as URL).searchParams.get('tl')).toBe('zh-CN');
    expect((url as URL).searchParams.get('q')).toBe('Updates about Google News');
  });

  it('calls the online translation endpoint with a language pair', async () => {
    const fetch = vi.fn(async () =>
      createJsonResponse({
        responseData: {
          translatedText: '你好',
        },
      }),
    );

    await expect(
      runOnlineTranslate(
        {
          sourceLanguage: 'en-US',
          targetLanguage: 'zh-CN',
          text: 'hello',
        },
        {
          endpoint: 'https://example.test/translate',
          fetch,
        },
      ),
    ).resolves.toEqual({
      ocrLanguage: 'en-US',
      sourceText: 'hello',
      status: 'success',
      targetLanguage: 'zh-CN',
      translatedText: '你好',
    });

    const url = fetch.mock.calls[0]?.[0];

    expect(url).toBeInstanceOf(URL);
    expect((url as URL).searchParams.get('q')).toBe('hello');
    expect((url as URL).searchParams.get('langpair')).toBe('en|zh-CN');
  });

  it('falls back to MyMemory when the primary endpoint fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({}, false, 503))
      .mockResolvedValueOnce(
        createJsonResponse({
          responseData: {
            translatedText: '你好',
          },
        }),
      );

    await expect(
      runOnlineTranslate(
        {
          sourceLanguage: 'en-US',
          targetLanguage: 'zh-CN',
          text: 'hello',
        },
        {
          fetch,
          googleEndpoint: 'https://example.test/google',
          myMemoryEndpoint: 'https://example.test/mymemory',
        },
      ),
    ).resolves.toMatchObject({
      status: 'success',
      translatedText: '你好',
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1]?.[0] as URL).searchParams.get('langpair')).toBe('en|zh-CN');
  });

  it('returns an unavailable result when there is no source text', async () => {
    await expect(
      runOnlineTranslate({
        sourceLanguage: 'en-US',
        targetLanguage: 'zh-CN',
        text: '   ',
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('maps online translation failures to error results', async () => {
    const fetch = vi.fn(async () => createJsonResponse({}, false, 503));

    await expect(
      runOnlineTranslate(
        {
          sourceLanguage: 'en-US',
          targetLanguage: 'zh-CN',
          text: 'hello',
        },
        {
          fetch,
        },
      ),
    ).resolves.toMatchObject({
      message: 'Online translation failed with HTTP 503.',
      status: 'error',
    });
  });
});
