import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const productionConnectSrc = "connect-src 'self';";
const devConnectSrc =
  "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*;";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/preload/index.ts'),
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(projectRoot, 'src/renderer'),
    plugins: [
      react(),
      {
        name: 'command-cabin-dev-csp',
        apply: 'serve',
        transformIndexHtml: (html) => html.replace(productionConnectSrc, devConnectSrc),
      },
    ],
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/renderer/index.html'),
      },
    },
  },
});
