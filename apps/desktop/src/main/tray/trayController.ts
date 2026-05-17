import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';

import type { CommandCabinLanguage } from '@command-cabin/core';

export type CommandCabinTrayMenuItem =
  | {
      click: () => void;
      label: string;
      type?: 'normal';
    }
  | {
      type: 'separator';
    };

export interface CommandCabinTrayLogger {
  error: (message: string, error: unknown) => void;
}

export interface CommandCabinTrayController {
  readonly available: boolean;
  dispose: () => void;
  updateLanguage: (language: CommandCabinLanguage) => void;
}

export interface CommandCabinTray {
  destroy: () => void;
  on: (eventName: 'click', listener: () => void) => unknown;
  setContextMenu: (menu: unknown) => unknown;
  setToolTip: (tooltip: string) => unknown;
}

export interface CreateCommandCabinTrayControllerOptions {
  createMenu?: (items: CommandCabinTrayMenuItem[]) => unknown;
  createTray?: (iconPath: string) => CommandCabinTray;
  iconPath: string;
  language?: CommandCabinLanguage | undefined;
  logger?: CommandCabinTrayLogger;
  openSettings: () => void;
  quit: () => void;
  show: () => void;
  toggle: () => void;
}

const trayMenuLabels = {
  'en-US': {
    quit: 'Quit',
    settings: 'Settings',
    show: 'Show CommandCabin',
  },
  'zh-CN': {
    quit: '退出',
    settings: '设置',
    show: '显示 CommandCabin',
  },
  'zh-TW': {
    quit: '結束',
    settings: '設定',
    show: '顯示 CommandCabin',
  },
} satisfies Record<CommandCabinLanguage, { quit: string; settings: string; show: string }>;

export function resolveTrayIconPath(mainDirectory: string): string {
  return join(mainDirectory, '..', '..', 'build', 'icon.ico');
}

export function createCommandCabinTrayController({
  createMenu = (items) => Menu.buildFromTemplate(items as MenuItemConstructorOptions[]),
  createTray = (iconPath) =>
    new Tray(nativeImage.createFromPath(iconPath)) as unknown as CommandCabinTray,
  iconPath,
  language = 'zh-CN',
  logger = console,
  openSettings,
  quit,
  show,
  toggle,
}: CreateCommandCabinTrayControllerOptions): CommandCabinTrayController {
  let tray: CommandCabinTray | undefined;
  let currentLanguage = language;

  const buildMenu = () => {
    const labels = trayMenuLabels[currentLanguage];

    return createMenu([
      { label: labels.show, click: show },
      { label: labels.settings, click: openSettings },
      { type: 'separator' },
      { label: labels.quit, click: quit },
    ]);
  };

  try {
    tray = createTray(iconPath);
    tray.setToolTip('CommandCabin');
    tray.on('click', toggle);
    tray.setContextMenu(buildMenu());
  } catch (error) {
    logger.error('Failed to create CommandCabin tray.', error);
  }

  return {
    get available() {
      return tray !== undefined;
    },
    dispose: () => {
      tray?.destroy();
      tray = undefined;
    },
    updateLanguage: (nextLanguage) => {
      currentLanguage = nextLanguage;
      tray?.setContextMenu(buildMenu());
    },
  };
}
