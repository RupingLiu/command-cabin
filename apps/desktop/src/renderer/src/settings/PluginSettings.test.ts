import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PluginSettings } from './PluginSettings.js';

describe('PluginSettings', () => {
  it('renders plugin state with enable and uninstall controls', () => {
    const markup = renderToStaticMarkup(
      createElement(PluginSettings, {
        state: {
          errorMessage: undefined,
          isLoading: false,
          operationPluginId: undefined,
          plugins: [
            {
              id: 'com.example.text-tools',
              name: 'Text Tools',
              version: '0.1.0',
              main: 'dist/main.js',
              enabled: true,
              permissions: ['clipboard.read'],
              installedAt: '2026-05-15T10:00:00.000Z',
              updatedAt: '2026-05-15T10:00:00.000Z',
            },
          ],
        },
      }),
    );

    expect(markup).toContain('Plugin Management');
    expect(markup).toContain('Install local plugin');
    expect(markup).toContain('Text Tools');
    expect(markup).toContain('Disable');
    expect(markup).toContain('Uninstall');
  });

  it('renders empty and loading states accessibly', () => {
    const markup = renderToStaticMarkup(
      createElement(PluginSettings, {
        state: {
          errorMessage: undefined,
          isLoading: true,
          operationPluginId: undefined,
          plugins: [],
        },
      }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('No local plugins installed');
  });
});
