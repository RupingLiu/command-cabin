export type UnitConversionCategory = 'weight' | 'length';

export type WeightUnitId = 'kg' | 'g' | 'mg' | 'lb' | 'oz';
export type LengthUnitId = 'cm' | 'mm' | 'm' | 'inch' | 'ft';
export type UnitId = WeightUnitId | LengthUnitId;

export type UnitDefinition = {
  id: UnitId;
  symbol: string;
  category: UnitConversionCategory;
  toBaseFactor: number;
};

export type UnitConversionInput = {
  category: UnitConversionCategory;
  from: UnitId;
  to: UnitId;
  value: number;
};

type DefaultUnitPair = {
  from: UnitId;
  to: UnitId;
};

const WEIGHT_UNITS = [
  { id: 'kg', symbol: 'kg', category: 'weight', toBaseFactor: 1 },
  { id: 'g', symbol: 'g', category: 'weight', toBaseFactor: 0.001 },
  { id: 'mg', symbol: 'mg', category: 'weight', toBaseFactor: 0.000001 },
  { id: 'lb', symbol: 'lb', category: 'weight', toBaseFactor: 0.45359237 },
  { id: 'oz', symbol: 'oz', category: 'weight', toBaseFactor: 0.028349523125 },
] as const satisfies readonly UnitDefinition[];

const LENGTH_UNITS = [
  { id: 'cm', symbol: 'cm', category: 'length', toBaseFactor: 0.01 },
  { id: 'mm', symbol: 'mm', category: 'length', toBaseFactor: 0.001 },
  { id: 'm', symbol: 'm', category: 'length', toBaseFactor: 1 },
  { id: 'inch', symbol: 'inch', category: 'length', toBaseFactor: 0.0254 },
  { id: 'ft', symbol: 'ft', category: 'length', toBaseFactor: 0.3048 },
] as const satisfies readonly UnitDefinition[];

const UNITS_BY_CATEGORY = {
  weight: WEIGHT_UNITS,
  length: LENGTH_UNITS,
} as const satisfies Record<UnitConversionCategory, readonly UnitDefinition[]>;

const DEFAULT_UNIT_PAIRS = {
  weight: { from: 'kg', to: 'lb' },
  length: { from: 'cm', to: 'inch' },
} as const satisfies Record<UnitConversionCategory, DefaultUnitPair>;

export function getDefaultUnitPair(category: UnitConversionCategory): DefaultUnitPair {
  return DEFAULT_UNIT_PAIRS[category];
}

export function getUnitsForCategory(category: UnitConversionCategory): readonly UnitDefinition[] {
  return UNITS_BY_CATEGORY[category];
}

export function convertUnitValue(input: UnitConversionInput): number {
  const fromUnit = findUnitInCategory(input.category, input.from);
  const toUnit = findUnitInCategory(input.category, input.to);

  return (input.value * fromUnit.toBaseFactor) / toUnit.toBaseFactor;
}

export function formatUnitConversionValue(value: number): string {
  const normalizedValue = Object.is(value, -0) ? 0 : value;

  return Number(normalizedValue.toPrecision(6)).toString();
}

function findUnitInCategory(category: UnitConversionCategory, unitId: UnitId): UnitDefinition {
  const unit = getUnitsForCategory(category).find((candidate) => candidate.id === unitId);

  if (!unit) {
    throw new Error(
      `Cannot convert between units from different categories: ${unitId} is not a ${category} unit.`,
    );
  }

  return unit;
}
