import { createHash } from 'node:crypto';
import { win32 as path } from 'node:path';

import { cloneCommand } from '../command/commandJson.js';
import type { Command, CommandPayload } from '../command/types.js';
import {
  createWindowsStartMenuScanner,
  type StartMenuScanFailure,
  type StartMenuScanResult,
  type StartMenuShortcut,
} from './windows/startMenuScanner.js';
import type { AppIndexCache, AppIndexCacheSnapshot } from './indexCache.js';

export type { AppIndexCache, AppIndexCacheSnapshot } from './indexCache.js';

export interface AppIndexerScanner {
  scan: () => Promise<StartMenuScanResult>;
}

export interface AppIndexSnapshot {
  commands: Command[];
  failures: StartMenuScanFailure[];
  scannedAt: string;
  source: 'cache' | 'scan';
}

export interface AppIndexerOptions {
  scanner?: AppIndexerScanner;
  cache?: AppIndexCache;
  refreshIntervalMs?: number;
  now?: () => Date;
  onRefreshError?: (error: unknown) => void;
}

export interface AppIndexer {
  load: () => Promise<AppIndexSnapshot | undefined>;
  refresh: () => Promise<AppIndexSnapshot>;
  getCommands: () => Command[];
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
}

const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.com', '.bat', '.cmd']);
const COMMON_START_MENU_PARENT_NAMES = new Set(['programs', 'start menu', 'startmenu']);
const ICON_INDEX_ONLY_PATTERN = /^,\d+$/;

function normalizeCommandIdInput(shortcutPath: string): string {
  return shortcutPath.replaceAll('/', '\\').toLowerCase();
}

function createAppCommandId(shortcut: StartMenuShortcut): string {
  const digest = createHash('sha256')
    .update(normalizeCommandIdInput(shortcut.shortcutPath))
    .digest('hex')
    .slice(0, 12);

  return `app.${digest}`;
}

function addKeyword(keywords: string[], keyword: string | undefined): void {
  if (!keyword) {
    return;
  }

  const trimmedKeyword = keyword.trim();

  if (trimmedKeyword.length === 0 || keywords.includes(trimmedKeyword)) {
    return;
  }

  keywords.push(trimmedKeyword);
}

function getParentKeyword(shortcutPath: string): string | undefined {
  const parentName = path.basename(path.dirname(shortcutPath));

  if (!parentName || COMMON_START_MENU_PARENT_NAMES.has(parentName.toLowerCase())) {
    return undefined;
  }

  return parentName;
}

function createKeywords(shortcut: StartMenuShortcut): string[] {
  const keywords: string[] = [];

  addKeyword(keywords, shortcut.name);
  addKeyword(keywords, shortcut.name.toLowerCase());
  addKeyword(keywords, getParentKeyword(shortcut.shortcutPath));
  addKeyword(keywords, shortcut.targetPath);
  addKeyword(keywords, shortcut.appUserModelId);

  if (shortcut.targetPath === undefined && shortcut.appUserModelId === undefined) {
    addKeyword(keywords, shortcut.shortcutPath);
  }

  return keywords;
}

function isExecutableTarget(targetPath: string | undefined): targetPath is string {
  return (
    targetPath !== undefined && EXECUTABLE_EXTENSIONS.has(path.extname(targetPath).toLowerCase())
  );
}

function isUsefulIconPath(iconPath: string | undefined): iconPath is string {
  const trimmedIconPath = iconPath?.trim();

  return trimmedIconPath !== undefined && !ICON_INDEX_ONLY_PATTERN.test(trimmedIconPath);
}

function createOpenAppPayload(shortcut: StartMenuShortcut): CommandPayload {
  const payload: CommandPayload = {
    shortcutPath: shortcut.shortcutPath,
  };

  if (shortcut.appUserModelId !== undefined) {
    payload.appUserModelId = shortcut.appUserModelId;
  }

  if (shortcut.targetPath !== undefined) {
    payload.executablePath = shortcut.targetPath;
  }

  if (shortcut.arguments !== undefined) {
    payload.arguments = shortcut.arguments;
  }

  if (shortcut.workingDirectory !== undefined) {
    payload.workingDirectory = shortcut.workingDirectory;
  }

  return payload;
}

function createOpenPathPayload(shortcut: StartMenuShortcut): CommandPayload {
  return {
    path: shortcut.targetPath ?? shortcut.shortcutPath,
    shortcutPath: shortcut.shortcutPath,
  };
}

function createCommandFromShortcut(shortcut: StartMenuShortcut): Command {
  const opensApplication =
    shortcut.opensApplication === true ||
    shortcut.appUserModelId !== undefined ||
    isExecutableTarget(shortcut.targetPath);
  const subtitle = shortcut.targetPath ?? shortcut.appUserModelId ?? shortcut.shortcutPath;
  const command: Command = {
    id: createAppCommandId(shortcut),
    source: 'app',
    title: shortcut.name,
    subtitle,
    keywords: createKeywords(shortcut),
    action: opensApplication
      ? {
          type: 'open-app',
          payload: createOpenAppPayload(shortcut),
        }
      : {
          type: 'open-path',
          payload: createOpenPathPayload(shortcut),
        },
  };

  if (isUsefulIconPath(shortcut.iconPath)) {
    command.icon = shortcut.iconPath;
  }

  return command;
}

