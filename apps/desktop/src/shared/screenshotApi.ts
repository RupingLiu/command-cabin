export const screenshotLaunchModes = Object.freeze([
  'capture',
  'capture-delay-3',
  'capture-delay-5',
  'ocr',
] as const);
export const screenshotSaveFormats = Object.freeze(['png', 'jpg'] as const);
export const screenshotOcrLanguages = Object.freeze(['zh-CN', 'zh-TW', 'en-US'] as const);

export type ScreenshotLaunchMode = (typeof screenshotLaunchModes)[number];
export type ScreenshotSaveFormat = (typeof screenshotSaveFormats)[number];
export type ScreenshotOcrLanguage = (typeof screenshotOcrLanguages)[number];

export interface ScreenshotBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface ScreenshotDisplaySnapshot {
  bounds: ScreenshotBounds;
  id: number;
  imageDataUrl: string;
  scaleFactor: number;
  sourceId: string;
}

export interface ScreenshotLaunchState {
  displays: ScreenshotDisplaySnapshot[];
  mode: ScreenshotLaunchMode;
  virtualBounds: ScreenshotBounds;
}

export interface ScreenshotImageRequest {
  imageDataUrl: string;
}

export interface ScreenshotSaveImageRequest extends ScreenshotImageRequest {
  defaultPath?: string;
  format: ScreenshotSaveFormat;
}

export interface ScreenshotOcrRequest extends ScreenshotImageRequest {
  language: ScreenshotOcrLanguage;
}

export interface ScreenshotOperationResult {
  ok: boolean;
}

export interface ScreenshotSaveImageResult {
  canceled: boolean;
  filePath?: string;
}

export interface ScreenshotOcrResult {
  language: ScreenshotOcrLanguage;
  text: string;
}

export interface ScreenshotPinImageResult {
  id: string;
}

