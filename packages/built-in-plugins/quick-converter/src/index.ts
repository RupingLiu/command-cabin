import type { Command } from '@command-cabin/core';

export const QUICK_CONVERTER_RESULT_COMMAND_ID = 'quick-converter.result';
export const QUICK_CONVERTER_PLUGIN_ID = 'quick-converter';

export type ParsedConversionKind = 'length' | 'weight' | 'currency' | 'volume';

export type ParsedConversionUnit =
  | 'centimeter'
  | 'inch'
  | 'millimeter'
  | 'meter'
  | 'kilogram'
  | 'gram'
  | 'pound'
  | 'liter'
  | 'milliliter'
  | 'cubicMeter'
  | 'cubicCentimeter'
  | 'usd';

export interface ParsedConversionQuery {
  amount: number;
  kind: ParsedConversionKind;
  unit: ParsedConversionUnit;
}

type ParsedLengthUnit = Extract<ParsedConversionUnit, 'centimeter' | 'inch' | 'millimeter' | 'meter'>;

interface ParsedVolumeDimension {
  amount: number;
  unit: ParsedLengthUnit;
}

interface ParsedVolumeCalculation {
  dimensions: [ParsedVolumeDimension, ParsedVolumeDimension, ParsedVolumeDimension];
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
  /^\s*(?<amount>\d+(?:\.\d+)?|\.\d+)\s*(?<unit>[A-Za-z0-9³]+|[\u4e00-\u9fff]+)\s*$/u;
const VOLUME_EXPRESSION_SEPARATOR_PATTERN = /\s*(?:\*|x|×)\s*/iu;

const CENTIMETERS_PER_METER = 100;
const CENTIMETERS_PER_INCH = 2.54;
const MILLIMETERS_PER_CENTIMETER = 10;
const MILLIMETERS_PER_METER = 1_000;
const POUNDS_PER_KILOGRAM = 2.20462;
const KILOGRAMS_PER_POUND = 0.453592;
const GRAMS_PER_KILOGRAM = 1_000;
const MILLILITERS_PER_LITER = 1_000;
const LITERS_PER_CUBIC_METER = 1_000;
const CUBIC_CENTIMETERS_PER_MILLILITER = 1;

const UNIT_ALIASES = new Map<string, ParsedConversionUnit>([
  ['cm', 'centimeter'],
  ['厘米', 'centimeter'],
  ['公分', 'centimeter'],
  ['in', 'inch'],
  ['inch', 'inch'],
  ['inches', 'inch'],
  ['英寸', 'inch'],
  ['吋', 'inch'],
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
  ['l', 'liter'],
  ['liter', 'liter'],
  ['liters', 'liter'],
  ['litre', 'liter'],
  ['litres', 'liter'],
  ['升', 'liter'],
  ['公升', 'liter'],
  ['ml', 'milliliter'],
  ['milliliter', 'milliliter'],
  ['milliliters', 'milliliter'],
  ['millilitre', 'milliliter'],
  ['millilitres', 'milliliter'],
  ['毫升', 'milliliter'],
  ['m3', 'cubicMeter'],
  ['m³', 'cubicMeter'],
  ['立方米', 'cubicMeter'],
  ['cm3', 'cubicCentimeter'],
  ['cm³', 'cubicCentimeter'],
  ['cc', 'cubicCentimeter'],
  ['立方厘米', 'cubicCentimeter'],
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

  if (parsed !== undefined && parsed.kind !== 'currency') {
    return createCopyTextCommand(formatStaticConversion(parsed), query);
  }

  const volumeCalculation = parseVolumeCalculation(query);

  if (volumeCalculation === undefined) {
    return undefined;
  }

  return createCopyTextCommand(formatVolumeCalculation(volumeCalculation), query);
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
    case 'inch':
    case 'millimeter':
    case 'meter':
      return 'length';
    case 'kilogram':
    case 'gram':
    case 'pound':
      return 'weight';
    case 'liter':
    case 'milliliter':
    case 'cubicMeter':
    case 'cubicCentimeter':
      return 'volume';
    case 'usd':
      return 'currency';
  }
}

function formatStaticConversion(parsed: ParsedConversionQuery): string {
  switch (parsed.kind) {
    case 'length':
      return formatLengthConversion(parsed);
    case 'weight':
      return formatWeightConversion(parsed);
    case 'volume':
      return formatVolumeConversion(parsed);
    case 'currency':
      return '';
  }
}

function formatLengthConversion(parsed: ParsedConversionQuery): string {
  switch (parsed.unit) {
    case 'centimeter':
      return `${formatConciseDecimal(parsed.amount)} 厘米 = ${formatSignificantDecimal(
        parsed.amount * MILLIMETERS_PER_CENTIMETER,
      )} 毫米 = ${formatSignificantDecimal(
        parsed.amount / CENTIMETERS_PER_METER,
      )} 米 = ${formatSignificantDecimal(parsed.amount / CENTIMETERS_PER_INCH)} 英寸`;
    case 'inch': {
      const centimeters = parsed.amount * CENTIMETERS_PER_INCH;

      return `${formatConciseDecimal(parsed.amount)} 英寸 = ${formatSignificantDecimal(
        centimeters,
      )} 厘米 = ${formatSignificantDecimal(
        centimeters * MILLIMETERS_PER_CENTIMETER,
      )} 毫米 = ${formatSignificantDecimal(centimeters / CENTIMETERS_PER_METER)} 米`;
    }
    case 'millimeter':
      return `${formatConciseDecimal(parsed.amount)} 毫米 = ${formatSignificantDecimal(
        parsed.amount / MILLIMETERS_PER_CENTIMETER,
      )} 厘米 = ${formatSignificantDecimal(
        parsed.amount / MILLIMETERS_PER_METER,
      )} 米 = ${formatSignificantDecimal(
        parsed.amount / MILLIMETERS_PER_CENTIMETER / CENTIMETERS_PER_INCH,
      )} 英寸`;
    case 'meter':
      return `${formatConciseDecimal(parsed.amount)} 米 = ${formatSignificantDecimal(
        parsed.amount * CENTIMETERS_PER_METER,
      )} 厘米 = ${formatSignificantDecimal(
        parsed.amount * MILLIMETERS_PER_METER,
      )} 毫米 = ${formatSignificantDecimal(
        (parsed.amount * CENTIMETERS_PER_METER) / CENTIMETERS_PER_INCH,
      )} 英寸`;
    default:
      return '';
  }
}

function parseVolumeCalculation(query: string): ParsedVolumeCalculation | undefined {
  const parts = query.trim().split(VOLUME_EXPRESSION_SEPARATOR_PATTERN);

  if (parts.length !== 3) {
    return undefined;
  }

  const dimensions = parts.map(parseVolumeDimension);

  if (dimensions.some((dimension) => dimension === undefined)) {
    return undefined;
  }

  return {
    dimensions: dimensions as [ParsedVolumeDimension, ParsedVolumeDimension, ParsedVolumeDimension],
  };
}

function parseVolumeDimension(query: string): ParsedVolumeDimension | undefined {
  const parsed = parseConversionQuery(query);

  if (parsed === undefined || parsed.kind !== 'length') {
    return undefined;
  }

  return {
    amount: parsed.amount,
    unit: parsed.unit as ParsedLengthUnit,
  };
}

function formatVolumeCalculation(parsed: ParsedVolumeCalculation): string {
  const cubicCentimeters = parsed.dimensions
    .map((dimension) => convertLengthToCentimeters(dimension))
    .reduce((volume, length) => volume * length, 1);

  return `${parsed.dimensions
    .map(formatLengthDimension)
    .join(' × ')} = ${formatVolumeFromCubicCentimeters(cubicCentimeters)}`;
}

function formatLengthDimension(dimension: ParsedVolumeDimension): string {
  switch (dimension.unit) {
    case 'centimeter':
      return `${formatConciseDecimal(dimension.amount)} 厘米`;
    case 'inch':
      return `${formatConciseDecimal(dimension.amount)} 英寸`;
    case 'millimeter':
      return `${formatConciseDecimal(dimension.amount)} 毫米`;
    case 'meter':
      return `${formatConciseDecimal(dimension.amount)} 米`;
  }
}

function convertLengthToCentimeters(dimension: ParsedVolumeDimension): number {
  switch (dimension.unit) {
    case 'centimeter':
      return dimension.amount;
    case 'inch':
      return dimension.amount * CENTIMETERS_PER_INCH;
    case 'millimeter':
      return dimension.amount / MILLIMETERS_PER_CENTIMETER;
    case 'meter':
      return dimension.amount * CENTIMETERS_PER_METER;
  }
}

function formatVolumeConversion(parsed: ParsedConversionQuery): string {
  switch (parsed.unit) {
    case 'liter':
      return `${formatConciseDecimal(parsed.amount)} 升 = ${formatSignificantDecimal(
        parsed.amount * MILLILITERS_PER_LITER,
      )} 毫升 = ${formatSignificantDecimal(
        parsed.amount / LITERS_PER_CUBIC_METER,
      )} 立方米 = ${formatSignificantDecimal(
        parsed.amount * MILLILITERS_PER_LITER * CUBIC_CENTIMETERS_PER_MILLILITER,
      )} 立方厘米`;
    case 'milliliter':
      return `${formatConciseDecimal(parsed.amount)} 毫升 = ${formatSignificantDecimal(
        parsed.amount / MILLILITERS_PER_LITER,
      )} 升 = ${formatSignificantDecimal(
        parsed.amount * CUBIC_CENTIMETERS_PER_MILLILITER,
      )} 立方厘米 = ${formatSignificantDecimal(
        parsed.amount / MILLILITERS_PER_LITER / LITERS_PER_CUBIC_METER,
      )} 立方米`;
    case 'cubicMeter':
      return `${formatConciseDecimal(parsed.amount)} 立方米 = ${formatSignificantDecimal(
        parsed.amount * LITERS_PER_CUBIC_METER,
      )} 升 = ${formatSignificantDecimal(
        parsed.amount * LITERS_PER_CUBIC_METER * MILLILITERS_PER_LITER,
      )} 毫升 = ${formatSignificantDecimal(
        parsed.amount *
          LITERS_PER_CUBIC_METER *
          MILLILITERS_PER_LITER *
          CUBIC_CENTIMETERS_PER_MILLILITER,
      )} 立方厘米`;
    case 'cubicCentimeter':
      return `${formatConciseDecimal(parsed.amount)} 立方厘米 = ${formatSignificantDecimal(
        parsed.amount / CUBIC_CENTIMETERS_PER_MILLILITER,
      )} 毫升 = ${formatSignificantDecimal(
        parsed.amount / CUBIC_CENTIMETERS_PER_MILLILITER / MILLILITERS_PER_LITER,
      )} 升 = ${formatSignificantDecimal(
        parsed.amount /
          CUBIC_CENTIMETERS_PER_MILLILITER /
          MILLILITERS_PER_LITER /
          LITERS_PER_CUBIC_METER,
      )} 立方米`;
    default:
      return '';
  }
}

function formatVolumeFromCubicCentimeters(cubicCentimeters: number): string {
  return `${formatSignificantDecimal(cubicCentimeters)} 立方厘米 = ${formatSignificantDecimal(
    cubicCentimeters / CUBIC_CENTIMETERS_PER_MILLILITER,
  )} 毫升 = ${formatSignificantDecimal(
    cubicCentimeters / CUBIC_CENTIMETERS_PER_MILLILITER / MILLILITERS_PER_LITER,
  )} 升 = ${formatSignificantDecimal(
    cubicCentimeters /
      CUBIC_CENTIMETERS_PER_MILLILITER /
      MILLILITERS_PER_LITER /
      LITERS_PER_CUBIC_METER,
  )} 立方米`;
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
