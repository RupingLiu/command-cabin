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
});
