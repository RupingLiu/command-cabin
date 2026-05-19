import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { win32 as path } from 'node:path';

import {
  LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY,
  isLauncherPinnedAppFavorite,
  type Command,
  type CommandPayload,
  type FavoriteRecord,
} from '@command-cabin/core';

import type { AppCandidate } from '../../shared/appCandidatesApi.js';
import type { LauncherPinnedAppInput } from './launcherCommandService.js';

export interface ResolvedAppShortcut {
  appUserModelId?: string | undefined;
  iconPath?: string | undefined;
  targetPath?: string | undefined;
  workingDirectory?: string | undefined;
}

export interface InternalAppCandidate extends AppCandidate {
  iconCandidates: string[];
}

export interface AppCandidateService {
  createPinnedAppInput: (candidate: AppCandidate) => LauncherPinnedAppInput;
  listCandidates: (query: string) => Promise<InternalAppCandidate[]>;
}

export interface AppCandidateServiceOptions {
  appCommands: () => readonly Command[];
  favorites: () => readonly FavoriteRecord[];
  listDesktopShortcuts: () => Promise<string[]>;
  resolveShortcut: (shortcutPath: string) => Promise<ResolvedAppShortcut>;
}

const EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe']);
const INVALID_ICON_LOCATION = ',0';
const MAX_CANDIDATES = 80;
const MAX_EMPTY_QUERY_CANDIDATES = 24;

function createCandidateId(source: AppCandidate['source'], identityPath: string): string {
  const digest = createHash('sha256')
    .update(`${source}\0${normalizePath(identityPath)}`)
    .digest('hex')
    .slice(0, 12);

  return `${source}.${digest}`;
}

function normalizePath(value: string | undefined): string {
  return value?.trim().replaceAll('/', '\\').toLowerCase() ?? '';
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function getStringPayloadValue(payload: CommandPayload, key: string): string | undefined {
  const value = payload[key];

  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isAppCommand(command: Command): boolean {
  return command.source === 'app' && command.action.type === 'open-app';
}

function isExecutablePath(value: string | undefined): value is string {
  return value !== undefined && EXECUTABLE_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function isUsefulIconPath(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value.trim() !== INVALID_ICON_LOCATION;
}

function addCandidateValue(values: string[], value: string | undefined): void {
  if (value === undefined || value.trim().length === 0 || values.includes(value)) {
    return;
  }

  values.push(value);
}

function createDesktopShortcutTitle(shortcutPath: string): string {
  return path
    .basename(shortcutPath, path.extname(shortcutPath))
    .replace(/\s+-\s+快捷方式$/u, '')
    .trim();
}

function getPinnedPathIdentities(favorites: readonly FavoriteRecord[]): Set<string> {
  const identities = new Set<string>();

  for (const favorite of favorites) {
    if (!isLauncherPinnedAppFavorite(favorite)) {
      continue;
    }

    identities.add(normalizePath(favorite.path));

    const executablePath = favorite.metadata[LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY];

    if (typeof executablePath === 'string') {
      identities.add(normalizePath(executablePath));
    }
  }

  identities.delete('');
  return identities;
}

function isAlreadyPinned(
  pinnedIdentities: ReadonlySet<string>,
  candidate: Pick<InternalAppCandidate, 'executablePath' | 'shortcutPath'>,
): boolean {
  return (
    pinnedIdentities.has(normalizePath(candidate.shortcutPath)) ||
    pinnedIdentities.has(normalizePath(candidate.executablePath))
  );
}

function createStartMenuCandidate(
  command: Command,
  pinnedIdentities: ReadonlySet<string>,
): InternalAppCandidate | undefined {
  if (!isAppCommand(command)) {
    return undefined;
  }

  const payload = command.action.payload;
  const shortcutPath = getStringPayloadValue(payload, 'shortcutPath');

  if (shortcutPath === undefined) {
    return undefined;
  }

  const executablePath = getStringPayloadValue(payload, 'executablePath');
  const iconCandidates: string[] = [];

  addCandidateValue(iconCandidates, command.icon);
  addCandidateValue(iconCandidates, executablePath);
  addCandidateValue(iconCandidates, command.subtitle);
  addCandidateValue(iconCandidates, shortcutPath);

  const candidate: InternalAppCandidate = {
    alreadyPinned: false,
    iconCandidates,
    id: createCandidateId('start-menu', shortcutPath),
    resolutionStatus: executablePath ? 'resolved' : 'unresolved-shortcut',
    shortcutPath,
    source: 'start-menu',
    subtitle: executablePath ?? command.subtitle ?? shortcutPath,
    title: command.title,
  };

  if (executablePath !== undefined) {
    candidate.executablePath = executablePath;
  }

  if (isUsefulIconPath(command.icon)) {
    candidate.iconPath = command.icon;
  } else if (executablePath !== undefined) {
    candidate.iconPath = executablePath;
  }

  candidate.alreadyPinned = isAlreadyPinned(pinnedIdentities, candidate);
  return candidate;
}

async function createDesktopCandidate(
  shortcutPath: string,
  pinnedIdentities: ReadonlySet<string>,
  resolveShortcut: (shortcutPath: string) => Promise<ResolvedAppShortcut>,
  resolveShortcutMetadata: boolean,
): Promise<InternalAppCandidate | undefined> {
  let resolvedShortcut: ResolvedAppShortcut | undefined;

  if (resolveShortcutMetadata) {
    try {
      resolvedShortcut = await resolveShortcut(shortcutPath);
    } catch {
      resolvedShortcut = undefined;
    }
  }

  const executablePath = isExecutablePath(resolvedShortcut?.targetPath)
    ? resolvedShortcut?.targetPath
    : undefined;
  const isUnresolvedShortcut = executablePath === undefined;

  if (
    resolvedShortcut?.targetPath !== undefined &&
    !isExecutablePath(resolvedShortcut.targetPath)
  ) {
    return undefined;
  }

  const iconPath = isUsefulIconPath(resolvedShortcut?.iconPath)
    ? resolvedShortcut?.iconPath
    : executablePath;
  const iconCandidates: string[] = [];

  addCandidateValue(iconCandidates, iconPath);
  addCandidateValue(iconCandidates, executablePath);
  addCandidateValue(iconCandidates, shortcutPath);

  const title = createDesktopShortcutTitle(shortcutPath);
  const candidate: InternalAppCandidate = {
    alreadyPinned: false,
    iconCandidates,
    id: createCandidateId('desktop', shortcutPath),
    resolutionStatus: isUnresolvedShortcut ? 'unresolved-shortcut' : 'resolved',
    shortcutPath,
    source: 'desktop',
    subtitle: executablePath ?? shortcutPath,
    title: title.length > 0 ? title : shortcutPath,
  };

  if (executablePath !== undefined) {
    candidate.executablePath = executablePath;
  }

  if (iconPath !== undefined) {
    candidate.iconPath = iconPath;
  }

  candidate.alreadyPinned = isAlreadyPinned(pinnedIdentities, candidate);
  return candidate;
}

function candidateMatchesQuery(candidate: InternalAppCandidate, query: string): boolean {
  const normalizedQuery = normalizeText(query);

  if (normalizedQuery.length === 0) {
    return true;
  }

  return [
    candidate.title,
    candidate.subtitle,
    candidate.shortcutPath,
    candidate.executablePath,
  ].some((value) => value !== undefined && normalizeText(value).includes(normalizedQuery));
}

function getCandidateIdentity(candidate: InternalAppCandidate): string {
  const executableIdentity = normalizePath(candidate.executablePath);

  if (executableIdentity.length > 0) {
    return `exe:${executableIdentity}`;
  }

  return `shortcut:${normalizePath(candidate.shortcutPath)}`;
}

function dedupeCandidates(candidates: readonly InternalAppCandidate[]): InternalAppCandidate[] {
  const seenIdentities = new Set<string>();
  const deduped: InternalAppCandidate[] = [];

  for (const candidate of candidates) {
    const identity = getCandidateIdentity(candidate);

    if (seenIdentities.has(identity)) {
      continue;
    }

    seenIdentities.add(identity);
    deduped.push(candidate);
  }

  return deduped;
}

export async function listShortcutFilesInDirectories(
  directories: readonly string[],
): Promise<string[]> {
  const shortcuts: string[] = [];

  for (const directory of directories) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
          shortcuts.push(path.join(directory, entry.name));
        }
      }
    } catch {
      continue;
    }
  }

  return shortcuts;
}

