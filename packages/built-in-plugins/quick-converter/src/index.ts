import type { Command } from '@command-cabin/core';

export const QUICK_CONVERTER_RESULT_COMMAND_ID = 'quick-converter.result';
export const QUICK_CONVERTER_PLUGIN_ID = 'quick-converter';

export type ParsedConversionKind = 'length' | 'weight' | 'currency';

export type ParsedConversionUnit =
  | 'centimeter'
  | 'millimeter'
  | 'meter'
  | 'kilogram'
  | 'gram'
  | 'pound'
  | 'usd';

export interface ParsedConversionQuery {
  amount: number;
  kind: ParsedConversionKind;
  unit: ParsedConversionUnit;
}

export type ExchangeRateResultSource = 'live' | 'cache';

export interface ExchangeRateResult {
  fetchedAt: string;
  provider: string;
  rate: number;
  source: ExchangeRateResultSource;
  updatedAt: string;
}

export interface ExchangeRateProvider {
  getUsdToCnyRate: () => Promise<ExchangeRateResult | undefined>;
}

export interface CreateQuickConverterCommandOptions {
  exchangeRateProvider?: ExchangeRateProvider | undefined;
}

const CONVERSION_QUERY_PATTERN =
  /^\s*(?<amount>\d+(?:\.\d+)?|\.\d+)\s*(?<unit>[A-Za-z]+|[\u4e00-\u9fff]+)\s*$/u;

const CENTIMETERS_PER_METER = 100;
const MILLIMETERS_PER_CENTIMETER = 10;
const MILLIMETERS_PER_METER = 1_000;
const POUNDS_PER_KILOGRAM = 2.20462;
const KILOGRAMS_PER_POUND = 0.453592;
const GRAMS_PER_KILOGRAM = 1_000;

const UNIT_ALIASES = new Map<string, ParsedConversionUnit>([
  ['cm', 'centimeter'],
  ['厘米', 'centimeter'],
  ['公分', 'centimeter'],
  ['mm', 'millimeter'],
  ['毫米', 'millimeter'],
  ['m', 'meter'],
  ['米', 'meter'],
  ['kg', 'kilogram'],
  ['千克', 'kilogram'],
  ['公斤', 'kilogram'],
  ['g', 'gram'],
  ['克', 'gram'],
  ['lb', 'pound'],
  ['lbs', 'pound'],
  ['磅', 'pound'],
  ['usd', 'usd'],
  ['美元', 'usd'],
  ['美金', 'usd'],
]);

export function parseConversionQuery(query: string): ParsedConversionQuery | undefined {
  const match = CONVERSION_QUERY_PATTERN.exec(query);
  const rawAmount = match?.groups?.amount;
  const rawUnit = match?.groups?.unit;

  if (rawAmount === undefined || rawUnit === undefined) {
    return undefined;
  }

  const amount = Number(rawAmount);
  const unit = UNIT_ALIASES.get(rawUnit.toLowerCase());

  if (!Number.isFinite(amount) || unit === undefined) {
    return undefined;
  }

  return {
    amount,
    kind: getUnitKind(unit),
    unit,
  };
}

export function createStaticConversionCommand(query: string): Command | undefined {
  const parsed = parseConversionQuery(query);

  if (parsed === undefined || parsed.kind === 'currency') {
    return undefined;
  }

  const title =
    parsed.kind === 'length' ? formatLengthConversion(parsed) : formatWeightConversion(parsed);

  return createCopyTextCommand(title, query);
}

export async function createQuickConverterCommand(
  query: string,
  options: CreateQuickConverterCommandOptions = {},
): Promise<Command | undefined> {
  const staticCommand = createStaticConversionCommand(query);

  if (staticCommand !== undefined) {
    return staticCommand;
  }

  const parsed = parseConversionQuery(query);

  if (parsed === undefined || parsed.kind !== 'currency') {
    return undefined;
  }

  const rate = await getUsdToCnyRate(options.exchangeRateProvider);

  if (rate === undefined || !Number.isFinite(rate.rate)) {
    return undefined;
  }

  const title = `${formatConciseDecimal(parsed.amount)} 美元 ≈ ${formatCurrency(
    parsed.amount * rate.rate,
  )} 人民币`;
  const subtitle = `${rate.source === 'live' ? '实时汇率' : '缓存汇率'} · 更新时间 ${rate.updatedAt}`;

  return createCopyTextCommand(title, query, subtitle);
}

