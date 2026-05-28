import { createHash } from 'node:crypto';
import { win32 as path } from 'node:path';

import type { LauncherCommandSearchResult } from '../../shared/launcherApi.js';
import { addBoundedSetEntry, setBoundedMapEntry } from './boundedMemoryCache.js';

export interface AppIconNativeImage {
  toDataURL: () => string;
}

export interface AppIconResolvedShortcut {
  appUserModelId?: string | undefined;
  iconPath?: string | undefined;
  targetPath?: string | undefined;
  workingDirectory?: string | undefined;
}

export interface AppIconDataUrlCache {
  read: (key: string) => Promise<string | undefined>;
  write: (key: string, dataUrl: string) => Promise<void>;
}

export interface AppIconResolverOptions {
  fileExists?: ((path: string) => Promise<boolean>) | undefined;
  getFileIcon: (path: string) => Promise<AppIconNativeImage>;
  iconDataUrlCache?: AppIconDataUrlCache | undefined;
  memoryCacheMaxEntries?: number | undefined;
  iconTimeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
  readImageDataUrl?: ((path: string) => Promise<string | undefined>) | undefined;
  resolveAssociatedFileIcon?: ((path: string) => Promise<string | undefined>) | undefined;
  resolveAppUserModelIcon?: ((appUserModelId: string) => Promise<string | undefined>) | undefined;
  resolveShortcut?: ((path: string) => Promise<AppIconResolvedShortcut>) | undefined;
  shortcutTimeoutMs?: number;
}

export interface AppIconResolver {
  resolveCachedSearchResultIcon: (
    result: LauncherCommandSearchResult,
  ) => Promise<LauncherCommandSearchResult>;
  resolveSearchResultIcon: (
    result: LauncherCommandSearchResult,
  ) => Promise<LauncherCommandSearchResult>;
  warmSearchResultIcon: (result: LauncherCommandSearchResult) => Promise<void>;
}

const ICON_INDEX_SUFFIX_PATTERN = /,\d+$/;
const ENV_VAR_PATTERN = /%([^%]+)%/g;
const DEFAULT_ICON_TIMEOUT_MS = 700;
const DEFAULT_SHORTCUT_TIMEOUT_MS = 750;
const ASSOCIATED_ICON_FALLBACK_PNG_BYTE_THRESHOLD = 1_200;
const IMAGE_FILE_EXTENSIONS = new Set(['.ico', '.jpg', '.jpeg', '.png', '.webp']);
const EXECUTABLE_ICON_EXTENSIONS = new Set(['.com', '.exe']);
const ICON_INDEX_ONLY_PATTERN = /^,\d+$/;
const RESULT_ICON_CACHE_HASH_LENGTH = 16;
const RESULT_ICON_CACHE_VERSION = 'app-result-v3';
const WINDOWS_APPS_FOLDER_CANDIDATE_PATTERN = /^shell:AppsFolder[\\/](.+)$/i;
const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 96;
const PACKAGED_APP_ASSET_PATHS = [
  ['resources', 'logo.ico'],
  ['resources', 'logo.png'],
  ['resources', 'icon.ico'],
  ['resources', 'icon.png'],
  ['resources', 'app.ico'],
  ['resources', 'app.png'],
  ['resources', 'app', 'static', 'logo-256x256.png'],
  ['resources', 'app', 'static', 'icon-logo.ico'],
  ['resources', 'app', 'static', 'icon.png'],
  ['resources', 'app', 'build', 'icon.ico'],
  ['resources', 'app', 'assets', 'icon.png'],
  ['resources', 'app', 'icon.png'],
  ['resources', 'app', 'icon.ico'],
];

interface ExpandedIconCandidates {
  candidates: ExpandedIconCandidate[];
  hasInvalidIconLocationCandidate: boolean;
}

interface ExpandedIconCandidate {
  cacheable: boolean;
  icon: string;
}

interface ResolvedIconDataUrl {
  cacheable: boolean;
  dataUrl: string;
}

