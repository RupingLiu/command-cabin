const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ResolveSafeRendererDevServerUrlOptions {
  isPackaged: boolean;
  rendererDevServerUrl?: string | undefined;
}

export function resolveSafeRendererDevServerUrl({
  isPackaged,
  rendererDevServerUrl,
}: ResolveSafeRendererDevServerUrlOptions): string | undefined {
  if (isPackaged || !rendererDevServerUrl) {
    return undefined;
  }

  try {
    const parsedUrl = new URL(rendererDevServerUrl);

    if (parsedUrl.protocol !== 'http:') {
      return undefined;
    }

    if (!LOCALHOST_HOSTNAMES.has(parsedUrl.hostname)) {
      return undefined;
    }

    return rendererDevServerUrl;
  } catch {
    return undefined;
  }
}
