export const PLUGIN_MANIFEST_FILE_NAME = 'plugin.json';

export const PLUGIN_PERMISSIONS = Object.freeze(['clipboard.read', 'clipboard.write'] as const);

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const PLUGIN_ID_PATTERN =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const PLUGIN_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const PLUGIN_COMMAND_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export interface PluginManifestCommand {
  id: string;
  title: string;
  keywords: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  main: string;
  permissions: PluginPermission[];
  commands: PluginManifestCommand[];
  ui?: string;
}

export interface PluginManifestValidationError {
  field: string;
  message: string;
}

export const PLUGIN_MANIFEST_SCHEMA = Object.freeze({
  manifestFileName: PLUGIN_MANIFEST_FILE_NAME,
  requiredFields: Object.freeze([
    'id',
    'name',
    'version',
    'description',
    'main',
    'permissions',
    'commands',
  ] as const),
  optionalFields: Object.freeze(['ui'] as const),
  allowedPermissions: PLUGIN_PERMISSIONS,
  idPattern: PLUGIN_ID_PATTERN.source,
  versionPattern: PLUGIN_VERSION_PATTERN.source,
  commandIdPattern: PLUGIN_COMMAND_ID_PATTERN.source,
});
