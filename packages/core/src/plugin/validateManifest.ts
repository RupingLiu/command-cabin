import {
  PLUGIN_COMMAND_ID_PATTERN,
  PLUGIN_ID_PATTERN,
  PLUGIN_PERMISSIONS,
  PLUGIN_VERSION_PATTERN,
  type PluginManifest,
  type PluginManifestCommand,
  type PluginManifestValidationError,
  type PluginPermission,
} from './pluginManifest.js';
import { validatePluginManifestPath } from './pluginPaths.js';

export interface ValidatePluginManifestSuccess {
  ok: true;
  manifest: PluginManifest;
}

export interface ValidatePluginManifestFailure {
  ok: false;
  errors: PluginManifestValidationError[];
}

export type ValidatePluginManifestResult =
  | ValidatePluginManifestSuccess
  | ValidatePluginManifestFailure;

const PLUGIN_PERMISSION_VALUES = new Set<string>(PLUGIN_PERMISSIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalArrayIndexProperty(propertyName: string, arrayLength: number): boolean {
  const index = Number(propertyName);

  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < arrayLength &&
    String(index) === propertyName
  );
}

function addError(errors: PluginManifestValidationError[], field: string, message: string): void {
  errors.push({
    field,
    message,
  });
}

type FieldReadResult = { ok: true; value: unknown } | { ok: false };

function readRecordField(
  record: Record<string, unknown>,
  field: string,
  label: string,
  errors: PluginManifestValidationError[],
  errorField = field,
): FieldReadResult {
  try {
    return {
      ok: true,
      value: record[field],
    };
  } catch {
    addError(errors, errorField, `${label} could not be read.`);
    return {
      ok: false,
    };
  }
}

function validateRequiredString(
  manifest: Record<string, unknown>,
  field: string,
  label: string,
  errors: PluginManifestValidationError[],
  errorField = field,
): string | undefined {
  const fieldValue = readRecordField(manifest, field, label, errors, errorField);

  if (!fieldValue.ok) {
    return undefined;
  }

  const { value } = fieldValue;

  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
    addError(errors, errorField, `${label} is required.`);
    return undefined;
  }

  if (typeof value !== 'string') {
    addError(errors, errorField, `${label} must be a string.`);
    return undefined;
  }

  return value;
}

function validateOptionalString(
  manifest: Record<string, unknown>,
  field: string,
  label: string,
  errors: PluginManifestValidationError[],
): string | undefined {
  const fieldValue = readRecordField(manifest, field, label, errors);

  if (!fieldValue.ok) {
    return undefined;
  }

  const { value } = fieldValue;

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    addError(errors, field, `${label} must be a string.`);
    return undefined;
  }

  return value;
}

function validateArray(
  value: unknown,
  field: string,
  message: string,
  errors: PluginManifestValidationError[],
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, field, message);
    return undefined;
  }

  let arrayLength: number;
  let propertyNames: string[];

  try {
    arrayLength = value.length;
    propertyNames = Object.getOwnPropertyNames(value);
  } catch {
    addError(errors, field, `${field} could not be read.`);
    return undefined;
  }

  for (const propertyName of propertyNames) {
    if (propertyName === 'length') {
      continue;
    }

    if (!isCanonicalArrayIndexProperty(propertyName, arrayLength)) {
      addError(errors, field, `${field} cannot contain non-index property "${propertyName}".`);
      return undefined;
    }
  }

  const propertyNameSet = new Set(propertyNames);
  const arrayValues: unknown[] = [];

  for (let index = 0; index < arrayLength; index += 1) {
    if (!propertyNameSet.has(String(index))) {
      addError(errors, `${field}[${index}]`, `${field} cannot contain missing items.`);
      return undefined;
    }

    try {
      arrayValues.push(value[index]);
    } catch {
      addError(errors, `${field}[${index}]`, `${field}[${index}] could not be read.`);
      return undefined;
    }
  }

  return arrayValues;
}

function validatePermissions(
  value: unknown,
  errors: PluginManifestValidationError[],
): PluginPermission[] | undefined {
  const permissions = validateArray(
    value,
    'permissions',
    'Plugin permissions must be an array.',
    errors,
  );

  if (!permissions) {
    return undefined;
  }

  const validatedPermissions: PluginPermission[] = [];
  const allowedPermissions = PLUGIN_PERMISSIONS.join(', ');

  for (const [index, permission] of permissions.entries()) {
    const field = `permissions[${index}]`;

    if (typeof permission !== 'string') {
      addError(errors, field, 'Plugin permission must be a string.');
      continue;
    }

    if (permission.trim().length === 0) {
      addError(errors, field, 'Plugin permission cannot be empty.');
      continue;
    }

    if (!PLUGIN_PERMISSION_VALUES.has(permission)) {
      addError(
        errors,
        field,
        `Unknown plugin permission "${permission}". Allowed permissions: ${allowedPermissions}.`,
      );
      continue;
    }

    validatedPermissions.push(permission as PluginPermission);
  }

  return validatedPermissions;
}

function validateCommandId(
  value: unknown,
  field: string,
  errors: PluginManifestValidationError[],
): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    if (!PLUGIN_COMMAND_ID_PATTERN.test(value)) {
      addError(
        errors,
        field,
        'Command ID must use lowercase letters, numbers, dots, or hyphens, for example "uppercase".',
      );
      return undefined;
    }

    return value;
  }

  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
    addError(errors, field, 'Command ID is required.');
    return undefined;
  }

  addError(errors, field, 'Command ID must be a string.');
  return undefined;
}

