import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  formatPluginManifestValidationErrors,
  validatePluginManifest,
} from './validateManifest.js';
import { getPluginManifestFilePath, resolvePluginManifestRealPath } from './pluginPaths.js';
import type { PluginManifest } from './pluginManifest.js';

export interface PluginInspection {
  mainPath: string;
  manifest: PluginManifest;
  pluginRoot: string;
  uiPath?: string | undefined;
}

export async function inspectPluginDirectory(pluginRoot: string): Promise<PluginInspection> {
  const normalizedPluginRoot = resolve(pluginRoot.trim());

  if (pluginRoot.trim().length === 0) {
    throw new Error('Plugin folder path must be a non-empty string.');
  }

  let manifestValue: unknown;

  try {
    manifestValue = JSON.parse(
      await readFile(getPluginManifestFilePath(normalizedPluginRoot), 'utf8'),
    ) as unknown;
  } catch (error) {
    throw new Error('Plugin manifest could not be read.', { cause: error });
  }

  const validation = validatePluginManifest(manifestValue);

  if (!validation.ok) {
    throw new Error(
      `Plugin manifest is invalid: ${formatPluginManifestValidationErrors(validation.errors).join(
        '; ',
      )}`,
    );
  }

  const mainPathResult = await resolvePluginManifestRealPath(
    normalizedPluginRoot,
    validation.manifest.main,
    'main',
  );

  if (!mainPathResult.ok) {
    throw new Error(mainPathResult.error.message);
  }

  const inspection: PluginInspection = {
    mainPath: mainPathResult.path,
    manifest: validation.manifest,
    pluginRoot: normalizedPluginRoot,
  };

  if (validation.manifest.ui !== undefined) {
    const uiPathResult = await resolvePluginManifestRealPath(
      normalizedPluginRoot,
      validation.manifest.ui,
      'ui',
    );

    if (!uiPathResult.ok) {
      throw new Error(uiPathResult.error.message);
    }

    inspection.uiPath = uiPathResult.path;
  }

  return inspection;
}
