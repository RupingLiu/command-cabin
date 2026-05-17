import { win32 as path } from 'node:path';

import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';

export interface AppIconNativeImage {
  toDataURL: () => string;
}

export interface AppIconResolvedShortcut {
  iconPath?: string | undefined;
  targetPath?: string | undefined;
}

export interface AppIconResolverOptions {
  getFileIcon: (path: string) => Promise<AppIconNativeImage>;
  iconTimeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
  resolveShortcut?: ((path: string) => Promise<AppIconResolvedShortcut>) | undefined;
  shortcutTimeoutMs?: number;
}

export interface AppIconResolver {
  resolveSearchResultIcon: (
    result: LauncherCommandSearchResult,
  ) => Promise<LauncherCommandSearchResult>;
}

const ICON_INDEX_SUFFIX_PATTERN = /,\d+$/;
const ENV_VAR_PATTERN = /%([^%]+)%/g;
const DEFAULT_ICON_TIMEOUT_MS = 700;
const DEFAULT_SHORTCUT_TIMEOUT_MS = 250;

function isImageDataUrl(icon: string): boolean {
  return icon.startsWith('data:image/');
}

export function getIconFilePathCandidate(icon: string | undefined): string | undefined {
  if (!icon) {
    return undefined;
  }

  if (isImageDataUrl(icon)) {
    return icon;
  }

  const candidate = icon.replace(ICON_INDEX_SUFFIX_PATTERN, '').trim();

  return candidate.length > 0 ? candidate : undefined;
}

function expandEnvironmentVariables(path: string): string {
  return path.replace(ENV_VAR_PATTERN, (_match, variableName: string) => {
    const value = process.env[variableName] ?? process.env[variableName.toUpperCase()];
    return value ?? `%${variableName}%`;
  });
}

function createPublicSearchResult(
  result: LauncherCommandSearchResult,
): LauncherCommandSearchResult {
  const publicResult = { ...result };
  delete publicResult.iconCandidates;

  return publicResult;
}

