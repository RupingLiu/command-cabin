import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createInitialUnitConverterState,
  getDisplayedUnitConversionValues,
  unitConverterReducer,
  UnitConverterPage,
} from './UnitConverterPage.js';

describe('UnitConverterPage', () => {
  it('renders the default weight conversion state', () => {
    const html = renderToStaticMarkup(
      createElement(UnitConverterPage, {
        language: 'en-US',
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(html).toContain('Unit Converter');
    expect(html).toContain('value="weight"');
    expect(html).toContain('value="kg" selected=""');
    expect(html).toContain('value="lb" selected=""');
  });

  it('converts 1 kg to 2.20462 lb', () => {
    const state = unitConverterReducer(createInitialUnitConverterState(), {
      side: 'from',
      type: 'value-changed',
      value: '1',
    });

    expect(getDisplayedUnitConversionValues(state)).toEqual({
      fromValue: '1',
      toValue: '2.20462',
    });
  });

  it('switches to the length default of cm to inch', () => {
    const state = unitConverterReducer(createInitialUnitConverterState(), {
      category: 'length',
      type: 'category-changed',
    });

    expect(state).toMatchObject({
      category: 'length',
      fromUnit: 'cm',
      toUnit: 'inch',
    });
  });

  it('swaps both units and values around the last edited side', () => {
    const typed = unitConverterReducer(createInitialUnitConverterState(), {
      side: 'from',
      type: 'value-changed',
      value: '1',
    });
    const swapped = unitConverterReducer(typed, {
      type: 'units-swapped',
    });

    expect(swapped).toMatchObject({
      fromUnit: 'lb',
      fromValue: '2.20462',
      lastEditedSide: 'to',
      toUnit: 'kg',
    });
    expect(getDisplayedUnitConversionValues(swapped)).toEqual({
      fromValue: '2.20462',
      toValue: '1',
    });
  });

  it('keeps the same physical value as the editing baseline after swapping', () => {
    const typed = unitConverterReducer(createInitialUnitConverterState(), {
      side: 'from',
      type: 'value-changed',
      value: '1',
    });
    const swapped = unitConverterReducer(typed, {
      type: 'units-swapped',
    });
    const changedUnit = unitConverterReducer(swapped, {
      side: 'from',
      type: 'unit-changed',
      unit: 'oz',
    });

    expect(getDisplayedUnitConversionValues(changedUnit)).toEqual({
      fromValue: '35.274',
      toValue: '1',
    });
  });

  it('recalculates from the last edited side when a unit select changes', () => {
    const typed = unitConverterReducer(createInitialUnitConverterState(), {
      side: 'from',
      type: 'value-changed',
      value: '1',
    });
    const changedUnit = unitConverterReducer(typed, {
      side: 'to',
      type: 'unit-changed',
      unit: 'oz',
    });

    expect(changedUnit.toUnit).toBe('oz');
    expect(getDisplayedUnitConversionValues(changedUnit)).toEqual({
      fromValue: '1',
      toValue: '35.274',
    });
  });

  it('clears the opposite side for invalid input without throwing', () => {
    const state = unitConverterReducer(createInitialUnitConverterState(), {
      side: 'from',
      type: 'value-changed',
      value: 'abc',
    });

    expect(getDisplayedUnitConversionValues(state)).toEqual({
      fromValue: 'abc',
      toValue: '',
    });
  });
});
