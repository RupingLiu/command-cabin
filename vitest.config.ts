import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@command-cabin/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
      '@command-cabin/built-in-plugin-calculator': fileURLToPath(
        new URL('./packages/built-in-plugins/calculator/src/index.ts', import.meta.url),
      ),
      '@command-cabin/built-in-plugin-clipboard-history': fileURLToPath(
        new URL('./packages/built-in-plugins/clipboard-history/src/index.ts', import.meta.url),
      ),
    },
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