const launchModeSet = new Set<ScreenshotLaunchMode>(screenshotLaunchModes);
const saveFormatSet = new Set<ScreenshotSaveFormat>(screenshotSaveFormats);
const ocrLanguageSet = new Set<ScreenshotOcrLanguage>(screenshotOcrLanguages);
const imageDataUrlPattern = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(value: Record<string, unknown>, keys: Set<string>, context: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new Error(`${context} contains unknown key "${key}".`);
    }
  }
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function parseNonEmptyString(value: unknown, context: string): string {
  const parsed = parseString(value, context).trim();

  if (parsed.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return parsed;
}

function parseFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number.`);
  }

  return value;
}

function parseBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

function parseImageDataUrl(value: unknown, context: string): string {
  const dataUrl = parseNonEmptyString(value, context);

  if (!imageDataUrlPattern.test(dataUrl)) {
    throw new Error(`${context} must be a PNG or JPEG image data URL.`);
  }

  return dataUrl;
}

export function parseScreenshotLaunchMode(value: unknown): ScreenshotLaunchMode {
  const mode = parseString(value, 'Screenshot launch mode');

  if (!launchModeSet.has(mode as ScreenshotLaunchMode)) {
    throw new Error('Screenshot launch mode is unsupported.');
  }

  return mode as ScreenshotLaunchMode;
}

export function parseScreenshotSaveFormat(value: unknown): ScreenshotSaveFormat {
  const format = parseString(value, 'Screenshot save format');

  if (!saveFormatSet.has(format as ScreenshotSaveFormat)) {
    throw new Error('Screenshot save format must be "png" or "jpg".');
  }

  return format as ScreenshotSaveFormat;
}

export function parseScreenshotOcrLanguage(value: unknown): ScreenshotOcrLanguage {
  const language = parseString(value, 'Screenshot OCR language');

  if (!ocrLanguageSet.has(language as ScreenshotOcrLanguage)) {
    throw new Error('Screenshot OCR language must be "zh-CN", "zh-TW", or "en-US".');
  }

  return language as ScreenshotOcrLanguage;
}

export function parseScreenshotBounds(
  value: unknown,
  context = 'Screenshot bounds',
): ScreenshotBounds {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['height', 'width', 'x', 'y']), context);

  return {
    height: parseFiniteNumber(value.height, `${context}.height`),
    width: parseFiniteNumber(value.width, `${context}.width`),
    x: parseFiniteNumber(value.x, `${context}.x`),
    y: parseFiniteNumber(value.y, `${context}.y`),
  };
}

export function parseScreenshotDisplaySnapshot(
  value: unknown,
  context = 'Screenshot display snapshot',
): ScreenshotDisplaySnapshot {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(
    value,
    new Set(['bounds', 'id', 'imageDataUrl', 'scaleFactor', 'sourceId']),
    context,
  );

  return {
    bounds: parseScreenshotBounds(value.bounds, `${context}.bounds`),
    id: parseFiniteNumber(value.id, `${context}.id`),
    imageDataUrl: parseImageDataUrl(value.imageDataUrl, `${context}.imageDataUrl`),
    scaleFactor: parseFiniteNumber(value.scaleFactor, `${context}.scaleFactor`),
    sourceId: parseNonEmptyString(value.sourceId, `${context}.sourceId`),
  };
}

export function parseScreenshotLaunchState(value: unknown): ScreenshotLaunchState {
  const context = 'Invalid screenshot launch state';

  if (!isRecord(value)) {
    throw new Error(`${context}: state must be an object.`);
  }

  assertKnownKeys(value, new Set(['displays', 'mode', 'virtualBounds']), context);

  if (!Array.isArray(value.displays)) {
    throw new Error(`${context}.displays must be an array.`);
  }

  return {
    displays: value.displays.map((display, index) =>
      parseScreenshotDisplaySnapshot(display, `${context}.displays[${index}]`),
    ),
    mode: parseScreenshotLaunchMode(value.mode),
    virtualBounds: parseScreenshotBounds(value.virtualBounds, `${context}.virtualBounds`),
  };
}

function parseScreenshotImageRequest(value: unknown, context: string): ScreenshotImageRequest {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['imageDataUrl']), context);

  return {
    imageDataUrl: parseImageDataUrl(value.imageDataUrl, `${context}.imageDataUrl`),
  };
}

export function parseScreenshotCopyImageRequest(value: unknown): ScreenshotImageRequest {
  return parseScreenshotImageRequest(value, 'Invalid screenshot copy image request');
}

export function parseScreenshotPinImageRequest(value: unknown): ScreenshotImageRequest {
  return parseScreenshotImageRequest(value, 'Invalid screenshot pin image request');
}

export function parseScreenshotSaveImageRequest(value: unknown): ScreenshotSaveImageRequest {
  const context = 'Invalid screenshot save image request';

  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['defaultPath', 'format', 'imageDataUrl']), context);

  const request: ScreenshotSaveImageRequest = {
    format: parseScreenshotSaveFormat(value.format),
    imageDataUrl: parseImageDataUrl(value.imageDataUrl, `${context}.imageDataUrl`),
  };

  if (value.defaultPath !== undefined) {
    request.defaultPath = parseNonEmptyString(value.defaultPath, `${context}.defaultPath`);
  }

  return request;
}

export function parseScreenshotOcrRequest(value: unknown): ScreenshotOcrRequest {
  const context = 'Invalid screenshot OCR request';

  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['imageDataUrl', 'language']), context);

  return {
    imageDataUrl: parseImageDataUrl(value.imageDataUrl, `${context}.imageDataUrl`),
    language: parseScreenshotOcrLanguage(value.language),
  };
}

export function parseScreenshotOperationResult(value: unknown): ScreenshotOperationResult {
  const context = 'Invalid screenshot operation response';

  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['ok']), context);

  return {
    ok: parseBoolean(value.ok, `${context}.ok`),
  };
}

export function parseScreenshotSaveImageResult(value: unknown): ScreenshotSaveImageResult {
  const context = 'Invalid screenshot save image response';

  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['canceled', 'filePath']), context);

  const result: ScreenshotSaveImageResult = {
    canceled: parseBoolean(value.canceled, `${context}.canceled`),
  };

  if (value.filePath !== undefined) {
    result.filePath = parseNonEmptyString(value.filePath, `${context}.filePath`);
  }

  return result;
}

export function parseScreenshotOcrResult(value: unknown): ScreenshotOcrResult {
  const context = 'Invalid screenshot OCR response';

  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['language', 'text']), context);

  return {
    language: parseScreenshotOcrLanguage(value.language),
    text: parseString(value.text, `${context}.text`),
  };
}

export function parseScreenshotPinImageResult(value: unknown): ScreenshotPinImageResult {
  const context = 'Invalid screenshot pin image response';

  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  assertKnownKeys(value, new Set(['id']), context);

  return {
    id: parseNonEmptyString(value.id, `${context}.id`),
  };
}
