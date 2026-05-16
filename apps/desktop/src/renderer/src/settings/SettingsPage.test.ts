import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SettingsPage } from './SettingsPage.js';

describe('SettingsPage', () => {
  it('composes the operational settings sections', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, {
        onReturnToLauncher: vi.fn(),
      }),
    );

    expect(markup).toContain('CommandCabin');
    expect(markup).toContain('Hotkey');
    expect(markup).toContain('Theme');
    expect(markup).toContain('Plugin Management');
    expect(markup).toContain('Data Directory');
    expect(markup).toContain('Favorites');
    expect(markup).toContain('Clipboard History');
  });
});