function validateCommandKeywords(
  value: unknown,
  field: string,
  errors: PluginManifestValidationError[],
): string[] | undefined {
  const keywords = validateArray(value, field, 'Command keywords must be an array.', errors);

  if (!keywords) {
    return undefined;
  }

  const validatedKeywords: string[] = [];

  for (const [index, keyword] of keywords.entries()) {
    const keywordField = `${field}[${index}]`;

    if (typeof keyword !== 'string') {
      addError(errors, keywordField, 'Command keyword must be a string.');
      continue;
    }

    if (keyword.trim().length === 0) {
      addError(errors, keywordField, 'Command keyword cannot be empty.');
      continue;
    }

    validatedKeywords.push(keyword);
  }

  return validatedKeywords;
}

function validateCommand(
  value: unknown,
  index: number,
  seenCommandIds: Set<string>,
  errors: PluginManifestValidationError[],
): PluginManifestCommand | undefined {
  const field = `commands[${index}]`;

  if (!isRecord(value)) {
    addError(errors, field, 'Command must be an object.');
    return undefined;
  }

  const commandIdValue = readRecordField(value, 'id', 'Command ID', errors, `${field}.id`);
  const id = commandIdValue.ok
    ? validateCommandId(commandIdValue.value, `${field}.id`, errors)
    : undefined;
  const title = validateRequiredString(value, 'title', 'Command title', errors, `${field}.title`);
  const commandKeywordsValue = readRecordField(
    value,
    'keywords',
    'Command keywords',
    errors,
    `${field}.keywords`,
  );
  const keywords = commandKeywordsValue.ok
    ? validateCommandKeywords(commandKeywordsValue.value, `${field}.keywords`, errors)
    : undefined;

  if (id) {
    if (seenCommandIds.has(id)) {
      addError(errors, `${field}.id`, `Command ID "${id}" is already declared in this manifest.`);
    } else {
      seenCommandIds.add(id);
    }
  }

  if (id === undefined || title === undefined || keywords === undefined) {
    return undefined;
  }

  return {
    id,
    title,
    keywords,
  };
}

function validateCommands(
  value: unknown,
  errors: PluginManifestValidationError[],
): PluginManifestCommand[] | undefined {
  const commands = validateArray(value, 'commands', 'Plugin commands must be an array.', errors);

  if (!commands) {
    return undefined;
  }

  const seenCommandIds = new Set<string>();
  const validatedCommands: PluginManifestCommand[] = [];

  commands.forEach((command, index) => {
    const validatedCommand = validateCommand(command, index, seenCommandIds, errors);

    if (validatedCommand) {
      validatedCommands.push(validatedCommand);
    }
  });

  return validatedCommands;
}

export function validatePluginManifest(value: unknown): ValidatePluginManifestResult {
  const errors: PluginManifestValidationError[] = [];

  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        {
          field: 'manifest',
          message: 'Plugin manifest must be an object.',
        },
      ],
    };
  }

  const id = validateRequiredString(value, 'id', 'Plugin ID', errors);
  const name = validateRequiredString(value, 'name', 'Plugin name', errors);
  const version = validateRequiredString(value, 'version', 'Plugin version', errors);
  const description = validateRequiredString(value, 'description', 'Plugin description', errors);
  const main = validateRequiredString(value, 'main', 'Plugin main entry file', errors);
  const ui = validateOptionalString(value, 'ui', 'Plugin UI entry file', errors);
  const permissionValue = readRecordField(value, 'permissions', 'Plugin permissions', errors);
  const commandValue = readRecordField(value, 'commands', 'Plugin commands', errors);
  const permissions = permissionValue.ok
    ? validatePermissions(permissionValue.value, errors)
    : undefined;
  const commands = commandValue.ok ? validateCommands(commandValue.value, errors) : undefined;

  if (id !== undefined && !PLUGIN_ID_PATTERN.test(id)) {
    addError(
      errors,
      'id',
      'Plugin ID must use lowercase reverse-domain format, for example "com.example.text-tools".',
    );
  }

  if (version !== undefined && !PLUGIN_VERSION_PATTERN.test(version)) {
    addError(
      errors,
      'version',
      'Plugin version must look like semantic versioning, for example "1.2.3".',
    );
  }

  if (main !== undefined) {
    const mainPathError = validatePluginManifestPath(main, 'main');

    if (mainPathError) {
      errors.push(mainPathError);
    }
  }

  if (ui !== undefined) {
    const uiPathError = validatePluginManifestPath(ui, 'ui');

    if (uiPathError) {
      errors.push(uiPathError);
    }
  }

  if (
    errors.length > 0 ||
    id === undefined ||
    name === undefined ||
    version === undefined ||
    description === undefined ||
    main === undefined ||
    permissions === undefined ||
    commands === undefined
  ) {
    return {
      ok: false,
      errors,
    };
  }

  const manifest: PluginManifest = {
    id,
    name,
    version,
    description,
    main,
    permissions,
    commands,
  };

  if (ui !== undefined) {
    manifest.ui = ui;
  }

  return {
    ok: true,
    manifest,
  };
}

export function formatPluginManifestValidationErrors(
  errors: readonly PluginManifestValidationError[],
): string[] {
  return errors.map((error) => `${error.field}: ${error.message}`);
}