export function createAppIconResolver({
  getFileIcon,
  iconTimeoutMs = DEFAULT_ICON_TIMEOUT_MS,
  logger = console,
  resolveShortcut,
  shortcutTimeoutMs = DEFAULT_SHORTCUT_TIMEOUT_MS,
}: AppIconResolverOptions): AppIconResolver {
  const iconCache = new Map<string, string>();
  const failedIconPaths = new Set<string>();
  const shortcutCandidateCache = new Map<string, string[]>();
  const failedShortcutPaths = new Set<string>();

  async function getFileIconDataUrl(iconPath: string): Promise<string | undefined> {
    let didTimeout = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const iconPromise = getFileIcon(iconPath)
      .then((image) => image.toDataURL())
      .catch((error) => {
        if (didTimeout) {
          return undefined;
        }

        throw error;
      });
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => {
        didTimeout = true;
        resolve(undefined);
      }, iconTimeoutMs);
    });
    const dataUrl = await Promise.race([iconPromise, timeoutPromise]);

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    if (didTimeout) {
      failedIconPaths.add(iconPath);
      logger.warn('Timed out resolving app icon.', new Error(`Icon path: ${iconPath}`));
    }

    return dataUrl;
  }

  async function resolveIconDataUrl(
    candidates: readonly (string | undefined)[],
  ): Promise<string | undefined> {
    for (const icon of await expandShortcutCandidates(candidates)) {
      const candidate = getIconFilePathCandidate(icon);

      if (!candidate) {
        continue;
      }

      if (isImageDataUrl(candidate)) {
        return candidate;
      }

      const iconPath = expandEnvironmentVariables(candidate);
      const cachedIcon = iconCache.get(iconPath);

      if (cachedIcon) {
        return cachedIcon;
      }

      if (failedIconPaths.has(iconPath)) {
        continue;
      }

      try {
        const dataUrl = await getFileIconDataUrl(iconPath);

        if (dataUrl !== undefined) {
          iconCache.set(iconPath, dataUrl);
          return dataUrl;
        }
      } catch (error) {
        failedIconPaths.add(iconPath);
        logger.warn('Failed to resolve app icon.', error);
      }
    }

    return undefined;
  }

  function isShortcutPath(iconPath: string): boolean {
    return path.extname(iconPath).toLowerCase() === '.lnk';
  }

  function hasDirectIconCandidate(candidates: readonly (string | undefined)[]): boolean {
    return candidates.some((icon) => {
      const candidate = getIconFilePathCandidate(icon);

      if (!candidate) {
        return false;
      }

      if (isImageDataUrl(candidate)) {
        return true;
      }

      return !isShortcutPath(expandEnvironmentVariables(candidate));
    });
  }

  async function getShortcutCandidates(shortcutPath: string): Promise<string[]> {
    const cachedCandidates = shortcutCandidateCache.get(shortcutPath);

    if (cachedCandidates !== undefined) {
      return cachedCandidates;
    }

    if (resolveShortcut === undefined || failedShortcutPaths.has(shortcutPath)) {
      return [];
    }

    try {
      const resolvedShortcut = await resolveShortcutData(shortcutPath);

      if (resolvedShortcut === undefined) {
        failedShortcutPaths.add(shortcutPath);
        return [];
      }

      const candidates: string[] = [];

      for (const candidate of [
        resolvedShortcut.iconPath,
        resolvedShortcut.targetPath,
        shortcutPath,
      ]) {
        if (candidate !== undefined && !candidates.includes(candidate)) {
          candidates.push(candidate);
        }
      }

      shortcutCandidateCache.set(shortcutPath, candidates);
      return candidates;
    } catch (error) {
      failedShortcutPaths.add(shortcutPath);
      logger.warn('Failed to resolve app shortcut icon candidates.', error);
      return [];
    }
  }

  async function resolveShortcutData(
    shortcutPath: string,
  ): Promise<AppIconResolvedShortcut | undefined> {
    if (resolveShortcut === undefined) {
      return undefined;
    }

    let didTimeout = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const shortcutPromise = resolveShortcut(shortcutPath).catch((error) => {
      if (didTimeout) {
        return undefined;
      }

      throw error;
    });
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => {
        didTimeout = true;
        resolve(undefined);
      }, shortcutTimeoutMs);
    });
    const resolvedShortcut = await Promise.race([shortcutPromise, timeoutPromise]);

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    if (didTimeout) {
      logger.warn(
        'Timed out resolving app shortcut icon candidates.',
        new Error(`Shortcut path: ${shortcutPath}`),
      );
    }

    return resolvedShortcut;
  }

  async function expandShortcutCandidates(
    candidates: readonly (string | undefined)[],
  ): Promise<string[]> {
    const expandedCandidates: string[] = [];
    const shouldResolveShortcuts = !hasDirectIconCandidate(candidates);

    for (const icon of candidates) {
      const candidate = getIconFilePathCandidate(icon);

      if (!candidate) {
        continue;
      }

      if (isImageDataUrl(candidate)) {
        expandedCandidates.push(candidate);
        continue;
      }

      const iconPath = expandEnvironmentVariables(candidate);
      const nextCandidates = isShortcutPath(iconPath)
        ? shouldResolveShortcuts
          ? await getShortcutCandidates(iconPath)
          : []
        : [iconPath];

      for (const nextCandidate of nextCandidates) {
        if (!expandedCandidates.includes(nextCandidate)) {
          expandedCandidates.push(nextCandidate);
        }
      }
    }

    return expandedCandidates;
  }

  return {
    resolveSearchResultIcon: async (result) => {
      const publicResult = createPublicSearchResult(result);

      if (result.source !== 'app') {
        return publicResult;
      }

      const dataUrl = await resolveIconDataUrl(
        result.iconCandidates && result.iconCandidates.length > 0
          ? result.iconCandidates
          : [result.icon, result.subtitle],
      );

      return dataUrl ? { ...publicResult, icon: dataUrl } : publicResult;
    },
  };
}
