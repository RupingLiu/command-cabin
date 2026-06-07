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
      expect(script).toContain(`$RequestedLanguageTags = @('${language}')`);
      expect(script).toContain('$ResolvedLanguageTag');
      expect(script).toContain('Windows.Media.Ocr.OcrEngine');
      expect(script).toContain('AvailableRecognizerLanguages');
      expect(script).toContain('Resolve-OcrLanguage');
      expect(script).toContain('Await-WinRtOperation');
      expect(script).not.toContain('CommandCabinWinRtAsync');
      expect(script).toContain('C:\\Temp');
    },
  );

  it('generates Chinese Windows OCR language fallbacks for installed language packs', async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        language: 'zh-CN',
        lines: [],
        status: 'success',
        text: '',
      }),
    }));

    await runLocalOcr(
      { imageDataUrl: pngDataUrl, language: 'zh-CN' },
      {
        execFile,
        getTempPath: () => 'C:\\Temp',
        randomUUID: () => 'ocr-language-fallbacks',
        unlink: vi.fn(),
        writeFile: vi.fn(),
        writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
      },
    );

    const script = decodePowerShellCommand(execFile.mock.calls[0]?.[1] ?? []);

    expect(script).toContain("'zh-CN', 'zh-Hans-CN', 'zh-Hans', 'zh'");
    expect(script).toContain("'zh-TW', 'zh-Hant-TW', 'zh-Hant', 'zh'");
  });

  it('passes multiple requested OCR languages in one PowerShell command', async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        language: 'zh-CN',
        lines: ['Google News'],
        status: 'success',
        text: 'Google News',
      }),
    }));

    await runLocalOcr(
      {
        fallbackLanguages: ['zh-CN', 'zh-TW'],
        imageDataUrl: pngDataUrl,
        language: 'en-US',
      },
      {
        execFile,
        getTempPath: () => 'C:\\Temp',
        randomUUID: () => 'ocr-one-shot-fallback',
        unlink: vi.fn(),
        writeFile: vi.fn(),
        writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
      },
    );

    const script = decodePowerShellCommand(execFile.mock.calls[0]?.[1] ?? []);

    expect(script).toContain("$RequestedLanguageTags = @('en-US', 'zh-CN', 'zh-TW')");
    expect(script).toContain('foreach ($RequestedLanguageTag in $RequestedLanguageTags)');
  });

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

  it('parses OCR JSON from stdout even when PowerShell exits with an error', async () => {
    const execFile = vi.fn(async () => {
      const error = new Error('Command failed: powershell.exe -EncodedCommand ...') as Error & {
        stdout: string;
      };
      error.stdout = JSON.stringify({
        language: 'zh-CN',
        message: 'Windows OCR is not available for the selected language.',
        status: 'unavailable',
      });
      throw error;
    });

    await expect(
      runLocalOcr(
        { imageDataUrl: pngDataUrl, language: 'zh-CN' },
        {
          execFile,
          getTempPath: () => 'C:\\Temp',
          randomUUID: () => 'ocr-json-stdout',
          unlink: vi.fn(),
          writeFile: vi.fn(),
          writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
        },
      ),
    ).resolves.toEqual({
      language: 'zh-CN',
      message: 'Windows OCR is not available for the selected language.',
      status: 'unavailable',
    });
  });

  it('does not expose the full encoded PowerShell command when execution fails', async () => {
    const execFile = vi.fn(async () => {
      throw new Error('Command failed: powershell.exe -NoProfile -EncodedCommand AAAA');
    });

    await expect(
      runLocalOcr(
        { imageDataUrl: pngDataUrl, language: 'en-US' },
        {
          execFile,
          getTempPath: () => 'C:\\Temp',
          randomUUID: () => 'ocr-command-failed',
          unlink: vi.fn(),
          writeFile: vi.fn(),
          writePngFromDataUrl: vi.fn(() => Buffer.from('png')),
        },
      ),
    ).resolves.toEqual({
      language: 'en-US',
      message: 'Windows OCR failed while running PowerShell.',
      status: 'error',
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
