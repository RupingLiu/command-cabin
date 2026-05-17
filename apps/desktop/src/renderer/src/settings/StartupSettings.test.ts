import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { StartupSettings } from './StartupSettings.js';

describe('StartupSettings', () => {
  it('renders a launch-at-login toggle with the current enabled state', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupSettings, {
        value: true,
        onLaunchAtLoginChange: vi.fn(),
      }),
    );

    expect(markup).toContain('启动');
    expect(markup).toContain('开机自启动');
    expect(markup).toContain('checked=""');
  });
});
