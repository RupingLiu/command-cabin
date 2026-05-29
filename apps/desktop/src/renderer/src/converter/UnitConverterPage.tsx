import { useReducer } from 'react';

import type { CommandCabinLanguage } from '@command-cabin/core';
import {
  convertUnitValue,
  formatUnitConversionValue,
  getDefaultUnitPair,
  getUnitsForCategory,
  type UnitDefinition,
  type UnitConversionCategory,
  type UnitId,
} from '@command-cabin/core/unitConversion';

import { getUiStrings, type UiStrings } from '../i18n.js';

type EditedSide = 'from' | 'to';

export interface UnitConverterState {
  category: UnitConversionCategory;
  fromUnit: UnitId;
  fromValue: string;
  lastEditedSide: EditedSide;
  toUnit: UnitId;
  toValue: string;
}

type UnitConverterAction =
  | {
      category: UnitConversionCategory;
      type: 'category-changed';
    }
  | {
      side: EditedSide;
      type: 'value-changed';
      value: string;
    }
  | {
      side: EditedSide;
      type: 'unit-changed';
      unit: UnitId;
    }
  | {
      type: 'units-swapped';
    };

export interface UnitConverterPageProps {
  language?: CommandCabinLanguage | undefined;
  onReturnToLauncher: () => void;
}

export function createInitialUnitConverterState(): UnitConverterState {
  const defaultPair = getDefaultUnitPair('weight');

  return {
    category: 'weight',
    fromUnit: defaultPair.from,
    fromValue: '',
    lastEditedSide: 'from',
    toUnit: defaultPair.to,
    toValue: '',
  };
}

function isNumericInput(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }

  return Number.isFinite(Number(value));
}

function calculateConvertedValue(
  category: UnitConversionCategory,
  from: UnitId,
  to: UnitId,
  value: string,
): string {
  if (!isNumericInput(value)) {
    return '';
  }

  return formatUnitConversionValue(
    convertUnitValue({
      category,
      from,
      to,
      value: Number(value),
    }),
  );
}

function recalculateState(state: UnitConverterState): UnitConverterState {
  if (state.lastEditedSide === 'from') {
    return {
      ...state,
      toValue: calculateConvertedValue(
        state.category,
        state.fromUnit,
        state.toUnit,
        state.fromValue,
      ),
    };
  }

  return {
    ...state,
    fromValue: calculateConvertedValue(state.category, state.toUnit, state.fromUnit, state.toValue),
  };
}

export function getDisplayedUnitConversionValues(state: UnitConverterState): {
  fromValue: string;
  toValue: string;
} {
  return {
    fromValue: state.fromValue,
    toValue: state.toValue,
  };
}

export function formatUnitOptionLabel(unit: UnitDefinition, strings: UiStrings): string {
  const unitName = strings.unitConverter.unitLabels[unit.id].trim();

  return unitName ? `${unitName} ${unit.symbol}` : unit.symbol;
}

export function unitConverterReducer(
  state: UnitConverterState,
  action: UnitConverterAction,
): UnitConverterState {
  switch (action.type) {
    case 'category-changed': {
      const defaultPair = getDefaultUnitPair(action.category);

      return {
        category: action.category,
        fromUnit: defaultPair.from,
        fromValue: '',
        lastEditedSide: 'from',
        toUnit: defaultPair.to,
        toValue: '',
      };
    }
    case 'value-changed': {
      const nextState =
        action.side === 'from'
          ? {
              ...state,
              fromValue: action.value,
              lastEditedSide: action.side,
            }
          : {
              ...state,
              lastEditedSide: action.side,
              toValue: action.value,
            };

      return recalculateState(nextState);
    }
    case 'unit-changed': {
      const nextState =
        action.side === 'from'
          ? {
              ...state,
              fromUnit: action.unit,
            }
          : {
              ...state,
              toUnit: action.unit,
            };

      return recalculateState(nextState);
    }
    case 'units-swapped':
      return {
        ...state,
        fromUnit: state.toUnit,
        fromValue: state.toValue,
        lastEditedSide: state.lastEditedSide === 'from' ? 'to' : 'from',
        toUnit: state.fromUnit,
        toValue: state.fromValue,
      };
  }
}

export function UnitConverterPage({ language, onReturnToLauncher }: UnitConverterPageProps) {
  const strings = getUiStrings(language);
  const [state, dispatch] = useReducer(unitConverterReducer, undefined, () =>
    createInitialUnitConverterState(),
  );
  const units = getUnitsForCategory(state.category);

  return (
    <main className="converter-shell">
      <section className="converter-frame" aria-label={strings.unitConverter.ariaLabel}>
        <header className="converter-titlebar">
          <div>
            <h1>{strings.unitConverter.title}</h1>
          </div>
          <button className="converter-back" type="button" onClick={onReturnToLauncher}>
            {strings.unitConverter.back}
          </button>
        </header>

        <div className="converter-categories" aria-label={strings.unitConverter.categoryLabel}>
          {(['weight', 'length'] as const).map((category) => (
            <button
              key={category}
              type="button"
              value={category}
              data-selected={state.category === category}
              onClick={() => {
                dispatch({
                  category,
                  type: 'category-changed',
                });
              }}
            >
              {strings.unitConverter.categories[category]}
            </button>
          ))}
        </div>

        <div className="converter-grid">
          <label className="converter-value">
            <span>{strings.unitConverter.fromValue}</span>
            <input
              inputMode="decimal"
              value={state.fromValue}
              onChange={(event) => {
                dispatch({
                  side: 'from',
                  type: 'value-changed',
                  value: event.currentTarget.value,
                });
              }}
            />
            <select
              aria-label={strings.unitConverter.fromUnit}
              value={state.fromUnit}
              onChange={(event) => {
                dispatch({
                  side: 'from',
                  type: 'unit-changed',
                  unit: event.currentTarget.value as UnitId,
                });
              }}
            >
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {formatUnitOptionLabel(unit, strings)}
                </option>
              ))}
            </select>
          </label>

          <button
            aria-label={strings.unitConverter.swap}
            className="converter-swap"
            type="button"
            onClick={() => {
              dispatch({
                type: 'units-swapped',
              });
            }}
          >
            ⇄
          </button>

          <label className="converter-value">
            <span>{strings.unitConverter.toValue}</span>
            <input
              inputMode="decimal"
              value={state.toValue}
              onChange={(event) => {
                dispatch({
                  side: 'to',
                  type: 'value-changed',
                  value: event.currentTarget.value,
                });
              }}
            />
            <select
              aria-label={strings.unitConverter.toUnit}
              value={state.toUnit}
              onChange={(event) => {
                dispatch({
                  side: 'to',
                  type: 'unit-changed',
                  unit: event.currentTarget.value as UnitId,
                });
              }}
            >
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {formatUnitOptionLabel(unit, strings)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    </main>
  );
}