function isImageDataUrl(icon: string): boolean {
  return icon.startsWith('data:image/');
}

function isAppUserModelIdCandidate(icon: string): boolean {
  const separatorIndex = icon.indexOf('!');

  return (
    separatorIndex > 0 &&
    separatorIndex < icon.length - 1 &&
    !icon.includes('\\') &&
    !icon.includes('/')
  );
}

function getAppUserModelIdCandidate(icon: string): string | undefined {
  const shellAppsFolderMatch = WINDOWS_APPS_FOLDER_CANDIDATE_PATTERN.exec(icon.trim());
  const candidate = shellAppsFolderMatch?.[1] ?? icon;

  return isAppUserModelIdCandidate(candidate) ? candidate : undefined;
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

function getResultIconCandidates(result: LauncherCommandSearchResult): (string | undefined)[] {
  return result.iconCandidates && result.iconCandidates.length > 0
    ? result.iconCandidates
    : [result.icon, result.subtitle];
}

function createResultIconCacheKey(result: LauncherCommandSearchResult): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(getResultIconCandidates(result)))
    .digest('hex')
    .slice(0, RESULT_ICON_CACHE_HASH_LENGTH);

  return `${RESULT_ICON_CACHE_VERSION}:${result.id}:${fingerprint}`;
}

