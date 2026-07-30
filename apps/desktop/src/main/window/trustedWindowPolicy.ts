import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CommandCabinWindowRole } from '../../shared/windowRoles.js';
export { createWindowPreloadArguments } from '../../shared/windowRoles.js';
export type { CommandCabinWindowRole } from '../../shared/windowRoles.js';

export interface TrustedNavigationEvent {
  preventDefault: () => void;
}

export interface TrustedWindowWebContents {
  id: number;
  mainFrame?: unknown;
  on: (
    eventName: 'destroyed' | 'will-navigate' | 'will-redirect',
    listener: (...args: unknown[]) => void,
  ) => unknown;
  setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => unknown;
}

export interface TrustedWindow {
  webContents: TrustedWindowWebContents;
}

export interface PermissionDenySession {
  setPermissionCheckHandler: (handler: () => boolean) => void;
  setPermissionRequestHandler: (
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: unknown,
    ) => void,
  ) => void;
}

export interface TrustedWindowPolicyOptions {
  isPackaged: boolean;
  rendererDevServerUrl?: string | undefined;
  rendererIndexPath: string;
  role: CommandCabinWindowRole;
}

interface RegisteredTrustedWindow {
  isAllowedUrl: (url: string) => boolean;
  role: CommandCabinWindowRole;
}

const trustedWindows = new Map<number, RegisteredTrustedWindow>();

function normalizePathForComparison(path: string): string {
  const normalized = resolve(path);

  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function areSamePath(left: string, right: string): boolean {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function hasExpectedMode(url: URL, role: CommandCabinWindowRole): boolean {
  const mode = url.searchParams.get('mode');

  if (role === 'launcher') {
    return mode === null;
  }

  if (mode !== role) {
    return false;
  }

  return role !== 'pinned-image' || (url.searchParams.get('token')?.trim().length ?? 0) > 0;
}

export function createTrustedRendererUrlPredicate({
  isPackaged,
  rendererDevServerUrl,
  rendererIndexPath,
  role,
}: TrustedWindowPolicyOptions): (url: string) => boolean {
  const expectedFileUrl = pathToFileURL(rendererIndexPath);
  const expectedDevUrl =
    !isPackaged && rendererDevServerUrl ? new URL(rendererDevServerUrl) : undefined;

  return (requestedUrl) => {
    let url: URL;

    try {
      url = new URL(requestedUrl);
    } catch {
      return false;
    }

    if (!hasExpectedMode(url, role)) {
      return false;
    }

    if (expectedDevUrl) {
      return url.origin === expectedDevUrl.origin && url.pathname === expectedDevUrl.pathname;
    }

    if (url.protocol !== 'file:' || expectedFileUrl.protocol !== 'file:') {
      return false;
    }

    try {
      return areSamePath(fileURLToPath(url), fileURLToPath(expectedFileUrl));
    } catch {
      return false;
    }
  };
}

function readNavigationUrl(args: readonly unknown[]): string | undefined {
  return args.find((value): value is string => typeof value === 'string');
}

export function attachTrustedWindowPolicy(
  window: Pick<BrowserWindow, 'webContents'>,
  options: TrustedWindowPolicyOptions,
): void;
export function attachTrustedWindowPolicy(
  window: TrustedWindow,
  options: TrustedWindowPolicyOptions,
): void;
export function attachTrustedWindowPolicy(
  window: TrustedWindow | Pick<BrowserWindow, 'webContents'>,
  options: TrustedWindowPolicyOptions,
): void {
  const isAllowedUrl = createTrustedRendererUrlPredicate(options);
  const webContents = window.webContents as unknown as TrustedWindowWebContents;
  const blockUntrustedNavigation = (...args: unknown[]) => {
    const event = args[0] as TrustedNavigationEvent | undefined;
    const requestedUrl = readNavigationUrl(args.slice(1));

    if (!requestedUrl || !isAllowedUrl(requestedUrl)) {
      event?.preventDefault();
    }
  };

  trustedWindows.set(webContents.id, {
    isAllowedUrl,
    role: options.role,
  });
  webContents.on('will-navigate', blockUntrustedNavigation);
  webContents.on('will-redirect', blockUntrustedNavigation);
  webContents.on('destroyed', () => {
    trustedWindows.delete(webContents.id);
  });
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

export function denyAllSessionPermissions(session: PermissionDenySession): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

export function assertTrustedIpcSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  allowedRoles: readonly CommandCabinWindowRole[],
): CommandCabinWindowRole {
  const registration = trustedWindows.get(event.sender.id);

  if (!registration || !allowedRoles.includes(registration.role)) {
    throw new Error('IPC request is not allowed for this window role.');
  }

  const senderFrame = event.senderFrame;

  if (!senderFrame || senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC request must originate from the trusted main frame.');
  }

  if (!registration.isAllowedUrl(senderFrame.url)) {
    throw new Error('IPC request originated from an untrusted renderer URL.');
  }

  return registration.role;
}

export function clearTrustedWindowPoliciesForTesting(): void {
  trustedWindows.clear();
}
