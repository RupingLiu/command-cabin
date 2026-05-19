import { win32 as path } from 'node:path';

import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';

export interface AppIconNativeImage {
  toDataURL: () => string;
}

export interface AppIconResolvedShortcut {
  appUserModelId?: string | undefined;
  iconPath?: string | undefined;
  targetPath?: string | undefined;
  workingDirectory?: string | undefined;
}

export interface AppIconResolverOptions {
  fileExists?: ((path: string) => Promise<boolean>) | undefined;
  getFileIcon: (path: string) => Promise<AppIconNativeImage>;
  iconTimeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
  readImageDataUrl?: ((path: string) => Promise<string | undefined>) | undefined;
  resolveAppUserModelIcon?: ((appUserModelId: string) => Promise<string | undefined>) | undefined;
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
const DEFAULT_SHORTCUT_TIMEOUT_MS = 750;
const IMAGE_FILE_EXTENSIONS = new Set(['.ico', '.jpg', '.jpeg', '.png', '.webp']);
const PACKAGED_APP_ASSET_PATHS = [
  ['resources', 'app', 'static', 'logo-256x256.png'],
  ['resources', 'app', 'static', 'icon-logo.ico'],
  ['resources', 'app', 'static', 'icon.png'],
  ['resources', 'app', 'build', 'icon.ico'],
  ['resources', 'app', 'assets', 'icon.png'],
  ['resources', 'app', 'icon.png'],
  ['resources', 'app', 'icon.ico'],
];

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
  fileExists,
  getFileIcon,
  iconTimeoutMs = DEFAULT_ICON_TIMEOUT_MS,
  logger = console,
  readImageDataUrl,
  resolveAppUserModelIcon,
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
        const dataUrl = (await getImageDataUrl(iconPath)) ?? (await getFileIconDataUrl(iconPath));

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

  async function getImageDataUrl(iconPath: string): Promise<string | undefined> {
    if (readImageDataUrl === undefined || !isImageFilePath(iconPath)) {
      return undefined;
    }

    return readImageDataUrl(iconPath);
  }

  function isImageFilePath(iconPath: string): boolean {
    return IMAGE_FILE_EXTENSIONS.has(path.extname(iconPath).toLowerCase());
  }

  function isShortcutPath(iconPath: string): boolean {
    return path.extname(iconPath).toLowerCase() === '.lnk';
  }

  function createShortcutFallbackCandidates(shortcutPath: string): string[] {
    return [shortcutPath];
  }

  async function getShortcutCandidates(shortcutPath: string): Promise<string[]> {
    const cachedCandidates = shortcutCandidateCache.get(shortcutPath);

    if (cachedCandidates !== undefined) {
      return cachedCandidates;
    }

    if (resolveShortcut === undefined || failedShortcutPaths.has(shortcutPath)) {
      return createShortcutFallbackCandidates(shortcutPath);
    }

    try {
      const resolvedShortcut = await resolveShortcutData(shortcutPath);

      if (resolvedShortcut === undefined) {
        const fallbackCandidates = createShortcutFallbackCandidates(shortcutPath);
        return fallbackCandidates;
      }

      const candidates: string[] = [];

      const appUserModelIcon = await getAppUserModelIcon(resolvedShortcut.appUserModelId);

      for (const candidate of [
        appUserModelIcon,
        ...(await getPackagedAppAssetCandidates(resolvedShortcut)),
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
      const fallbackCandidates = createShortcutFallbackCandidates(shortcutPath);
      shortcutCandidateCache.set(shortcutPath, fallbackCandidates);
      return fallbackCandidates;
    }
  }

  async function getAppUserModelIcon(
    appUserModelId: string | undefined,
  ): Promise<string | undefined> {
    if (appUserModelId === undefined || resolveAppUserModelIcon === undefined) {
      return undefined;
    }

    try {
      return await resolveAppUserModelIcon(appUserModelId);
    } catch (error) {
      logger.warn('Failed to resolve AppUserModelID app icon.', error);
      return undefined;
    }
  }

  async function getPackagedAppAssetCandidates(
    resolvedShortcut: AppIconResolvedShortcut,
  ): Promise<string[]> {
    if (fileExists === undefined || readImageDataUrl === undefined) {
      return [];
    }

    const rootDirectories = new Set<string>();

    if (resolvedShortcut.workingDirectory !== undefined) {
      rootDirectories.add(resolvedShortcut.workingDirectory);
    }
    if (resolvedShortcut.targetPath !== undefined) {
      rootDirectories.add(path.dirname(resolvedShortcut.targetPath));
    }

    const existingCandidates: string[] = [];

    for (const rootDirectory of rootDirectories) {
      for (const assetPath of PACKAGED_APP_ASSET_PATHS) {
        const candidate = path.join(rootDirectory, ...assetPath);

        try {
          if ((await fileExists(candidate)) && !existingCandidates.includes(candidate)) {
            existingCandidates.push(candidate);
          }
        } catch (error) {
          logger.warn('Failed to check packaged app icon candidate.', error);
        }
      }
    }

    return existingCandidates;
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
    const dataUrlCandidates: string[] = [];
    const directCandidates: string[] = [];
    const shortcutCandidates: string[] = [];

    for (const icon of candidates) {
      const candidate = getIconFilePathCandidate(icon);

      if (!candidate) {
        continue;
      }

      if (isImageDataUrl(candidate)) {
        dataUrlCandidates.push(candidate);
        continue;
      }

      const iconPath = expandEnvironmentVariables(candidate);

      if (isShortcutPath(iconPath)) {
        shortcutCandidates.push(iconPath);
      } else {
        directCandidates.push(iconPath);
      }
    }

    pushUniqueCandidates(expandedCandidates, dataUrlCandidates);

    if (resolveShortcut !== undefined) {
      const weakShortcutFallbackCandidates: string[] = [];

      for (const shortcutPath of shortcutCandidates) {
        const nextCandidates = await getShortcutCandidates(shortcutPath);

        if (isWeakShortcutExpansion(shortcutPath, nextCandidates)) {
          pushUniqueCandidates(weakShortcutFallbackCandidates, nextCandidates);
          continue;
        }

        pushUniqueCandidates(expandedCandidates, nextCandidates);
      }

      pushUniqueCandidates(expandedCandidates, directCandidates);
      if (directCandidates.length === 0) {
        pushUniqueCandidates(expandedCandidates, weakShortcutFallbackCandidates);
      }
    } else {
      pushUniqueCandidates(expandedCandidates, directCandidates);
      pushUniqueCandidates(expandedCandidates, shortcutCandidates);
    }

    return expandedCandidates;
  }

  function isWeakShortcutExpansion(shortcutPath: string, candidates: readonly string[]): boolean {
    const meaningfulCandidates = candidates
      .map((candidate) => getIconFilePathCandidate(candidate))
      .filter((candidate): candidate is string => candidate !== undefined);

    if (meaningfulCandidates.length === 0) {
      return true;
    }

    const normalizedShortcutPath = normalizeCandidatePath(shortcutPath);

    return meaningfulCandidates.every((candidate) => {
      if (isImageDataUrl(candidate)) {
        return false;
      }

      return normalizeCandidatePath(candidate) === normalizedShortcutPath;
    });
  }

  function normalizeCandidatePath(candidate: string): string {
    return expandEnvironmentVariables(candidate).trim().toLowerCase();
  }

  function pushUniqueCandidates(target: string[], candidates: readonly string[]): void {
    for (const candidate of candidates) {
      if (!target.includes(candidate)) {
        target.push(candidate);
      }
    }
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
