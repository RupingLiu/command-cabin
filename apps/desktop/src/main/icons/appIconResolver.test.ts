import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppIconResolver, getIconFilePathCandidate } from './appIconResolver.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('getIconFilePathCandidate', () => {
  it('uses the path before a Windows icon index suffix', () => {
    expect(getIconFilePathCandidate('C:\\Program Files\\WPS Office\\ksolaunch.exe,0')).toBe(
      'C:\\Program Files\\WPS Office\\ksolaunch.exe',
    );
  });
});

describe('createAppIconResolver', () => {
  it('keeps app results usable when native icon resolution stalls', async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const resolver = createAppIconResolver({
      getFileIcon: vi.fn(() => new Promise(() => undefined)),
      iconTimeoutMs: 25,
      logger,
    });
    const resultPromise = resolver.resolveSearchResultIcon({
      iconCandidates: ['C:\\Program Files\\Broken App\\Broken.exe'],
      id: 'app.broken',
      score: 1,
      source: 'app',
      title: 'Broken App',
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(
      Promise.race([resultPromise, Promise.resolve('still-pending')]),
    ).resolves.toMatchObject({
      id: 'app.broken',
      source: 'app',
      title: 'Broken App',
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('returns cached data URLs for app search results', async () => {
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,WPS',
    }));
    const resolver = createAppIconResolver({ getFileIcon });

    await expect(
      resolver.resolveSearchResultIcon({
        id: 'app.wps',
        icon: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
        score: 1,
        source: 'app',
        title: 'WPS Office',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,WPS',
    });

    await resolver.resolveSearchResultIcon({
      id: 'app.wps',
      icon: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
      score: 1,
      source: 'app',
      title: 'WPS Office',
    });

    expect(getFileIcon).toHaveBeenCalledOnce();
  });

  it('uses stored app result icons before resolving native icons', async () => {
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,CODEX',
    }));
    const iconDataUrlCache = {
      read: vi.fn(async () => 'data:image/png;base64,CACHED_CODEX'),
      write: vi.fn(async () => undefined),
    };
    const resolver = createAppIconResolver({
      getFileIcon,
      iconDataUrlCache,
    });

    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: ['C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe'],
        id: 'app.codex',
        score: 1,
        source: 'app',
        title: 'Codex',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,CACHED_CODEX',
    });

    expect(iconDataUrlCache.read).toHaveBeenCalledWith(
      expect.stringMatching(/^app-result:app\.codex:/),
    );
    expect(getFileIcon).not.toHaveBeenCalled();
  });

  it('stores resolved app result icons for future resolver instances', async () => {
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,CODEX',
    }));
    const iconDataUrlCache = {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };
    const resolver = createAppIconResolver({
      getFileIcon,
      iconDataUrlCache,
    });

    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: ['C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe'],
        id: 'app.codex',
        score: 1,
        source: 'app',
        title: 'Codex',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,CODEX',
    });

    expect(iconDataUrlCache.write).toHaveBeenCalledWith(
      expect.stringMatching(/^app-result:app\.codex:/),
      'data:image/png;base64,CODEX',
    );
  });

  it('does not store icons resolved while shortcut expansion is using weak fallbacks', async () => {
    vi.useFakeTimers();
    const getFileIcon = vi.fn(async (iconPath: string) => ({
      toDataURL: () => `data:image/png;base64,${iconPath.endsWith('.exe') ? 'EXE' : 'LNK'}`,
    }));
    const iconDataUrlCache = {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };
    const resolver = createAppIconResolver({
      getFileIcon,
      iconDataUrlCache,
      logger: {
        warn: vi.fn(),
      },
      resolveShortcut: vi.fn(() => new Promise(() => undefined)),
      shortcutTimeoutMs: 25,
    });
    const resultPromise = resolver.resolveSearchResultIcon({
      iconCandidates: [
        'C:\\Users\\Ada\\AppData\\Local\\Programs\\Slow\\Slow.exe',
        'C:\\Users\\Ada\\Desktop\\Slow.lnk',
      ],
      id: 'app.slow',
      score: 1,
      source: 'app',
      title: 'Slow',
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toMatchObject({
      icon: 'data:image/png;base64,EXE',
    });
    expect(iconDataUrlCache.write).not.toHaveBeenCalled();
  });

  it('resolves shortcut candidates before reading native icons', async () => {
    const getFileIcon = vi.fn(async (path: string) => ({
      toDataURL: () => `data:image/png;base64,${path.endsWith('Codex.exe') ? 'CODEX' : 'LNK'}`,
    }));
    const resolver = createAppIconResolver({
      getFileIcon,
      resolveShortcut: vi.fn(async () => ({
        iconPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe,0',
        targetPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
      })),
    });

    await expect(
      resolver.resolveSearchResultIcon({
        favoriteId: 'favorite-codex',
        iconCandidates: ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
        id: 'favorite.codex',
        score: 1,
        source: 'app',
        title: 'Codex',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,CODEX',
    });

    expect(getFileIcon).toHaveBeenCalledWith(
      'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
    );
  });

  it('keeps app results usable when shortcut resolution stalls', async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,LNK',
    }));
    const resolver = createAppIconResolver({
      getFileIcon,
      logger,
      resolveShortcut: vi.fn(() => new Promise(() => undefined)),
      shortcutTimeoutMs: 25,
    });
    const resultPromise = resolver.resolveSearchResultIcon({
      favoriteId: 'favorite-codex',
      iconCandidates: ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
      id: 'favorite.codex',
      score: 1,
      source: 'app',
      title: 'Codex',
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(
      Promise.race([resultPromise, Promise.resolve('still-pending')]),
    ).resolves.toMatchObject({
      favoriteId: 'favorite-codex',
      icon: 'data:image/png;base64,LNK',
      id: 'favorite.codex',
      source: 'app',
      title: 'Codex',
    });
    expect(getFileIcon).toHaveBeenCalledWith('C:\\Users\\Ada\\Desktop\\Codex.lnk');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('retries executable icon paths after a timeout instead of poisoning the cache', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const resolver = createAppIconResolver({
      getFileIcon: vi.fn(() => {
        attempt += 1;

        if (attempt === 1) {
          return new Promise(() => undefined);
        }

        return Promise.resolve({
          toDataURL: () => 'data:image/png;base64,RECOVERED',
        });
      }),
      iconTimeoutMs: 25,
      logger: {
        warn: vi.fn(),
      },
    });
    const firstResultPromise = resolver.resolveSearchResultIcon({
      iconCandidates: ['C:\\Program Files\\Slow\\Slow.exe'],
      id: 'app.slow',
      score: 1,
      source: 'app',
      title: 'Slow',
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(firstResultPromise).resolves.not.toHaveProperty('icon');
    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: ['C:\\Program Files\\Slow\\Slow.exe'],
        id: 'app.slow',
        score: 1,
        source: 'app',
        title: 'Slow',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,RECOVERED',
    });
  });

  it('does not keep timed-out shortcut expansions as permanent weak fallbacks', async () => {
    vi.useFakeTimers();
    let shortcutAttempts = 0;
    const getFileIcon = vi.fn(async (iconPath: string) => ({
      toDataURL: () => `data:image/png;base64,${iconPath.endsWith('.lnk') ? 'LNK' : 'EXE'}`,
    }));
    const resolver = createAppIconResolver({
      getFileIcon,
      logger: {
        warn: vi.fn(),
      },
      resolveShortcut: vi.fn(() => {
        shortcutAttempts += 1;

        if (shortcutAttempts === 1) {
          return new Promise(() => undefined);
        }

        return Promise.resolve({
          targetPath: 'C:\\Program Files\\Slow\\Slow.exe',
        });
      }),
      shortcutTimeoutMs: 25,
    });
    const firstResultPromise = resolver.resolveSearchResultIcon({
      iconCandidates: ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Slow.lnk'],
      id: 'app.slow',
      score: 1,
      source: 'app',
      title: 'Slow',
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(firstResultPromise).resolves.toMatchObject({
      icon: 'data:image/png;base64,LNK',
    });
    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Slow.lnk'],
        id: 'app.slow',
        score: 1,
        source: 'app',
        title: 'Slow',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,EXE',
    });
  });

  it('does not show generic shortcut icons when executable candidates are available', async () => {
    vi.useFakeTimers();
    const getFileIcon = vi.fn((iconPath: string) => {
      if (iconPath.endsWith('.exe')) {
        return new Promise(() => undefined);
      }

      return Promise.resolve({
        toDataURL: () => 'data:image/png;base64,LNK',
      });
    });
    const resolver = createAppIconResolver({
      getFileIcon,
      iconTimeoutMs: 25,
      logger: {
        warn: vi.fn(),
      },
      resolveShortcut: vi.fn(async () => {
        throw new Error('shortcut unavailable');
      }),
    });
    const resultPromise = resolver.resolveSearchResultIcon({
      iconCandidates: [
        'C:\\Program Files\\Slow\\Slow.exe',
        'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Slow.lnk',
      ],
      id: 'app.slow',
      score: 1,
      source: 'app',
      title: 'Slow',
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.not.toHaveProperty('icon');
    expect(getFileIcon).toHaveBeenCalledWith('C:\\Program Files\\Slow\\Slow.exe');
    expect(getFileIcon).not.toHaveBeenCalledWith(
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Slow.lnk',
    );
  });

  it('waits long enough for normal Windows shortcut metadata by default', async () => {
    vi.useFakeTimers();
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,LNK',
    }));
    const resolveAppUserModelIcon = vi.fn(async () => 'data:image/png;base64,CODEX');
    const resolver = createAppIconResolver({
      getFileIcon,
      resolveAppUserModelIcon,
      resolveShortcut: vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
                iconPath: ',0',
              });
            }, 325);
          }),
      ),
    });
    const resultPromise = resolver.resolveSearchResultIcon({
      iconCandidates: ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
      id: 'app.codex',
      score: 1,
      source: 'app',
      title: 'Codex',
    });

    await vi.advanceTimersByTimeAsync(325);

    await expect(resultPromise).resolves.toMatchObject({
      icon: 'data:image/png;base64,CODEX',
    });
  });

  it('uses native shortcut icons when shortcut resolution fails', async () => {
    const logger = { warn: vi.fn() };
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,LNK',
    }));
    const resolver = createAppIconResolver({
      getFileIcon,
      logger,
      resolveShortcut: vi.fn(async () => {
        throw new Error('shortcut unavailable');
      }),
    });

    await expect(
      resolver.resolveSearchResultIcon({
        favoriteId: 'favorite-codex',
        iconCandidates: ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
        id: 'favorite.codex',
        score: 1,
        source: 'app',
        title: 'Codex',
      }),
    ).resolves.toMatchObject({
      favoriteId: 'favorite-codex',
      icon: 'data:image/png;base64,LNK',
      id: 'favorite.codex',
      source: 'app',
      title: 'Codex',
    });
    expect(getFileIcon).toHaveBeenCalledWith('C:\\Users\\Ada\\Desktop\\Codex.lnk');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('uses native shortcut icons when no shortcut resolver is configured', async () => {
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,LNK',
    }));
    const resolver = createAppIconResolver({ getFileIcon });

    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
        id: 'app.codex',
        score: 1,
        source: 'app',
        title: 'Codex',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,LNK',
    });

    expect(getFileIcon).toHaveBeenCalledWith('C:\\Users\\Ada\\Desktop\\Codex.lnk');
  });

  it('uses AppUserModelID icons before native shortcut icons', async () => {
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,GENERIC_SHORTCUT',
    }));
    const resolveAppUserModelIcon = vi.fn(async () => 'data:image/png;base64,CODEX');
    const resolver = createAppIconResolver({
      getFileIcon,
      resolveAppUserModelIcon,
      resolveShortcut: vi.fn(async () => ({
        appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
        iconPath: ',0',
      })),
    });

    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: ['C:\\Users\\Ada\\Desktop\\Codex.lnk'],
        id: 'app.codex',
        score: 1,
        source: 'app',
        title: 'Codex',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,CODEX',
    });

    expect(resolveAppUserModelIcon).toHaveBeenCalledWith('OpenAI.Codex_2p2nqsd0c76g0!App');
    expect(getFileIcon).not.toHaveBeenCalled();
  });

  it('uses direct AppUserModelID icon candidates from AppsFolder commands', async () => {
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,GENERIC',
    }));
    const resolveAppUserModelIcon = vi.fn(async () => 'data:image/png;base64,ONEPASSWORD');
    const resolver = createAppIconResolver({
      getFileIcon,
      resolveAppUserModelIcon,
    });

    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: ['DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword'],
        id: 'app.1password',
        score: 1,
        source: 'app',
        title: '1Password',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,ONEPASSWORD',
    });

    expect(resolveAppUserModelIcon).toHaveBeenCalledWith(
      'DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
    );
    expect(getFileIcon).not.toHaveBeenCalled();
  });

  it('uses packaged application image assets before generic executable icons', async () => {
    const getFileIcon = vi.fn(async () => ({
      toDataURL: () => 'data:image/png;base64,GENERIC_EXE',
    }));
    const fileExists = vi.fn(async (iconPath: string) =>
      iconPath.endsWith('\\resources\\app\\static\\logo-256x256.png'),
    );
    const readImageDataUrl = vi.fn(async () => 'data:image/png;base64,UGIT');
    const resolver = createAppIconResolver({
      fileExists,
      getFileIcon,
      readImageDataUrl,
      resolveShortcut: vi.fn(async () => ({
        iconPath: 'C:\\Users\\Ada\\AppData\\Local\\UGit\\UGit.exe,0',
        targetPath: 'C:\\Users\\Ada\\AppData\\Local\\UGit\\UGit.exe',
        workingDirectory: 'C:\\Users\\Ada\\AppData\\Local\\UGit\\app-5.47.1',
      })),
    });

    await expect(
      resolver.resolveSearchResultIcon({
        iconCandidates: [
          'C:\\Users\\Ada\\AppData\\Local\\UGit\\UGit.exe,0',
          'C:\\Users\\Ada\\AppData\\Local\\UGit\\UGit.exe',
          'C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\UGit.lnk',
        ],
        id: 'app.ugit',
        score: 1,
        source: 'app',
        title: 'UGit',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,UGIT',
    });

    expect(readImageDataUrl).toHaveBeenCalledWith(
      'C:\\Users\\Ada\\AppData\\Local\\UGit\\app-5.47.1\\resources\\app\\static\\logo-256x256.png',
    );
    expect(getFileIcon).not.toHaveBeenCalled();
  });

  it('skips invalid icon locations and tries executable candidates before shortcuts', async () => {
    const getFileIcon = vi.fn(async (path: string) => ({
      toDataURL: () => `data:image/png;base64,${path.endsWith('.exe') ? 'EXE' : 'SHORTCUT'}`,
    }));
    const resolver = createAppIconResolver({ getFileIcon });

    await expect(
      resolver.resolveSearchResultIcon({
        id: 'app.wechat',
        icon: ',0',
        iconCandidates: [
          ',0',
          'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
          'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\微信\\微信.lnk',
        ],
        score: 1,
        source: 'app',
        subtitle: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
        title: '微信',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,EXE',
    });

    expect(getFileIcon).toHaveBeenCalledOnce();
    expect(getFileIcon).toHaveBeenCalledWith('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe');
  });

  it('uses shortcut candidates when executable icon resolution fails', async () => {
    const getFileIcon = vi.fn(async (path: string) => {
      if (path.endsWith('.exe')) {
        throw new Error('executable icon unavailable');
      }

      return {
        toDataURL: () => 'data:image/png;base64,SHORTCUT',
      };
    });
    const resolver = createAppIconResolver({
      getFileIcon,
      logger: {
        warn: vi.fn(),
      },
    });

    await expect(
      resolver.resolveSearchResultIcon({
        id: 'app.wechat',
        iconCandidates: [
          'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
          'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\微信\\微信.lnk',
        ],
        score: 1,
        source: 'app',
        title: '微信',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,SHORTCUT',
    });

    expect(getFileIcon).toHaveBeenCalledTimes(2);
  });

  it('uses direct executable candidates before weak shortcut fallbacks when shortcut resolution fails', async () => {
    const getFileIcon = vi.fn(async (iconPath: string) => ({
      toDataURL: () => `data:image/png;base64,${iconPath.endsWith('.lnk') ? 'LNK' : 'EXE'}`,
    }));
    const resolver = createAppIconResolver({
      getFileIcon,
      logger: {
        warn: vi.fn(),
      },
      resolveShortcut: vi.fn(async () => {
        throw new Error('shortcut unavailable');
      }),
    });

    await expect(
      resolver.resolveSearchResultIcon({
        id: 'app.wps',
        iconCandidates: [
          'C:\\Program Files\\WPS Office\\ksolaunch.exe',
          'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\WPS Office.lnk',
        ],
        score: 1,
        source: 'app',
        title: 'WPS Office',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,EXE',
    });

    expect(getFileIcon).toHaveBeenCalledWith('C:\\Program Files\\WPS Office\\ksolaunch.exe');
  });

  it('resolves shortcut metadata even when a direct icon candidate is present', async () => {
    const getFileIcon = vi.fn(async (iconPath: string) => ({
      toDataURL: () => `data:image/png;base64,${iconPath.endsWith('.lnk') ? 'LNK' : 'EXE'}`,
    }));
    const resolveShortcut = vi.fn(async () => ({
      targetPath: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
    }));
    const resolver = createAppIconResolver({
      getFileIcon,
      logger: {
        warn: vi.fn(),
      },
      resolveShortcut,
    });

    await expect(
      resolver.resolveSearchResultIcon({
        id: 'app.codex',
        iconCandidates: [
          'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
          'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        ],
        score: 1,
        source: 'app',
        title: 'Codex',
      }),
    ).resolves.toMatchObject({
      icon: 'data:image/png;base64,EXE',
    });

    expect(getFileIcon).toHaveBeenCalledWith(
      'C:\\Users\\Ada\\AppData\\Local\\Programs\\Codex\\Codex.exe',
    );
    expect(resolveShortcut).toHaveBeenCalledOnce();
  });

  it('leaves non-app results and icon failures usable', async () => {
    const logger = { warn: vi.fn() };
    const resolver = createAppIconResolver({
      getFileIcon: vi.fn(async () => {
        throw new Error('icon unavailable');
      }),
      logger,
    });

    await expect(
      resolver.resolveSearchResultIcon({
        id: 'app.wps',
        icon: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
        score: 1,
        source: 'app',
        title: 'WPS Office',
      }),
    ).resolves.toMatchObject({
      icon: 'C:\\Program Files\\WPS Office\\ksolaunch.exe,0',
    });

    await expect(
      resolver.resolveSearchResultIcon({
        id: 'system.settings',
        score: 1,
        source: 'system',
        title: 'Open Settings',
      }),
    ).resolves.toMatchObject({
      source: 'system',
      title: 'Open Settings',
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
