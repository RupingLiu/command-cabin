export interface ClipboardWatcherTimer {
  setInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearInterval?: (timerId: unknown) => void;
}

export interface ClipboardWatcherOptions extends ClipboardWatcherTimer {
  intervalMs?: number;
  onError?: (error: unknown) => void;
  onText: (text: string) => void | Promise<void>;
  readText: () => string | Promise<string>;
}

export interface ClipboardWatcher {
  poll: () => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
}

const DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS = 1_000;

function defaultSetInterval(callback: () => void, intervalMs: number): unknown {
  return globalThis.setInterval(callback, intervalMs);
}

function defaultClearInterval(timerId: unknown): void {
  globalThis.clearInterval(timerId as ReturnType<typeof globalThis.setInterval>);
}

function normalizeClipboardText(text: string): string {
  return text.trim();
}

export function createClipboardWatcher(options: ClipboardWatcherOptions): ClipboardWatcher {
  const intervalMs = options.intervalMs ?? DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS;
  const setIntervalFn = options.setInterval ?? defaultSetInterval;
  const clearIntervalFn = options.clearInterval ?? defaultClearInterval;
  let lastText = '';
  let activePoll: Promise<void> | undefined;
  let timerId: unknown;

  async function poll(): Promise<void> {
    if (activePoll) {
      return activePoll;
    }

    activePoll = (async () => {
      try {
        const text = normalizeClipboardText(await options.readText());

        if (text.length === 0 || text === lastText) {
          return;
        }

        lastText = text;
        await options.onText(text);
      } catch (error) {
        options.onError?.(error);
      } finally {
        activePoll = undefined;
      }
    })();

    return activePoll;
  }

  return {
    poll,
    start: () => {
      if (timerId !== undefined) {
        return;
      }

      timerId = setIntervalFn(() => {
        void poll();
      }, intervalMs);
    },
    stop: async () => {
      if (timerId === undefined) {
        await activePoll;
        return;
      }

      clearIntervalFn(timerId);
      timerId = undefined;
      await activePoll;
    },
  };
}
