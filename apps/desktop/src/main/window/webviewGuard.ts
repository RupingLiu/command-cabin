import { PLUGIN_ID_PATTERN, resolvePluginManifestPath } from '@command-cabin/core';
import type { Event, WebContents, WebPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE = 'data-plugin-allowed-base-url';
export const PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE = 'data-plugin-launch-token';

export interface PluginWebviewRegistrationRequest {
  name: string;
  pluginId: string;
  pluginRoot: string;
  uiPath: string;
}

export interface RegisteredPluginHostEntry {
  allowedBaseUrl: string;
  entryUrl: string;
  launchToken: string;
  name: string;
  partition: string;
  pluginId: string;
}

export interface PluginWebviewPolicy extends RegisteredPluginHostEntry {
  expectedPreloadPath: string;
  pluginRoot: string;
}

export interface PluginWebviewPolicyStoreOptions {
  expectedPreloadPath: string;
  generateLaunchToken?: () => string;
}

export interface PluginWebviewPolicyStore {
  readonly expectedPreloadPath: string;
  register: (input: unknown) => RegisteredPluginHostEntry;
  release: (launchToken: string) => boolean;
  resolveAttachPolicy: (params: Record<string, string>) => PluginWebviewPolicy | undefined;
  acceptAttachPolicy: (policy: PluginWebviewPolicy) => void;
  takePendingAttachPolicy: () => PluginWebviewPolicy | undefined;
}

export interface PluginWebviewAttachPolicy {
  policyStore: PluginWebviewPolicyStore;
}

export interface WebContentsWithWebviewAttachGuard {
  on(
    eventName: 'will-attach-webview',
    listener: (
      event: Event,
      webPreferences: WebPreferences,
      params: Record<string, string>,
    ) => void,
  ): unknown;
  on(
    eventName: 'did-attach-webview',
    listener: (event: Event, webContents: WebContents) => void,
  ): unknown;
}

export interface PluginGuestSession {
  on: (eventName: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (eventName: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface PluginGuestWebContents {
  session: PluginGuestSession;
  destroy?: () => void;
  on: (eventName: string, listener: (...args: unknown[]) => void) => unknown;
  setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => void;
}

type WebviewAttachEvent = Pick<Event, 'preventDefault'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return value.trim();
}

function parseRegistrationRequest(value: unknown): PluginWebviewRegistrationRequest {
  if (!isRecord(value)) {
    throw new Error('Invalid plugin webview registration request must be an object.');
  }

  const request = {
    name: parseNonEmptyString(value.name, 'Plugin webview name'),
    pluginId: parseNonEmptyString(value.pluginId, 'Plugin webview plugin id'),
    pluginRoot: parseNonEmptyString(value.pluginRoot, 'Plugin webview plugin root'),
    uiPath: parseNonEmptyString(value.uiPath, 'Plugin webview UI path'),
  };

  if (!PLUGIN_ID_PATTERN.test(request.pluginId)) {
    throw new Error('Plugin webview plugin id must use reverse-domain format.');
  }

  return request;
}

function normalizePathForComparison(path: string): string {
  const resolvedPath = resolve(path);

  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function areSamePath(leftPath: string, rightPath: string): boolean {
  return normalizePathForComparison(leftPath) === normalizePathForComparison(rightPath);
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

function pathToDirectoryFileUrl(directoryPath: string): string {
  const directoryUrl = pathToFileURL(directoryPath).toString();

  return directoryUrl.endsWith('/') ? directoryUrl : `${directoryUrl}/`;
}

function createPluginPartition(pluginId: string, launchToken: string): string {
  return `command-cabin-plugin:${pluginId.replace(/[^a-zA-Z0-9_-]/g, '-')}:${launchToken.replace(
    /[^a-zA-Z0-9_-]/g,
    '-',
  )}`;
}

function getFileUrlPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'file:') {
    return undefined;
  }

  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function isPluginNavigationAllowed(policy: PluginWebviewPolicy, requestedUrl: string): boolean {
  const requestedPath = getFileUrlPath(requestedUrl);

  if (requestedPath === undefined) {
    return false;
  }

  return isPathInsideDirectory(policy.pluginRoot, requestedPath);
}

function isPolicyMetadataIntact(
  policy: PluginWebviewPolicy,
  params: Record<string, string>,
): boolean {
  return (
    params.src === policy.entryUrl &&
    params[PLUGIN_WEBVIEW_ALLOWED_BASE_URL_ATTRIBUTE] === policy.allowedBaseUrl &&
    params[PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE] === policy.launchToken &&
    params['data-plugin-id'] === policy.pluginId
  );
}

function hasExpectedPartition(
  policy: PluginWebviewPolicy,
  webPreferences: WebPreferences,
  params: Record<string, string>,
): boolean {
  return (
    policy.partition.length > 0 &&
    !policy.partition.startsWith('persist:') &&
    params.partition === policy.partition &&
    webPreferences.partition === policy.partition
  );
}

function hasExpectedPreload(
  policy: PluginWebviewPolicy,
  webPreferences: WebPreferences,
  params: Record<string, string>,
): boolean {
  if (typeof webPreferences.preload !== 'string') {
    return false;
  }

  if (!areSamePath(webPreferences.preload, policy.expectedPreloadPath)) {
    return false;
  }

  if (params.preload !== undefined && !areSamePath(params.preload, policy.expectedPreloadPath)) {
    return false;
  }

  return true;
}

function hasDangerousPreferences(webPreferences: WebPreferences): boolean {
  return (
    webPreferences.nodeIntegration === true ||
    webPreferences.nodeIntegrationInSubFrames === true ||
    webPreferences.nodeIntegrationInWorker === true ||
    webPreferences.contextIsolation === false ||
    webPreferences.sandbox === false ||
    webPreferences.allowRunningInsecureContent === true ||
    webPreferences.webSecurity === false
  );
}

function enforceRestrictivePreferences(
  webPreferences: WebPreferences,
  policy: PluginWebviewPolicy,
) {
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webSecurity = true;
  webPreferences.preload = policy.expectedPreloadPath;
  webPreferences.partition = policy.partition;
}

function getNavigationUrl(args: readonly unknown[]): string | undefined {
  const maybeUrl = args.find((arg): arg is string => typeof arg === 'string');

  return maybeUrl;
}

export function createPluginWebviewPolicyStore({
  expectedPreloadPath,
  generateLaunchToken = randomUUID,
}: PluginWebviewPolicyStoreOptions): PluginWebviewPolicyStore {
  const policiesByLaunchToken = new Map<string, PluginWebviewPolicy>();
  const pendingAttachPolicies: PluginWebviewPolicy[] = [];

  return {
    expectedPreloadPath,
    register: (input) => {
      const request = parseRegistrationRequest(input);
      const pluginRoot = resolve(request.pluginRoot);
      const uiPathResult = resolvePluginManifestPath(pluginRoot, request.uiPath, 'ui');

      if (!uiPathResult.ok) {
        throw new Error(uiPathResult.error.message);
      }

      const launchToken = generateLaunchToken();
      const policy: PluginWebviewPolicy = {
        allowedBaseUrl: pathToDirectoryFileUrl(pluginRoot),
        entryUrl: pathToFileURL(uiPathResult.path).toString(),
        expectedPreloadPath,
        launchToken,
        name: request.name,
        partition: createPluginPartition(request.pluginId, launchToken),
        pluginId: request.pluginId,
        pluginRoot,
      };

      policiesByLaunchToken.set(launchToken, policy);

      return {
        allowedBaseUrl: policy.allowedBaseUrl,
        entryUrl: policy.entryUrl,
        launchToken: policy.launchToken,
        name: policy.name,
        partition: policy.partition,
        pluginId: policy.pluginId,
      };
    },
    release: (launchToken) => policiesByLaunchToken.delete(launchToken),
    resolveAttachPolicy: (params) => {
      const launchToken = params[PLUGIN_WEBVIEW_LAUNCH_TOKEN_ATTRIBUTE];

      return launchToken ? policiesByLaunchToken.get(launchToken) : undefined;
    },
    acceptAttachPolicy: (policy) => {
      policiesByLaunchToken.delete(policy.launchToken);
      pendingAttachPolicies.push(policy);
    },
    takePendingAttachPolicy: () => pendingAttachPolicies.shift(),
  };
}

export function guardPluginWebviewAttachment(
  event: WebviewAttachEvent,
  webPreferences: WebPreferences,
  params: Record<string, string>,
  policy: PluginWebviewAttachPolicy,
): boolean {
  const attachPolicy = policy.policyStore.resolveAttachPolicy(params);

  if (
    attachPolicy === undefined ||
    !isPolicyMetadataIntact(attachPolicy, params) ||
    !hasExpectedPartition(attachPolicy, webPreferences, params) ||
    !hasExpectedPreload(attachPolicy, webPreferences, params) ||
    hasDangerousPreferences(webPreferences)
  ) {
    event.preventDefault();
    return false;
  }

  enforceRestrictivePreferences(webPreferences, attachPolicy);
  policy.policyStore.acceptAttachPolicy(attachPolicy);
  return true;
}

export function enforcePluginGuestWebContentsPolicy(
  guestWebContents: PluginGuestWebContents,
  policy: PluginWebviewPolicy,
): void {
  const blockNavigation = (...args: unknown[]) => {
    const event = args[0] as WebviewAttachEvent | undefined;
    const requestedUrl = getNavigationUrl(args.slice(1));

    if (!requestedUrl || !isPluginNavigationAllowed(policy, requestedUrl)) {
      event?.preventDefault();
    }
  };
  const blockDownload = (...args: unknown[]) => {
    (args[0] as WebviewAttachEvent | undefined)?.preventDefault();
  };

  guestWebContents.on('will-navigate', blockNavigation);
  guestWebContents.on('will-frame-navigate', blockNavigation);
  guestWebContents.setWindowOpenHandler(() => ({
    action: 'deny',
  }));
  guestWebContents.session.on('will-download', blockDownload);
  guestWebContents.on('destroyed', () => {
    guestWebContents.session.removeListener?.('will-download', blockDownload);
  });
}

export function attachPluginWebviewGuard(
  webContents: WebContentsWithWebviewAttachGuard,
  policy: PluginWebviewAttachPolicy,
): void {
  webContents.on('will-attach-webview', (event, webPreferences, params) => {
    guardPluginWebviewAttachment(
      event as WebviewAttachEvent,
      webPreferences as WebPreferences,
      params as Record<string, string>,
      policy,
    );
  });
  webContents.on('did-attach-webview', (_event, guestWebContents) => {
    const attachPolicy = policy.policyStore.takePendingAttachPolicy();

    if (!attachPolicy) {
      (guestWebContents as unknown as Partial<PluginGuestWebContents>).destroy?.();
      return;
    }

    enforcePluginGuestWebContentsPolicy(
      guestWebContents as unknown as PluginGuestWebContents,
      attachPolicy,
    );
  });
}

export function getPluginBridgePreloadPath(mainPreloadPath: string): string {
  return join(dirname(mainPreloadPath), 'pluginBridge.cjs');
}
