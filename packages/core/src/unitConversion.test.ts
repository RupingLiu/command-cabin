import { describe, expect, it } from 'vitest';

import {
  convertUnitValue,
  formatUnitConversionValue,
  getDefaultUnitPair,
  getUnitsForCategory,
} from './unitConversion.js';

describe('unit conversion model', () => {
  it('returns default unit pairs for each category', () => {
    expect(getDefaultUnitPair('weight')).toEqual({ from: 'kg', to: 'lb' });
    expect(getDefaultUnitPair('length')).toEqual({ from: 'cm', to: 'inch' });
  });

  it('returns units for each category', () => {
    expect(getUnitsForCategory('weight').map((unit) => unit.id)).toEqual([
      'kg',
      'g',
      'mg',
      'lb',
      'oz',
    ]);
    expect(getUnitsForCategory('length').map((unit) => unit.id)).toEqual([
      'cm',
      'mm',
      'm',
      'inch',
      'ft',
    ]);
  });

  it('converts kg to lb', () => {
    expect(convertUnitValue({ category: 'weight', from: 'kg', to: 'lb', value: 1 })).toBeCloseTo(
      2.2046226218487757,
    );
  });

  it('converts cm to inch', () => {
    expect(
      convertUnitValue({ category: 'length', from: 'cm', to: 'inch', value: 2.54 }),
    ).toBeCloseTo(1);
  });

  it('converts g, mg, and oz weight units', () => {
    expect(convertUnitValue({ category: 'weight', from: 'g', to: 'kg', value: 500 })).toBeCloseTo(
      0.5,
    );
    expect(convertUnitValue({ category: 'weight', from: 'mg', to: 'g', value: 1000 })).toBeCloseTo(
      1,
    );
    expect(convertUnitValue({ category: 'weight', from: 'oz', to: 'g', value: 16 })).toBeCloseTo(
      453.59237,
    );
  });

  it('converts m, mm, and ft length units', () => {
    expect(convertUnitValue({ category: 'length', from: 'm', to: 'cm', value: 1 })).toBeCloseTo(
      100,
    );
    expect(convertUnitValue({ category: 'length', from: 'mm', to: 'm', value: 2500 })).toBeCloseTo(
      2.5,
    );
    expect(convertUnitValue({ category: 'length', from: 'ft', to: 'inch', value: 3 })).toBeCloseTo(
      36,
    );
  });

  it('rejects cross-category unit conversion', () => {
    expect(() => convertUnitValue({ category: 'weight', from: 'kg', to: 'cm', value: 1 })).toThrow(
      'Cannot convert between units from different categories',
    );
  });

  it('formats values with six significant digits and normalizes negative zero', () => {
    expect(formatUnitConversionValue(1.0000000000000002)).toBe('1');
    expect(formatUnitConversionValue(1 / 3)).toBe('0.333333');
    expect(formatUnitConversionValue(-0)).toBe('0');
  });
});
