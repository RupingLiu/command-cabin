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
      id: 'favorite.codex',
      source: 'app',
      title: 'Codex',
    });
    expect(getFileIcon).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not read native icons from unresolved shortcut files', async () => {
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
      id: 'favorite.codex',
      source: 'app',
      title: 'Codex',
    });
    expect(getFileIcon).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
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

  it('skips shortcut candidates when executable icon resolution fails', async () => {
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
      id: 'app.wechat',
      source: 'app',
      title: '微信',
    });

    expect(getFileIcon).toHaveBeenCalledOnce();
  });

  it('does not resolve shortcut fallbacks when a direct icon candidate is present', async () => {
    const getFileIcon = vi.fn(async () => {
      throw new Error('direct icon unavailable');
    });
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
      id: 'app.codex',
      source: 'app',
      title: 'Codex',
    });

    expect(getFileIcon).toHaveBeenCalledOnce();
    expect(resolveShortcut).not.toHaveBeenCalled();
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
