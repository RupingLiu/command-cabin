import type { Command } from '@command-cabin/core';

import { evaluateExpression } from './evaluateExpression.js';

export { evaluateExpression } from './evaluateExpression.js';

export const CALCULATOR_RESULT_COMMAND_ID = 'calculator.result';
export const CALCULATOR_PLUGIN_ID = 'calculator';

export function createCalculatorResultCommand(query: string): Command | undefined {
  const result = evaluateExpression(query);

  if (result === undefined) {
    return undefined;
  }

  return {
    id: CALCULATOR_RESULT_COMMAND_ID,
    source: 'plugin',
    title: result,
    subtitle: 'Copy result to clipboard',
    keywords: ['calculator', 'math', query, result],
    pluginId: CALCULATOR_PLUGIN_ID,
    action: {
      type: 'copy-text',
      payload: {
        text: result,
      },
    },
  };
}
