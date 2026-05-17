import type { FavoriteListRecord } from './favoritesApi.js';

export type AppCandidateSource = 'desktop' | 'start-menu';
export type AppCandidateResolutionStatus = 'resolved' | 'unresolved-shortcut';

export interface AppCandidate {
  alreadyPinned: boolean;
  executablePath?: string | undefined;
  icon?: string | undefined;
  iconPath?: string | undefined;
  id: string;
  resolutionStatus: AppCandidateResolutionStatus;
  shortcutPath: string;
  source: AppCandidateSource;
  subtitle: string;
  title: string;
}

export type AppCandidateAddRequest = AppCandidate;
export type AppCandidateAddResponse = FavoriteListRecord;

const appCandidateSources = new Set<AppCandidateSource>(['desktop', 'start-menu']);
const appCandidateResolutionStatuses = new Set<AppCandidateResolutionStatus>([
  'resolved',
  'unresolved-shortcut',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function parseNonEmptyString(value: unknown, context: string): string {
  const stringValue = parseString(value, context).trim();

  if (stringValue.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return stringValue;
}

function parseOptionalNonEmptyString(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, context);
}

function parseBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

function parseSource(value: unknown, context: string): AppCandidateSource {
  const source = parseString(value, context);

  if (!appCandidateSources.has(source as AppCandidateSource)) {
    throw new Error(`${context} must be "desktop" or "start-menu".`);
  }

  return source as AppCandidateSource;
}

function parseResolutionStatus(value: unknown, context: string): AppCandidateResolutionStatus {
  const status = parseString(value, context);

  if (!appCandidateResolutionStatuses.has(status as AppCandidateResolutionStatus)) {
    throw new Error(`${context} must be "resolved" or "unresolved-shortcut".`);
  }

  return status as AppCandidateResolutionStatus;
}

export function parseAppCandidate(value: unknown, context = 'Invalid app candidate'): AppCandidate {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  const candidate: AppCandidate = {
    alreadyPinned: parseBoolean(value.alreadyPinned, `${context}.alreadyPinned`),
    id: parseNonEmptyString(value.id, `${context}.id`),
    resolutionStatus: parseResolutionStatus(value.resolutionStatus, `${context}.resolutionStatus`),
    shortcutPath: parseNonEmptyString(value.shortcutPath, `${context}.shortcutPath`),
    source: parseSource(value.source, `${context}.source`),
    subtitle: parseNonEmptyString(value.subtitle, `${context}.subtitle`),
    title: parseNonEmptyString(value.title, `${context}.title`),
  };
  const executablePath = parseOptionalNonEmptyString(
    value.executablePath,
    `${context}.executablePath`,
  );
  const icon = parseOptionalNonEmptyString(value.icon, `${context}.icon`);
  const iconPath = parseOptionalNonEmptyString(value.iconPath, `${context}.iconPath`);

  if (executablePath !== undefined) {
    candidate.executablePath = executablePath;
  }

  if (icon !== undefined) {
    candidate.icon = icon;
  }

  if (iconPath !== undefined) {
    candidate.iconPath = iconPath;
  }

  return candidate;
}

export function parseAppCandidates(value: unknown): AppCandidate[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid app candidates response must be an array.');
  }

  return value.map((candidate, index) =>
    parseAppCandidate(candidate, `Invalid app candidate at candidates[${index}]`),
  );
}

export function parseAppCandidateAddRequest(value: unknown): AppCandidateAddRequest {
  return parseAppCandidate(value, 'Invalid app candidate add request');
}
