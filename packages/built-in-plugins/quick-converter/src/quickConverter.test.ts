import { describe, expect, it, vi } from 'vitest';

import {
  createQuickConverterCommand,
  createStaticConversionCommand,
  parseConversionQuery,
} from './index.js';

describe('quick converter built-in plugin', () => {
  it.each([
    ['1厘米', '1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸'],
    ['1 cm', '1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸'],
    ['1公分', '1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸'],
    ['25毫米', '25 毫米 = 2.5 厘米 = 0.025 米 = 0.984252 英寸'],
    ['2.5 m', '2.5 米 = 250 厘米 = 2500 毫米 = 98.4252 英寸'],
    ['1 inch', '1 英寸 = 2.54 厘米 = 25.4 毫米 = 0.0254 米'],
    ['2英寸', '2 英寸 = 5.08 厘米 = 50.8 毫米 = 0.0508 米'],
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
    ['1升', '1 升 = 1000 毫升 = 0.001 立方米 = 1000 立方厘米'],
    ['1 L', '1 升 = 1000 毫升 = 0.001 立方米 = 1000 立方厘米'],
    ['500毫升', '500 毫升 = 0.5 升 = 500 立方厘米 = 0.0005 立方米'],
    ['2 m3', '2 立方米 = 2000 升 = 2000000 毫升 = 2000000 立方厘米'],
    ['2m³', '2 立方米 = 2000 升 = 2000000 毫升 = 2000000 立方厘米'],
    ['250cm3', '250 立方厘米 = 250 毫升 = 0.25 升 = 0.00025 立方米'],
    ['250cc', '250 立方厘米 = 250 毫升 = 0.25 升 = 0.00025 立方米'],
  ])('converts volume query %s', (query, expected) => {
    expect(createStaticConversionCommand(query)).toMatchObject({ title: expected });
  });

  it.each([
    [
      '1cm * 1cm *1 cm',
      '1 厘米 × 1 厘米 × 1 厘米 = 1 立方厘米 = 1 毫升 = 0.001 升 = 0.000001 立方米',
    ],
    [
      '10 cm x 20 cm x 3 cm',
      '10 厘米 × 20 厘米 × 3 厘米 = 600 立方厘米 = 600 毫升 = 0.6 升 = 0.0006 立方米',
    ],
    [
      '1m × 20cm × 30mm',
      '1 米 × 20 厘米 × 30 毫米 = 6000 立方厘米 = 6000 毫升 = 6 升 = 0.006 立方米',
    ],
    [
      '1in * 2in * 3in',
      '1 英寸 × 2 英寸 × 3 英寸 = 98.3224 立方厘米 = 98.3224 毫升 = 0.0983224 升 = 0.0000983224 立方米',
    ],
  ])('calculates volume expression %s', (query, expected) => {
    expect(createStaticConversionCommand(query)).toMatchObject({ title: expected });
  });

  it.each([
    ['1厘米', 'length', 'centimeter'],
    ['1 mm', 'length', 'millimeter'],
    ['1米', 'length', 'meter'],
    ['1 in', 'length', 'inch'],
    ['1 inch', 'length', 'inch'],
    ['1英寸', 'length', 'inch'],
    ['2.5kg', 'weight', 'kilogram'],
    ['100 克', 'weight', 'gram'],
    ['1 lbs', 'weight', 'pound'],
    ['1升', 'volume', 'liter'],
    ['1 ml', 'volume', 'milliliter'],
    ['1立方米', 'volume', 'cubicMeter'],
    ['1 m3', 'volume', 'cubicMeter'],
    ['1 m³', 'volume', 'cubicMeter'],
    ['1立方厘米', 'volume', 'cubicCentimeter'],
    ['1 cm3', 'volume', 'cubicCentimeter'],
    ['1 cm³', 'volume', 'cubicCentimeter'],
    ['1 cc', 'volume', 'cubicCentimeter'],
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