export function createAppIconResolver({
  fileExists,
  getFileIcon,
  iconDataUrlCache,
  memoryCacheMaxEntries = DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
  iconTimeoutMs = DEFAULT_ICON_TIMEOUT_MS,
  logger = console,
  readImageDataUrl,
  resolveAssociatedFileIcon,
  resolveAppUserModelIcon,
  resolveShortcut,
  shortcutTimeoutMs = DEFAULT_SHORTCUT_TIMEOUT_MS,
}: AppIconResolverOptions): AppIconResolver {
  const iconCache = new Map<string, string>();
  const failedIconPaths = new Set<string>();
  const shortcutCandidateCache = new Map<string, string[]>();
  const failedShortcutPaths = new Set<string>();
  const pendingResultIconResolutions = new Map<string, Promise<void>>();

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
  ): Promise<ResolvedIconDataUrl | undefined> {
    const expandedCandidates = await expandShortcutCandidates(candidates);

    for (const expandedCandidate of expandedCandidates.candidates) {
      const { cacheable } = expandedCandidate;
      const icon = expandedCandidate.icon;
      const candidate = getIconFilePathCandidate(icon);

      if (!candidate) {
        continue;
      }

      if (isImageDataUrl(candidate)) {
        return {
          cacheable,
          dataUrl: candidate,
        };
      }

      const appUserModelId = getAppUserModelIdCandidate(candidate);

      if (appUserModelId !== undefined) {
        const appUserModelIcon = await getAppUserModelIcon(appUserModelId);

        if (appUserModelIcon !== undefined) {
          return {
            cacheable,
            dataUrl: appUserModelIcon,
          };
        }

        continue;
      }

      const iconPath = expandEnvironmentVariables(candidate);
      const cachedIcon = iconCache.get(iconPath);

      if (cachedIcon) {
        return {
          cacheable: cacheable && !isWeakResultIconPath(iconPath),
          dataUrl: cachedIcon,
        };
      }

      if (failedIconPaths.has(iconPath)) {
        continue;
      }

      try {
        const imageDataUrl = await getImageDataUrl(iconPath);
        const nativeDataUrl = imageDataUrl ?? (await getFileIconDataUrl(iconPath));
        const associatedDataUrl =
          imageDataUrl === undefined
            ? await getAssociatedFileIconDataUrl(iconPath, nativeDataUrl, expandedCandidates)
            : undefined;
        const dataUrl = associatedDataUrl ?? nativeDataUrl;

        if (dataUrl !== undefined) {
          setBoundedMapEntry(iconCache, iconPath, dataUrl, memoryCacheMaxEntries);
          return {
            cacheable: cacheable && !isWeakResultIconPath(iconPath),
            dataUrl,
          };
        }
      } catch (error) {
        addBoundedSetEntry(failedIconPaths, iconPath, memoryCacheMaxEntries);
        logger.warn('Failed to resolve app icon.', error);
      }
    }

    return undefined;
  }

  async function getAssociatedFileIconDataUrl(
    iconPath: string,
    nativeDataUrl: string | undefined,
    expandedCandidates: ExpandedIconCandidates,
  ): Promise<string | undefined> {
    if (
      resolveAssociatedFileIcon === undefined ||
      !shouldResolveAssociatedFileIcon(iconPath, nativeDataUrl, expandedCandidates)
    ) {
      return undefined;
    }

    try {
      const associatedDataUrl = await resolveAssociatedFileIcon(iconPath);

      return associatedDataUrl !== undefined && isImageDataUrl(associatedDataUrl)
        ? associatedDataUrl
        : undefined;
    } catch (error) {
      logger.warn('Failed to resolve associated app icon.', error);
      return undefined;
    }
  }

  function shouldResolveAssociatedFileIcon(
    iconPath: string,
    nativeDataUrl: string | undefined,
    expandedCandidates: ExpandedIconCandidates,
  ): boolean {
    if (!isExecutableIconPath(iconPath)) {
      return false;
    }

    return (
      nativeDataUrl === undefined ||
      expandedCandidates.hasInvalidIconLocationCandidate ||
      isSmallImageDataUrl(nativeDataUrl)
    );
  }

  function isExecutableIconPath(iconPath: string): boolean {
    return EXECUTABLE_ICON_EXTENSIONS.has(path.extname(iconPath).toLowerCase());
  }

  function isSmallImageDataUrl(dataUrl: string): boolean {
    const separatorIndex = dataUrl.indexOf(',');

    if (separatorIndex < 0) {
      return false;
    }

    try {
      return (
        Buffer.from(dataUrl.slice(separatorIndex + 1), 'base64').byteLength <=
        ASSOCIATED_ICON_FALLBACK_PNG_BYTE_THRESHOLD
      );
    } catch {
      return false;
    }
  }

  function isWeakResultIconPath(iconPath: string): boolean {
    return isShortcutPath(iconPath);
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

      setBoundedMapEntry(shortcutCandidateCache, shortcutPath, candidates, memoryCacheMaxEntries);
      return candidates;
    } catch (error) {
      addBoundedSetEntry(failedShortcutPaths, shortcutPath, memoryCacheMaxEntries);
      logger.warn('Failed to resolve app shortcut icon candidates.', error);
      const fallbackCandidates = createShortcutFallbackCandidates(shortcutPath);
      setBoundedMapEntry(
        shortcutCandidateCache,
        shortcutPath,
        fallbackCandidates,
        memoryCacheMaxEntries,
      );
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
  ): Promise<ExpandedIconCandidates> {
    const expandedCandidates: ExpandedIconCandidate[] = [];
    const dataUrlCandidates: string[] = [];
    const directCandidates: string[] = [];
    const shortcutCandidates: string[] = [];
    let hasInvalidIconLocationCandidate = false;

    for (const icon of candidates) {
      if (isInvalidIconLocationCandidate(icon)) {
        hasInvalidIconLocationCandidate = true;
        continue;
      }

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

    pushUniqueCandidates(expandedCandidates, dataUrlCandidates, true);

    if (resolveShortcut !== undefined) {
      const weakShortcutFallbackCandidates: string[] = [];

      for (const shortcutPath of shortcutCandidates) {
        const nextCandidates = await getShortcutCandidates(shortcutPath);
        hasInvalidIconLocationCandidate =
          hasInvalidIconLocationCandidate || nextCandidates.some(isInvalidIconLocationCandidate);

        if (isWeakShortcutExpansion(shortcutPath, nextCandidates)) {
          pushUniqueStrings(weakShortcutFallbackCandidates, nextCandidates);
          continue;
        }

        pushUniqueCandidates(expandedCandidates, nextCandidates, true);
      }

      pushUniqueCandidates(expandedCandidates, directCandidates, true);
      if (directCandidates.length === 0) {
        pushUniqueCandidates(expandedCandidates, weakShortcutFallbackCandidates, false);
      }
    } else {
      pushUniqueCandidates(expandedCandidates, directCandidates, true);
      pushUniqueCandidates(expandedCandidates, shortcutCandidates, false);
    }

    return {
      candidates: expandedCandidates,
      hasInvalidIconLocationCandidate,
    };
  }

  function isInvalidIconLocationCandidate(icon: string | undefined): boolean {
    return typeof icon === 'string' && ICON_INDEX_ONLY_PATTERN.test(icon.trim());
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

  function pushUniqueCandidates(
    target: ExpandedIconCandidate[],
    candidates: readonly string[],
    cacheable: boolean,
  ): void {
    for (const candidate of candidates) {
      const existingCandidate = target.find((entry) => entry.icon === candidate);

      if (existingCandidate !== undefined) {
        existingCandidate.cacheable = existingCandidate.cacheable || cacheable;
        continue;
      }

      target.push({
        cacheable,
        icon: candidate,
      });
    }
  }

  function pushUniqueStrings(target: string[], candidates: readonly string[]): void {
    for (const candidate of candidates) {
      if (!target.includes(candidate)) {
        target.push(candidate);
      }
    }
  }

  async function readCachedResultIcon(cacheKey: string): Promise<string | undefined> {
    if (iconDataUrlCache === undefined) {
      return undefined;
    }

    try {
      const dataUrl = await iconDataUrlCache.read(cacheKey);

      return dataUrl !== undefined && isImageDataUrl(dataUrl) ? dataUrl : undefined;
    } catch (error) {
      logger.warn('Failed to read cached app icon.', error);
      return undefined;
    }
  }

  async function writeCachedResultIcon(cacheKey: string, dataUrl: string): Promise<void> {
    if (iconDataUrlCache === undefined) {
      return;
    }

    try {
      await iconDataUrlCache.write(cacheKey, dataUrl);
    } catch (error) {
      logger.warn('Failed to write cached app icon.', error);
    }
  }

  async function resolveSearchResultIconData(
    result: LauncherCommandSearchResult,
    mode: 'cache-only' | 'resolve-native',
  ): Promise<LauncherCommandSearchResult> {
    const publicResult = createPublicSearchResult(result);

    if (result.source !== 'app') {
      return publicResult;
    }

    const resultIconCacheKey = createResultIconCacheKey(result);
    const cachedResultIcon = await readCachedResultIcon(resultIconCacheKey);

    if (cachedResultIcon !== undefined) {
      return { ...publicResult, icon: cachedResultIcon };
    }

    if (mode === 'cache-only') {
      return publicResult;
    }

    const resolvedIcon = await resolveIconDataUrl(getResultIconCandidates(result));

    if (resolvedIcon !== undefined && resolvedIcon.cacheable) {
      await writeCachedResultIcon(resultIconCacheKey, resolvedIcon.dataUrl);
    }

    return resolvedIcon ? { ...publicResult, icon: resolvedIcon.dataUrl } : publicResult;
  }

  async function warmSearchResultIcon(result: LauncherCommandSearchResult): Promise<void> {
    if (result.source !== 'app') {
      return;
    }

    const resultIconCacheKey = createResultIconCacheKey(result);
    const pendingResolution = pendingResultIconResolutions.get(resultIconCacheKey);

    if (pendingResolution !== undefined) {
      return pendingResolution;
    }

    const resolution = resolveSearchResultIconData(result, 'resolve-native')
      .then(() => undefined)
      .finally(() => {
        pendingResultIconResolutions.delete(resultIconCacheKey);
      });

    pendingResultIconResolutions.set(resultIconCacheKey, resolution);
    return resolution;
  }

  return {
    resolveCachedSearchResultIcon: (result) => resolveSearchResultIconData(result, 'cache-only'),
    resolveSearchResultIcon: (result) => resolveSearchResultIconData(result, 'resolve-native'),
    warmSearchResultIcon,
  };
}
