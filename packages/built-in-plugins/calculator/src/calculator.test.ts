import { describe, expect, it } from 'vitest';

import { createCalculatorResultCommand, evaluateExpression } from './index.js';

describe('calculator built-in plugin', () => {
  it.each([
    ['1 + 2', '3'],
    ['2 * (3 + 4)', '14'],
    [' 10 / 4 ', '2.5'],
    ['.5 + 1.25', '1.75'],
    ['-(2 + 3) * +4', '-20'],
  ])('evaluates %s', (expression, expectedResult) => {
    expect(evaluateExpression(expression)).toBe(expectedResult);
  });

  it.each(['', '   ', '1 +', '2 ** 3', 'abc', '1 / 0', '(1 + 2', '1 2'])(
    'rejects invalid expression %s',
    (expression) => {
      expect(evaluateExpression(expression)).toBeUndefined();
    },
  );

  it('rejects expressions with excessive nesting without throwing', () => {
    const expression = `${'('.repeat(200)}1${')'.repeat(200)}`;

    expect(() => evaluateExpression(expression)).not.toThrow();
    expect(evaluateExpression(expression)).toBeUndefined();
    expect(createCalculatorResultCommand(expression)).toBeUndefined();
  });

  it('rejects expressions with excessive unary operators without throwing', () => {
    const expression = `${'+'.repeat(200)}1`;

    expect(() => evaluateExpression(expression)).not.toThrow();
    expect(evaluateExpression(expression)).toBeUndefined();
    expect(createCalculatorResultCommand(expression)).toBeUndefined();
  });

  it('creates a copy-text command for valid calculator input', () => {
    expect(createCalculatorResultCommand('1 + 2')).toMatchObject({
      action: {
        payload: {
          text: '3',
        },
        type: 'copy-text',
      },
      id: 'calculator.result',
      source: 'plugin',
      subtitle: 'Copy result to clipboard',
      title: '3',
    });
  });

  it('does not create a command for invalid calculator input', () => {
    expect(createCalculatorResultCommand('1 +')).toBeUndefined();
  });
});
