import { describe, expect, it, vi } from 'vitest';

import { createWindowsAssociatedIconResolver } from './windowsAssociatedIconResolver.js';

describe('createWindowsAssociatedIconResolver', () => {
  it('extracts associated Windows executable icons as data URLs', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'data:image/png;base64,GB_REAL_ICON\n',
    }));
    const resolver = createWindowsAssociatedIconResolver({
      execFile,
      platform: 'win32',
      timeoutMs: 123,
    });

    await expect(
      resolver.resolve('C:\\Program Files\\GBChargeDoctor\\gbcharge-doctor.exe'),
    ).resolves.toBe('data:image/png;base64,GB_REAL_ICON');

    expect(execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-EncodedCommand', expect.any(String)]),
      {
        encoding: 'utf8',
        timeout: 123,
        windowsHide: true,
      },
    );
  });

  it('caches successful and empty extraction results by path', async () => {
    const execFile = vi.fn(async () => ({
      stdout: '',
    }));
    const resolver = createWindowsAssociatedIconResolver({ execFile, platform: 'win32' });

    await expect(resolver.resolve('C:\\Program Files\\NoIcon\\NoIcon.exe')).resolves.toBe(
      undefined,
    );
    await expect(resolver.resolve('C:\\Program Files\\NoIcon\\NoIcon.exe')).resolves.toBe(
      undefined,
    );

    expect(execFile).toHaveBeenCalledOnce();
  });

  it('caps in-memory associated icon caching for long-running sessions', async () => {
    const execFile = vi.fn(async (filePath: string) => ({
      stdout: `data:image/png;base64,${filePath.includes('App1') ? 'ONE' : 'OTHER'}\n`,
    }));
    const resolver = createWindowsAssociatedIconResolver({
      execFile,
      memoryCacheMaxEntries: 2,
      platform: 'win32',
    });

    await resolver.resolve('C:\\Program Files\\App1\\App1.exe');
    await resolver.resolve('C:\\Program Files\\App2\\App2.exe');
    await resolver.resolve('C:\\Program Files\\App3\\App3.exe');
    await resolver.resolve('C:\\Program Files\\App1\\App1.exe');

    expect(execFile).toHaveBeenCalledTimes(4);
  });
});
