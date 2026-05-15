import { realpath as realpathFromFileSystem } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

import { PLUGIN_MANIFEST_FILE_NAME, type PluginManifestValidationError } from './pluginManifest.js';

export interface ResolvePluginManifestPathSuccess {
  ok: true;
  path: string;
}

export interface ResolvePluginManifestPathFailure {
  ok: false;
  error: PluginManifestValidationError;
}

export type ResolvePluginManifestPathResult =
  | ResolvePluginManifestPathSuccess
  | ResolvePluginManifestPathFailure;

export type PluginPathRealpath = (path: string) => Promise<string> | string;

export interface ResolvePluginManifestRealPathOptions {
  realpath?: PluginPathRealpath;
}

function formatPathField(field: string): string {
  if (field === 'ui') {
    return 'UI entry file';
  }

  if (field === 'main') {
    return 'main entry file';
  }

  return field;
}

function createPathError(field: string, message: string): PluginManifestValidationError {
  return {
    field,
    message,
  };
}

function isAbsoluteOrRootedPath(manifestPath: string): boolean {
  return (
    isAbsolute(manifestPath) ||
    posix.isAbsolute(manifestPath) ||
    win32.isAbsolute(manifestPath) ||
    win32.parse(manifestPath).root.length > 0
  );
}

function getManifestPathSegments(manifestPath: string): string[] {
  return manifestPath.replace(/\\/g, '/').split('/').filter(Boolean);
}

function isPathInsideDirectory(directoryPath: string, targetPath: string): boolean {
  const normalizedDirectoryPath = normalizePathForComparison(directoryPath);
  const normalizedTargetPath = normalizePathForComparison(targetPath);
  const relativePath = relative(normalizedDirectoryPath, normalizedTargetPath);

  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function normalizePathForComparison(filePath: string): string {
  const resolvedPath = resolve(filePath);

  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

export function validatePluginManifestPath(
  manifestPath: string,
  field: string,
): PluginManifestValidationError | undefined {
  const pathField = formatPathField(field);

  if (manifestPath.trim().length === 0) {
    return createPathError(
      field,
      field === 'ui' ? `Plugin ${pathField} cannot be empty.` : `Plugin ${pathField} is required.`,
    );
  }

  if (manifestPath.includes('\0')) {
    return createPathError(field, `Plugin ${pathField} cannot contain null bytes.`);
  }

  if (isAbsoluteOrRootedPath(manifestPath)) {
    return createPathError(
      field,
      `Plugin ${pathField} must be a relative path inside the plugin folder.`,
    );
  }

  if (getManifestPathSegments(manifestPath).includes('..')) {
    return createPathError(
      field,
      `Plugin ${pathField} must stay inside the plugin folder and cannot contain "..".`,
    );
  }

  return undefined;
}

export function getPluginManifestFilePath(pluginRoot: string): string {
  return join(pluginRoot, PLUGIN_MANIFEST_FILE_NAME);
}

/**
 * Lexically resolves a manifest path under the plugin root. This does not follow
 * symlinks or junctions; use resolvePluginManifestRealPath before loading code.
 */
export function resolvePluginManifestPath(
  pluginRoot: string,
  manifestPath: string,
  field = 'path',
): ResolvePluginManifestPathResult {
  const validationError = validatePluginManifestPath(manifestPath, field);

  if (validationError) {
    return {
      ok: false,
      error: validationError,
    };
  }

  const resolvedPluginRoot = resolve(pluginRoot);
  const resolvedPath = resolve(resolvedPluginRoot, ...getManifestPathSegments(manifestPath));

  if (!isPathInsideDirectory(resolvedPluginRoot, resolvedPath)) {
    return {
      ok: false,
      error: createPathError(
        field,
        `Plugin ${formatPathField(field)} must stay inside the plugin folder.`,
      ),
    };
  }

  return {
    ok: true,
    path: resolvedPath,
  };
}

export async function resolvePluginManifestRealPath(
  pluginRoot: string,
  manifestPath: string,
  field = 'path',
  options: ResolvePluginManifestRealPathOptions = {},
): Promise<ResolvePluginManifestPathResult> {
  const lexicalResult = resolvePluginManifestPath(pluginRoot, manifestPath, field);

  if (!lexicalResult.ok) {
    return lexicalResult;
  }

  const realpath = options.realpath ?? realpathFromFileSystem;
  let realPluginRoot: string;
  let realTargetPath: string;

  try {
    realPluginRoot = await realpath(resolve(pluginRoot));
  } catch {
    return {
      ok: false,
      error: createPathError(field, 'Plugin folder could not be resolved.'),
    };
  }

  try {
    realTargetPath = await realpath(lexicalResult.path);
  } catch {
    return {
      ok: false,
      error: createPathError(
        field,
        `Plugin ${formatPathField(field)} must exist inside the plugin folder.`,
      ),
    };
  }

  if (!isPathInsideDirectory(realPluginRoot, realTargetPath)) {
    return {
      ok: false,
      error: createPathError(
        field,
        `Plugin ${formatPathField(field)} must resolve inside the plugin folder.`,
      ),
    };
  }

  return {
    ok: true,
    path: realTargetPath,
  };
}
