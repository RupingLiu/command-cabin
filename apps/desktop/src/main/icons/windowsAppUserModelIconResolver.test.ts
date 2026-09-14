import { describe, expect, it, vi } from 'vitest';

import { createWindowsAppUserModelIconResolver } from './windowsAppUserModelIconResolver.js';

describe('createWindowsAppUserModelIconResolver', () => {
  it('loads an AppX package icon data URL by AppUserModelID', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'data:image/png;base64,CODEX\r\n',
    }));
    const resolver = createWindowsAppUserModelIconResolver({
      execFile,
      timeoutMs: 1234,
    });

    await expect(resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App')).resolves.toBe(
      'data:image/png;base64,CODEX',
    );

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0]?.[0]).toBe('powershell.exe');
    expect(execFile.mock.calls[0]?.[2]).toEqual({
      windowsHide: true,
      timeout: 1234,
      encoding: 'utf8',
    });
    const encodedCommand = execFile.mock.calls[0]?.[1][5];
    const script = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le');
    expect(script).toContain('Get-AppxPackage');
    expect(script).toContain('AppxManifest.xml');
    expect(script).toContain('Square150x150Logo');
  });

  it('checks packaged app image resource directories when manifest logo paths omit them', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'data:image/png;base64,ONEPASSWORD',
    }));
    const resolver = createWindowsAppUserModelIconResolver({ execFile });

    await resolver.resolve('DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword');

    const encodedCommand = execFile.mock.calls[0]?.[1][5];
    const script = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le');
    expect(script).toContain("Join-Path $package.InstallLocation 'images'");
    expect(script).toContain('$candidateRoots');
  });

  it('skips invalid AppUserModelIDs without shelling out', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'data:image/png;base64,CODEX',
    }));
    const resolver = createWindowsAppUserModelIconResolver({ execFile });

    await expect(resolver.resolve('Codex')).resolves.toBeUndefined();

    expect(execFile).not.toHaveBeenCalled();
  });

  it('caches resolved AppUserModelID icons', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'data:image/png;base64,CODEX',
    }));
    const resolver = createWindowsAppUserModelIconResolver({ execFile });

    await resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App');
    await resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App');

    expect(execFile).toHaveBeenCalledOnce();
  });

  it('caps in-memory AppUserModelID icon caching for long-running sessions', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'data:image/png;base64,CODEX',
    }));
    const resolver = createWindowsAppUserModelIconResolver({
      execFile,
      memoryCacheMaxEntries: 2,
    });

    await resolver.resolve('Vendor.App1_family!App');
    await resolver.resolve('Vendor.App2_family!App');
    await resolver.resolve('Vendor.App3_family!App');
    await resolver.resolve('Vendor.App1_family!App');

    expect(execFile).toHaveBeenCalledTimes(4);
  });

  it('uses enough time for packaged app icon resolution by default', async () => {
    const execFile = vi.fn(async () => ({
      stdout: '',
    }));
    const resolver = createWindowsAppUserModelIconResolver({
      execFile,
    });

    await resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App');

    expect(execFile.mock.calls[0]?.[2]).toMatchObject({
      timeout: 3_000,
    });
  });

  it('fetches the AppX package list once and serves repeat resolutions from cache', async () => {
    const execFile = vi.fn(async () => ({
      stdout: [
        'PACKAGE\tOpenAI.Codex_2p2nqsd0c76g0\tC:\\Program Files\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0',
        'data:image/png;base64,CODEX',
      ].join('\n'),
    }));
    const resolver = createWindowsAppUserModelIconResolver({ execFile });

    await expect(resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App')).resolves.toBe(
      'data:image/png;base64,CODEX',
    );
    await expect(resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App')).resolves.toBe(
      'data:image/png;base64,CODEX',
    );

    expect(execFile).toHaveBeenCalledOnce();
    const encodedCommand = execFile.mock.calls[0]?.[1][5];
    const script = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le');
    expect(script).toContain('PACKAGE');
  });

  it('reuses cached package install locations to skip package enumeration', async () => {
    const installLocation = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0';
    const execFile = vi.fn(async () => ({
      stdout: [`PACKAGE\tOpenAI.Codex_2p2nqsd0c76g0\t${installLocation}`, 'data:image/png;base64,CODEX'].join(
        '\n',
      ),
    }));
    const resolver = createWindowsAppUserModelIconResolver({ execFile });

    await resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App');
    await expect(resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!OtherAppId')).resolves.toBe(
      'data:image/png;base64,CODEX',
    );

    expect(execFile).toHaveBeenCalledTimes(2);
    const encodedInstallLocation = Buffer.from(installLocation, 'utf8').toString('base64');
    const firstCommand = execFile.mock.calls[0]?.[1][5];
    const firstScript = Buffer.from(firstCommand ?? '', 'base64').toString('utf16le');
    expect(firstScript).not.toContain(encodedInstallLocation);
    const secondCommand = execFile.mock.calls[1]?.[1][5];
    const secondScript = Buffer.from(secondCommand ?? '', 'base64').toString('utf16le');
    expect(secondScript).toContain(encodedInstallLocation);
  });

  it('keeps the cached package list when a single icon resolution fails', async () => {
    const logger = { warn: vi.fn() };
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: [
          'PACKAGE\tOpenAI.Codex_2p2nqsd0c76g0\tC:\\Program Files\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0',
          'PACKAGE\tVendor.Other_family\tC:\\Program Files\\WindowsApps\\Vendor.Other_family',
          'data:image/png;base64,CODEX',
        ].join('\n'),
      })
      .mockRejectedValueOnce(new Error('powershell failed'))
      .mockResolvedValueOnce({
        stdout: 'data:image/png;base64,OTHER',
      });
    const resolver = createWindowsAppUserModelIconResolver({ execFile, logger });

    await expect(resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App')).resolves.toBe(
      'data:image/png;base64,CODEX',
    );
    await expect(resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!OtherAppId')).resolves.toBeUndefined();
    await expect(resolver.resolve('Vendor.Other_family!App')).resolves.toBe(
      'data:image/png;base64,OTHER',
    );

    expect(execFile).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('skips icon resolution for packages missing from the cached list', async () => {
    const execFile = vi.fn(async () => ({
      stdout: [
        'PACKAGE\tOpenAI.Codex_2p2nqsd0c76g0\tC:\\Program Files\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0',
        'data:image/png;base64,CODEX',
      ].join('\n'),
    }));
    const resolver = createWindowsAppUserModelIconResolver({ execFile });

    await resolver.resolve('OpenAI.Codex_2p2nqsd0c76g0!App');
    await expect(resolver.resolve('Vendor.NotInstalled_family!App')).resolves.toBeUndefined();

    expect(execFile).toHaveBeenCalledOnce();
  });
});
