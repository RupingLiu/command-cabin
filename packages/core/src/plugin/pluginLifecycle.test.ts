import { describe, expect, it, vi } from 'vitest';

import { createPluginLogStore } from './pluginLifecycle.js';

describe('createPluginLogStore', () => {
  it('drops the oldest entries once the configured cap is exceeded', () => {
    const store = createPluginLogStore({
      maxEntries: 3,
      clock: () => new Date('2026-05-15T10:00:00.000Z'),
    });

    for (let index = 1; index <= 5; index += 1) {
      store.log({
        level: 'info',
        message: `entry-${index}`,
      });
    }

    expect(store.list().map((entry) => entry.message)).toEqual(['entry-3', 'entry-4', 'entry-5']);
  });

  it('lists entries in push order', () => {
    const store = createPluginLogStore({
      maxEntries: 10,
      clock: () => new Date('2026-05-15T10:00:00.000Z'),
    });
    store.log({ level: 'debug', message: 'first' });
    store.log({ level: 'info', message: 'second', pluginId: 'com.example.one' });
    store.log({ level: 'error', message: 'third' });

    expect(store.list().map((entry) => entry.message)).toEqual(['first', 'second', 'third']);
    expect(store.list('com.example.one').map((entry) => entry.message)).toEqual(['second']);
  });

  it('keeps entries sorted by push order after the buffer wraps', () => {
    const store = createPluginLogStore({
      maxEntries: 4,
      clock: () => new Date('2026-05-15T10:00:00.000Z'),
    });
    store.log({ level: 'info', message: 'a' });
    store.log({ level: 'info', message: 'b' });
    store.log({ level: 'info', message: 'c' });
    store.log({ level: 'info', message: 'd' });
    store.log({ level: 'info', message: 'e' });

    expect(store.list().map((entry) => entry.message)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('defaults to a 1000-entry cap', () => {
    const store = createPluginLogStore();

    for (let index = 0; index < 1001; index += 1) {
      store.log({ level: 'info', message: `entry-${index}` });
    }

    expect(store.list()).toHaveLength(1000);
    expect(store.list()[0]?.message).toBe('entry-1');
  });

  it('forwards every entry to the configured sink', () => {
    const sink = vi.fn();
    const store = createPluginLogStore({ maxEntries: 5, sink });
    store.log({ level: 'warn', message: 'warned' });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'warned',
        timestamp: expect.any(String),
      }),
    );
  });
});