function getUnitKind(unit: ParsedConversionUnit): ParsedConversionKind {
  switch (unit) {
    case 'centimeter':
    case 'millimeter':
    case 'meter':
      return 'length';
    case 'kilogram':
    case 'gram':
    case 'pound':
      return 'weight';
    case 'usd':
      return 'currency';
  }
}

function formatLengthConversion(parsed: ParsedConversionQuery): string {
  switch (parsed.unit) {
    case 'centimeter':
      return `${formatConciseDecimal(parsed.amount)} 厘米 = ${formatSignificantDecimal(
        parsed.amount * MILLIMETERS_PER_CENTIMETER,
      )} 毫米 = ${formatSignificantDecimal(parsed.amount / CENTIMETERS_PER_METER)} 米`;
    case 'millimeter':
      return `${formatConciseDecimal(parsed.amount)} 毫米 = ${formatSignificantDecimal(
        parsed.amount / MILLIMETERS_PER_CENTIMETER,
      )} 厘米 = ${formatSignificantDecimal(parsed.amount / MILLIMETERS_PER_METER)} 米`;
    case 'meter':
      return `${formatConciseDecimal(parsed.amount)} 米 = ${formatSignificantDecimal(
        parsed.amount * CENTIMETERS_PER_METER,
      )} 厘米 = ${formatSignificantDecimal(parsed.amount * MILLIMETERS_PER_METER)} 毫米`;
    default:
      return '';
  }
}

function formatWeightConversion(parsed: ParsedConversionQuery): string {
  switch (parsed.unit) {
    case 'kilogram':
      return `${formatConciseDecimal(parsed.amount)} 千克 = ${formatSignificantDecimal(
        parsed.amount * POUNDS_PER_KILOGRAM,
      )} 磅`;
    case 'gram':
      return `${formatConciseDecimal(parsed.amount)} 克 = ${formatSignificantDecimal(
        (parsed.amount / GRAMS_PER_KILOGRAM) * POUNDS_PER_KILOGRAM,
      )} 磅`;
    case 'pound':
      return `${formatConciseDecimal(parsed.amount)} 磅 = ${formatSignificantDecimal(
        parsed.amount * KILOGRAMS_PER_POUND,
      )} 千克 = ${formatSignificantDecimal(
        parsed.amount * KILOGRAMS_PER_POUND * GRAMS_PER_KILOGRAM,
      )} 克`;
    default:
      return '';
  }
}

async function getUsdToCnyRate(
  exchangeRateProvider: ExchangeRateProvider | undefined,
): Promise<ExchangeRateResult | undefined> {
  if (exchangeRateProvider === undefined) {
    return undefined;
  }

  try {
    return await exchangeRateProvider.getUsdToCnyRate();
  } catch {
    return undefined;
  }
}

function createCopyTextCommand(title: string, query: string, subtitle?: string): Command {
  const command: Command = {
    id: QUICK_CONVERTER_RESULT_COMMAND_ID,
    source: 'plugin',
    title,
    keywords: ['quick-converter', 'converter', 'conversion', query, title],
    pluginId: QUICK_CONVERTER_PLUGIN_ID,
    action: {
      type: 'copy-text',
      payload: {
        text: title,
      },
    },
  };

  if (subtitle !== undefined) {
    command.subtitle = subtitle;
  }

  return command;
}

function formatConciseDecimal(value: number): string {
  return normalizeNumber(value).toString();
}

function formatSignificantDecimal(value: number): string {
  return normalizeNumber(Number(value.toPrecision(6))).toString();
}

function formatCurrency(value: number): string {
  return value.toFixed(2);
}

function normalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
