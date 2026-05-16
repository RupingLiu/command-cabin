import { describe, expect, it } from 'vitest';

import { createCalculatorResultCommand } from '@command-cabin/built-in-plugin-calculator';

describe('calculator built-in plugin', () => {
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
