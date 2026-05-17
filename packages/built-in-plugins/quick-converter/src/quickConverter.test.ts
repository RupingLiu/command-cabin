import { describe, expect, it, vi } from 'vitest';

import {
  createQuickConverterCommand,
  createStaticConversionCommand,
  parseConversionQuery,
} from './index.js';

describe('quick converter built-in plugin', () => {
  it.each([
    ['1厘米', '1 厘米 = 10 毫米 = 0.01 米'],
    ['1 cm', '1 厘米 = 10 毫米 = 0.01 米'],
    ['1公分', '1 厘米 = 10 毫米 = 0.01 米'],
    ['25毫米', '25 毫米 = 2.5 厘米 = 0.025 米'],
    ['2.5 m', '2.5 米 = 250 厘米 = 2500 毫米'],
  ])('converts length query %s', (query, expected) => {
    expect(createStaticConversionCommand(query)).toMatchObject({
      id: 'quick-converter.result',
      pluginId: 'quick-converter',
      source: 'plugin',
      title: expected,
      action: { type: 'copy-text', payload: { text: expected } },
    });
  });

  it.each([
    ['1千克', '1 千克 = 2.20462 磅'],
    ['1公斤', '1 千克 = 2.20462 磅'],
    ['1000g', '1000 克 = 2.20462 磅'],
    ['1 lb', '1 磅 = 0.453592 千克 = 453.592 克'],
  ])('converts weight query %s', (query, expected) => {
    expect(createStaticConversionCommand(query)).toMatchObject({ title: expected });
  });

  it.each([
    ['1厘米', 'length', 'centimeter'],
    ['1 mm', 'length', 'millimeter'],
    ['1米', 'length', 'meter'],
    ['2.5kg', 'weight', 'kilogram'],
    ['100 克', 'weight', 'gram'],
    ['1 lbs', 'weight', 'pound'],
    ['1 USD', 'currency', 'usd'],
    ['1美元', 'currency', 'usd'],
    ['1美金', 'currency', 'usd'],
  ])('parses supported alias query %s', (query, kind, unit) => {
    expect(parseConversionQuery(query)).toMatchObject({
      amount: expect.any(Number),
      kind,
      unit,
    });
  });

  it.each(['1kg + 2g', '人民币换美元', '一美元', 'abc', '', '1'])(
    'rejects unsupported query %s',
    (query) => {
      expect(parseConversionQuery(query)).toBeUndefined();
      expect(createStaticConversionCommand(query)).toBeUndefined();
    },
  );

  it('creates a live USD to CNY command', async () => {
    const command = await createQuickConverterCommand('1美元', {
      exchangeRateProvider: {
        getUsdToCnyRate: vi.fn(async () => ({
          fetchedAt: '2026-05-18T00:00:00.000Z',
          provider: 'Frankfurter',
          rate: 7.1234,
          source: 'live',
          updatedAt: '2026-05-18',
        })),
      },
    });

    expect(command).toMatchObject({
      title: '1 美元 ≈ 7.12 人民币',
      subtitle: '实时汇率 · 更新时间 2026-05-18',
      action: { type: 'copy-text', payload: { text: '1 美元 ≈ 7.12 人民币' } },
    });
  });

  it('uses cached USD to CNY fallback when provider returns cached data', async () => {
    const command = await createQuickConverterCommand('2 USD', {
      exchangeRateProvider: {
        getUsdToCnyRate: vi.fn(async () => ({
          fetchedAt: '2026-05-18T00:00:00.000Z',
          provider: 'Frankfurter',
          rate: 7.1,
          source: 'cache',
          updatedAt: '2026-05-17',
        })),
      },
    });

    expect(command).toMatchObject({
      title: '2 美元 ≈ 14.20 人民币',
      subtitle: '缓存汇率 · 更新时间 2026-05-17',
    });
  });

  it('returns no command when currency rate is unavailable', async () => {
    await expect(
      createQuickConverterCommand('1美元', {
        exchangeRateProvider: { getUsdToCnyRate: vi.fn(async () => undefined) },
      }),
    ).resolves.toBeUndefined();
  });
});
