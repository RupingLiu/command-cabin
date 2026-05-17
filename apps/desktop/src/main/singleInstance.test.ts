import { describe, expect, it, vi } from 'vitest';

import { configureSingleInstance } from './singleInstance.js';

type AppEvent = 'second-instance';
type AppListener = () => void;

class MockSingleInstanceApp {
  readonly quit = vi.fn();
  readonly requestSingleInstanceLock = vi.fn(() => true);
  readonly listeners = new Map<AppEvent, AppListener>();

  on(eventName: AppEvent, listener: AppListener): this {
    this.listeners.set(eventName, listener);
    return this;
  }

  emit(eventName: AppEvent): void {
    this.listeners.get(eventName)?.();
  }
}

describe('configureSingleInstance', () => {
  it('quits the duplicate process when another instance already owns the lock', () => {
    const app = new MockSingleInstanceApp();
    app.requestSingleInstanceLock.mockReturnValue(false);
    const showExistingWindow = vi.fn();

    expect(configureSingleInstance({ app, showExistingWindow })).toBe(false);

    expect(app.quit).toHaveBeenCalledOnce();
    expect(showExistingWindow).not.toHaveBeenCalled();
    expect(app.listeners.has('second-instance')).toBe(false);
  });

  it('shows the existing launcher when a second instance is opened', async () => {
    const app = new MockSingleInstanceApp();
    const showExistingWindow = vi.fn(async () => undefined);

    expect(configureSingleInstance({ app, showExistingWindow })).toBe(true);
    app.emit('second-instance');
    await Promise.resolve();

    expect(showExistingWindow).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });
});