function cloneSnapshotCommands(commands: readonly Command[]): Command[] {
  return commands.map(cloneCommand);
}

function getStringPayloadValue(payload: CommandPayload, key: string): string | undefined {
  const value = payload[key];

  return typeof value === 'string' ? value : undefined;
}

function normalizeIdentityText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function normalizeIdentityPath(value: string | undefined): string {
  const trimmedValue = value?.trim();

  return trimmedValue ? normalizeCommandIdInput(trimmedValue) : '';
}

function createAppCommandIdentityKey(command: Command): string {
  if (command.source !== 'app' || command.action.type !== 'open-app') {
    return `id:${command.id}`;
  }

  const title = normalizeIdentityText(command.title);
  const payload = command.action.payload;
  const appUserModelId = normalizeIdentityText(getStringPayloadValue(payload, 'appUserModelId'));
  const executablePath = normalizeIdentityPath(getStringPayloadValue(payload, 'executablePath'));
  const commandArguments = normalizeIdentityText(getStringPayloadValue(payload, 'arguments'));
  const workingDirectory = normalizeIdentityPath(
    getStringPayloadValue(payload, 'workingDirectory'),
  );

  if (appUserModelId.length > 0) {
    return ['app-user-model-id', title, appUserModelId, commandArguments, workingDirectory].join(
      '|',
    );
  }

  if (executablePath.length > 0) {
    return ['executable', title, executablePath, commandArguments, workingDirectory].join('|');
  }

  return `id:${command.id}`;
}

function dedupeAppCommands(commands: readonly Command[]): Command[] {
  const seenIds = new Set<string>();
  const seenIdentityKeys = new Set<string>();
  const dedupedCommands: Command[] = [];

  for (const command of commands) {
    if (seenIds.has(command.id)) {
      continue;
    }

    const identityKey = createAppCommandIdentityKey(command);

    if (seenIdentityKeys.has(identityKey)) {
      continue;
    }

    seenIds.add(command.id);
    seenIdentityKeys.add(identityKey);
    dedupedCommands.push(cloneCommand(command));
  }

  return dedupedCommands;
}

function createSnapshotFromCache(snapshot: AppIndexCacheSnapshot): AppIndexSnapshot {
  return {
    commands: dedupeAppCommands(snapshot.commands),
    failures: [],
    scannedAt: snapshot.scannedAt,
    source: 'cache',
  };
}

export function createAppCommandsFromShortcuts(shortcuts: readonly StartMenuShortcut[]): Command[] {
  const commands: Command[] = [];

  for (const shortcut of shortcuts) {
    commands.push(createCommandFromShortcut(shortcut));
  }

  return dedupeAppCommands(commands);
}

function isCacheCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.startsWith('Invalid app index cache') ||
    error.message.startsWith('Invalid JSON in app index cache')
  );
}

export function createAppIndexer(options: AppIndexerOptions = {}): AppIndexer {
  const scanner = options.scanner ?? createWindowsStartMenuScanner();
  const now = options.now ?? (() => new Date());
  const refreshIntervalMs = options.refreshIntervalMs;
  let commands: Command[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let autoRefreshInFlight = false;

  async function refresh(): Promise<AppIndexSnapshot> {
    const scanResult = await scanner.scan();
    const nextCommands = createAppCommandsFromShortcuts(scanResult.shortcuts);
    const cacheSnapshot = await options.cache?.write(nextCommands);
    const snapshot: AppIndexSnapshot = {
      commands: cloneSnapshotCommands(nextCommands),
      failures: [...scanResult.failures],
      scannedAt: cacheSnapshot?.scannedAt ?? now().toISOString(),
      source: 'scan',
    };

    commands = cloneSnapshotCommands(snapshot.commands);

    return {
      ...snapshot,
      commands: cloneSnapshotCommands(snapshot.commands),
    };
  }

  async function runAutoRefresh(): Promise<void> {
    if (autoRefreshInFlight) {
      return;
    }

    autoRefreshInFlight = true;

    try {
      await refresh();
    } catch (error) {
      options.onRefreshError?.(error);
    } finally {
      autoRefreshInFlight = false;
    }
  }

  return {
    load: async () => {
      let cacheSnapshot: AppIndexCacheSnapshot | undefined;

      try {
        cacheSnapshot = await options.cache?.read();
      } catch (error) {
        if (isCacheCorruptionError(error)) {
          return refresh();
        }

        throw error;
      }

      if (!cacheSnapshot) {
        return undefined;
      }

      if (options.cache?.isStale(cacheSnapshot)) {
        return refresh();
      }

      const snapshot = createSnapshotFromCache(cacheSnapshot);
      commands = cloneSnapshotCommands(snapshot.commands);

      return snapshot;
    },
    refresh,
    getCommands: () => cloneSnapshotCommands(commands),
    startAutoRefresh: () => {
      if (timer !== undefined || refreshIntervalMs === undefined || refreshIntervalMs <= 0) {
        return;
      }

      timer = setInterval(() => {
        void runAutoRefresh();
      }, refreshIntervalMs);
    },
    stopAutoRefresh: () => {
      if (timer === undefined) {
        return;
      }

      clearInterval(timer);
      timer = undefined;
    },
  };
}
