import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@command-cabin/core/unitConversion',
        replacement: fileURLToPath(
          new URL('./packages/core/src/unitConversion.ts', import.meta.url),
        ),
      },
      {
        find: '@command-cabin/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
      {
        find: '@command-cabin/built-in-plugin-calculator',
        replacement: fileURLToPath(
          new URL('./packages/built-in-plugins/calculator/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@command-cabin/built-in-plugin-quick-converter',
        replacement: fileURLToPath(
          new URL('./packages/built-in-plugins/quick-converter/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@command-cabin/built-in-plugin-clipboard-history',
        replacement: fileURLToPath(
          new URL('./packages/built-in-plugins/clipboard-history/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@command-cabin/built-in-plugin-text-tools',
        replacement: fileURLToPath(
          new URL('./packages/built-in-plugins/text-tools/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
    ],
  },
});
