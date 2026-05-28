import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AboutSettings, openRepositoryFromSettings } from './AboutSettings.js';

const appInfo = {
  name: 'CommandCabin',
  version: '0.2.0',
  versions: {
    chrome: '140.0.0',
    electron: '39.0.0',
    node: '22.0.0',
  },
};

describe('AboutSettings', () => {
  it('renders version and up-to-date status', () => {
    const markup = renderToStaticMarkup(
      createElement(AboutSettings, {
        appInfo,
        state: {
          errorMessage: undefined,
          isChecking: false,
          isInstalling: false,
          status: {
            canCheck: true,
            canInstall: false,
            phase: 'up-to-date',
            version: '0.2.0',
          },
        },
      }),
    );

    expect(markup).toContain('CommandCabin v0.2.0');
    expect(markup).toContain('已连接 GitHub，当前是最新版本');
    expect(markup).toContain('检查更新');
    expect(markup).toContain('GitHub 仓库');
    expect(markup).not.toContain('重启安装');
  });

  it('renders download progress and install action', () => {
    const downloadingMarkup = renderToStaticMarkup(
      createElement(AboutSettings, {
        appInfo,
        state: {
          errorMessage: undefined,
          isChecking: false,
          isInstalling: false,
          status: {
            canCheck: false,
            canInstall: false,
            percent: 64,
            phase: 'downloading',
            version: '0.3.0',
          },
        },
      }),
    );

    expect(downloadingMarkup).toContain('64%');

    const downloadedMarkup = renderToStaticMarkup(
      createElement(AboutSettings, {
        appInfo,
        state: {
          errorMessage: undefined,
          isChecking: false,
          isInstalling: false,
          status: {
            canCheck: true,
            canInstall: true,
            phase: 'downloaded',
            version: '0.3.0',
          },
        },
      }),
    );

    expect(downloadedMarkup).toContain('重启安装');
  });

  it('does not render an install action for a stale downloaded update', () => {
    const markup = renderToStaticMarkup(
      createElement(AboutSettings, {
        appInfo,
        state: {
          errorMessage: undefined,
          isChecking: false,
          isInstalling: false,
          status: {
            canCheck: true,
            canInstall: false,
            downloadedVersion: '1.0.1',
            latestVersion: '1.0.2',
            phase: 'downloaded',
            version: '1.0.1',
          },
        },
      }),
    );

    expect(markup).toContain('版本 1.0.1 已下载');
    expect(markup).not.toContain('重启安装');
  });

  it('renders explicit GitHub connection feedback while checking', () => {
    const markup = renderToStaticMarkup(
      createElement(AboutSettings, {
        appInfo,
        state: {
          errorMessage: undefined,
          isChecking: true,
          isInstalling: false,
          status: {
            canCheck: false,
            canInstall: false,
            phase: 'checking',
          },
        },
      }),
    );

    expect(markup).toContain('正在连接 GitHub 检查更新');
    expect(markup).toContain('role="status"');
  });

  it('opens the repository through the settings API', async () => {
    const openRepository = vi.fn(async () => true);

    await expect(openRepositoryFromSettings({ openRepository })).resolves.toBe(true);

    expect(openRepository).toHaveBeenCalledOnce();
  });
});
