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
    const request = fetch.mock.calls[0]?.[1];
    const body = request?.body as URLSearchParams;

    expect(url).toBeInstanceOf(URL);
    expect((url as URL).searchParams.get('q')).toBeNull();
    expect(request?.method).toBe('POST');
    expect(body.get('sl')).toBe('en');
    expect(body.get('tl')).toBe('zh-CN');
    expect(body.get('q')).toBe('Updates about Google News');
  });

  it('joins intra-line Han OCR separators in the request and retains the original', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      createJsonResponse([[['謝謝', '谢谢']]]),
    );
    const original = '谢 谢 你 API 文 档\n下 一 行';
    const result = await runOnlineTranslate(
      {
        detectSourceLanguage: true,
        sourceLanguage: 'zh-CN',
        targetLanguage: 'zh-TW',
        text: original,
      },
      { fetch },
    );
    const body = fetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get('q')).toBe('谢谢你 API 文档\n下一行');
    expect(result).toMatchObject({ sourceText: original, translatedText: '謝謝' });
    expect(normalizeTextForOnlineTranslation('中  文\r\nN\news', 'en-US')).toBe('中 文\nN\news');
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
    const request = fetch.mock.calls[0]?.[1];
    const body = request?.body as URLSearchParams;

    expect(url).toBeInstanceOf(URL);
    expect((url as URL).searchParams.get('q')).toBeNull();
    expect(request?.method).toBe('POST');
    expect(body.get('q')).toBe('hello');
    expect(body.get('langpair')).toBe('en|zh-CN');
  });

  it('uses the selected target even if it matches the OCR engine language', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      createJsonResponse([[['Hello', '你好']]]),
    );
    const result = await runOnlineTranslate(
      {
        detectSourceLanguage: true,
        sourceLanguage: 'en-US',
        targetLanguage: 'en-US',
        text: '你好',
      },
      { fetch },
    );

    expect(result).toMatchObject({ translatedText: 'Hello', targetLanguage: 'en-US' });
    const body = fetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get('sl')).toBe('auto');
    expect(body.get('tl')).toBe('en');
  });

  it('does not send OCR text to a second provider when the primary endpoint fails', async () => {
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
          googleEndpoint: 'https://example.test/google',
          myMemoryEndpoint: 'https://example.test/mymemory',
        },
      ),
    ).resolves.toMatchObject({ status: 'error' });

    expect(fetch).toHaveBeenCalledTimes(1);
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

  it('does not send OCR text beyond the online translation size limit', async () => {
    const fetch = vi.fn();

    await expect(
      runOnlineTranslate(
        {
          sourceLanguage: 'en-US',
          targetLanguage: 'zh-CN',
          text: 'x'.repeat(2_001),
        },
        { fetch },
      ),
    ).resolves.toMatchObject({
      message: expect.stringContaining('2000-character'),
      status: 'unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
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
