import { describe, expect, it, vi } from 'vitest';

import { runLocalOcr } from './localOcr.js';

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

const pngDataUrl = 'data:image/png;base64,AAAA';

function decodePowerShellCommand(args: readonly string[]): string {
  const encodedCommand = args[5];

  return Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le');
}

describe('runLocalOcr', () => {
  it.each(['zh-CN', 'zh-TW', 'en-US'] as const)(
    'generates a Windows Runtime OCR PowerShell command for %s',
    async (language) => {
      const execFile = vi.fn(async () => ({
        stdout: JSON.stringify({
          language,
          lines: [],
          status: 'success',
          text: '',
        }),
      }));

      await runLocalOcr(
        { imageDataUrl: pngDataUrl, language },
        {
          execFile,
          getTempPath: () => 'C:\\Temp',
          randomUUID: () => `ocr-${language}`,
          unlink: vi.fn(),
          writeFile: vi.fn(),
          writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
        },
      );

      expect(execFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining([
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          expect.any(String),
        ]),
        {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        },
      );
      const script = decodePowerShellCommand(execFile.mock.calls[0]?.[1] ?? []);
      expect(script).toContain(`[Windows.Globalization.Language]::new('${language}')`);
      expect(script).toContain('Windows.Media.Ocr.OcrEngine');
      expect(script).toContain('C:\\Temp');
    },
  );

  it('joins recognized text lines with newlines', async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        language: 'en-US',
        lines: ['first line', 'second line'],
        status: 'success',
      }),
    }));

    await expect(
      runLocalOcr(
        { imageDataUrl: pngDataUrl, language: 'en-US' },
        {
          execFile,
          getTempPath: () => 'C:\\Temp',
          randomUUID: () => 'ocr-success',
          unlink: vi.fn(),
          writeFile: vi.fn(),
          writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
        },
      ),
    ).resolves.toEqual({
      language: 'en-US',
      lines: ['first line', 'second line'],
      status: 'success',
      text: 'first line\nsecond line',
    });
  });

  it('maps unavailable PowerShell execution to a clear unavailable result', async () => {
    const execFile = vi.fn(async () => {
      const error = new Error('spawn powershell.exe ENOENT') as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    });

    await expect(
      runLocalOcr(
        { imageDataUrl: pngDataUrl, language: 'zh-CN' },
        {
          execFile,
          getTempPath: () => 'C:\\Temp',
          randomUUID: () => 'ocr-unavailable',
          unlink: vi.fn(),
          writeFile: vi.fn(),
          writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
        },
      ),
    ).resolves.toMatchObject({
      language: 'zh-CN',
      status: 'unavailable',
    });
  });

  it('maps Windows Runtime unavailable output to a clear unavailable result', async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        language: 'zh-TW',
        message: 'Windows OCR is not available on this device.',
        status: 'unavailable',
      }),
    }));

    await expect(
      runLocalOcr(
        { imageDataUrl: pngDataUrl, language: 'zh-TW' },
        {
          execFile,
          getTempPath: () => 'C:\\Temp',
          randomUUID: () => 'ocr-winrt-unavailable',
          unlink: vi.fn(),
          writeFile: vi.fn(),
          writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
        },
      ),
    ).resolves.toEqual({
      language: 'zh-TW',
      message: 'Windows OCR is not available on this device.',
      status: 'unavailable',
    });
  });
});