export function createAppCandidateService({
  appCommands,
  favorites,
  listDesktopShortcuts,
  resolveShortcut,
}: AppCandidateServiceOptions): AppCandidateService {
  return {
    createPinnedAppInput: (candidate) => ({
      appPath: candidate.shortcutPath,
      executablePath: candidate.executablePath,
      iconPath: candidate.iconPath ?? candidate.executablePath ?? candidate.shortcutPath,
      title: candidate.title,
    }),
    listCandidates: async (query) => {
      const pinnedIdentities = getPinnedPathIdentities(favorites());
      const normalizedQuery = normalizeText(query);
      const shouldResolveDesktopShortcuts = normalizedQuery.length > 0;
      const desktopShortcutPaths = (await listDesktopShortcuts()).filter(
        (shortcutPath) =>
          normalizedQuery.length === 0 ||
          normalizeText(createDesktopShortcutTitle(shortcutPath)).includes(normalizedQuery) ||
          normalizeText(shortcutPath).includes(normalizedQuery),
      );
      const desktopCandidates = await Promise.all(
        desktopShortcutPaths.map((shortcutPath) =>
          createDesktopCandidate(
            shortcutPath,
            pinnedIdentities,
            resolveShortcut,
            shouldResolveDesktopShortcuts,
          ),
        ),
      );
      const startMenuCandidates = appCommands()
        .map((command) => createStartMenuCandidate(command, pinnedIdentities))
        .filter((candidate): candidate is InternalAppCandidate => candidate !== undefined);

      const maxCandidates =
        normalizedQuery.length === 0 ? MAX_EMPTY_QUERY_CANDIDATES : MAX_CANDIDATES;

      return dedupeCandidates([
        ...desktopCandidates.filter(
          (candidate): candidate is InternalAppCandidate => candidate !== undefined,
        ),
        ...startMenuCandidates,
      ])
        .filter((candidate) => candidateMatchesQuery(candidate, query))
        .slice(0, maxCandidates);
    },
  };
}
