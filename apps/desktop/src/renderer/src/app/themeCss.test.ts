import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'App.css');

describe('app theme CSS', () => {
  it('drives launcher and settings surfaces from theme variables', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/^:root\s*{[^}]*--app-bg:/s);
    expect(css).toMatch(/\.launcher-shell\s*{[^}]*background:\s*var\(--app-bg\)/s);
    expect(css).toMatch(/\.search-field-wrap\s*{[^}]*background:\s*var\(--app-control-bg\)/s);
    expect(css).toMatch(/\.settings-shell\s*{[^}]*background:\s*var\(--app-bg\)/s);
  });

  it('uses the soft frosted palette instead of the old industrial grid palette', () => {
    const css = readFileSync(cssPath, 'utf8');
    const themeBlocks = [
      css.match(/^:root\s*{[^}]*}/s)?.[0] ?? '',
      css.match(/:root\[data-theme='dark'\]\s*{[^}]*}/s)?.[0] ?? '',
      css.match(/:root\[data-theme='light'\]\s*{[^}]*}/s)?.[0] ?? '',
    ].join('\n');

    expect(themeBlocks).not.toContain('repeating-linear-gradient');
    expect(css).toMatch(/--app-accent:\s*#ff4d36/i);
    expect(css).toMatch(/--app-secondary-accent:\s*#0a84ff/i);
    expect(css).toMatch(/--app-success:\s*#34c759/i);
    expect(css).toMatch(/--app-warm:\s*#ff9f0a/i);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{[^}]*--app-accent:\s*#ff8a1f/is);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{[^}]*--app-success:\s*#30d158/is);
    expect(css).toMatch(/^:root\s*{[^}]*linear-gradient\(\s*135deg/is);
    expect(css).toMatch(
      /:root\[data-theme='light'\]\s*{[^}]*--app-bg:[^}]*linear-gradient\(\s*135deg/is,
    );
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{[^}]*linear-gradient\(\s*135deg/is);
  });

  it('defines shared frosted surface tokens for app and screenshot UI', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/--app-surface-blur:\s*blur\(22px\) saturate\(1\.28\)/);
    expect(css).toMatch(/--app-radius-panel:\s*24px/);
    expect(css).toMatch(/--app-radius-control:\s*18px/);
    expect(css).toMatch(/--screenshot-toolbar-bg:\s*rgba\(18,\s*24,\s*38,\s*0\.74\)/);
    expect(css).toMatch(/--screenshot-accent:\s*#ff375f/i);
    expect(css).toMatch(/--screenshot-success:\s*#30d158/i);
  });

  it('styles screenshot overlay controls as dark frosted surfaces with contextual tool styles', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(
      /\.screenshot-selection\s*{[^}]*border:\s*1px solid var\(--screenshot-accent\)/s,
    );
    expect(css).toMatch(/\.screenshot-selection\s*{[^}]*border-radius:\s*0/s);
    expect(css).toMatch(/\.screenshot-toolbar\s*{[^}]*border-radius:\s*14px/s);
    expect(css).toMatch(/\.screenshot-toolbar\s*{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(
      /\.screenshot-toolbar\s*{[^}]*background:\s*var\(--screenshot-toolbar-bg\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-toolbar\s*{[^}]*backdrop-filter:\s*blur\(10px\) saturate\(1\.1\)/s,
    );
    expect(css).toMatch(/\.screenshot-toolbar\s*{[^}]*position:\s*relative/s);
    expect(css).toMatch(
      /\.screenshot-tool-style-popover\s*{[^}]*position:\s*absolute[^}]*top:\s*calc\(100% \+ 8px\)[^}]*background:\s*rgba\(18,\s*24,\s*38,\s*0\.88\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-tool-group\s+button:not\(:disabled\):not\(\.screenshot-color-swatch\):not\(\.screenshot-action-button--done\):not\(\s*\.screenshot-action-button--cancel\s*\):hover,\s*\.screenshot-tool-group\s+button:not\(:disabled\):not\(\.screenshot-color-swatch\):not\(\.screenshot-action-button--done\):not\(\s*\.screenshot-action-button--cancel\s*\)\[data-active='true'\]\s*{[^}]*var\(--screenshot-accent\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-tool-group button:disabled\s*{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.06\)[^}]*box-shadow:\s*none/s,
    );
    expect(css).toMatch(
      /\.screenshot-tool-group button:not\(:disabled\):focus-visible\s*{[^}]*outline:\s*none[^}]*0 0 0 3px rgba\(255,\s*55,\s*95,\s*0\.26\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-color-swatch:not\(:disabled\):hover\s*{[^}]*border-color:[^}]*box-shadow:/s,
    );
    expect(css).toMatch(
      /\.screenshot-color-swatch:not\(:disabled\)\[data-active='true'\]\s*{[^}]*0 0 0 2px var\(--screenshot-accent\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-style-group\s+button\.screenshot-color-swatch:not\(:disabled\)\[data-active='true'\]:focus-visible\s*{[^}]*inset 0 0 0 3px rgba\(15,\s*17,\s*23,\s*0\.86\)[^}]*0 0 0 5px rgba\(255,\s*55,\s*95,\s*0\.26\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-action-button--done:not\(:disabled\)\s*{[^}]*background:\s*rgba\(48,\s*209,\s*88,\s*0\.88\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-action-button--cancel\s*{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.1\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-tool-group button\.screenshot-action-button--done:not\(:disabled\):focus-visible\s*{[^}]*rgba\(48,\s*209,\s*88,\s*0\.22\)/s,
    );
    expect(css).toMatch(
      /\.screenshot-tool-group button\.screenshot-action-button--cancel:not\(:disabled\):focus-visible\s*{[^}]*rgba\(15,\s*23,\s*42,\s*0\.22\)/s,
    );
    expect(css).not.toMatch(/\.screenshot-tool-group--actions button:nth-last-child/);
    expect(css).not.toMatch(/\.screenshot-tool-group--actions button:last-child/);
    expect(css).toMatch(/\.screenshot-status\s*{[^}]*background:\s*var\(--screenshot-panel-bg\)/s);
    expect(css).toMatch(
      /\.screenshot-ocr-panel\s*{[^}]*background:\s*var\(--screenshot-panel-bg\)/s,
    );
    expect(css).toMatch(/\.screenshot-text-input\s*{[^}]*border-radius:\s*16px/s);
  });

  it('applies frosted rounded surfaces to launcher and add-app picker', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\.search-field-wrap\s*{[^}]*border-radius:\s*var\(--app-radius-panel\)/s);
    expect(css).toMatch(
      /\.search-field-wrap\s*{[^}]*backdrop-filter:\s*var\(--app-surface-blur\)/s,
    );
    expect(css).toMatch(/\.result-item\s*{[^}]*border-radius:\s*20px/s);
    expect(css).toMatch(
      /\.result-item\[data-selected='true'\]\s*{[^}]*inset 4px 0 0 var\(--app-accent\)/s,
    );
    expect(css).toMatch(/\.launcher-home-actions button\s*{[^}]*border-radius:\s*999px/s);
    expect(css).toMatch(/\.add-app-picker\s*{[^}]*border-radius:\s*var\(--app-radius-panel\)/s);
    expect(css).toMatch(/\.add-app-picker\s*{[^}]*backdrop-filter:\s*var\(--app-surface-blur\)/s);
  });

  it('keeps settings, converter, plugin host, and pinned image aligned to the frosted system', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\.settings-section\s*{[^}]*border-radius:\s*var\(--app-radius-control\)/s);
    expect(css).toMatch(/\.settings-section\s*{[^}]*background:\s*var\(--settings-panel-bg\)/s);
    expect(css).toMatch(/\.settings-segmented-control label\s*{[^}]*border-radius:\s*999px/s);
    expect(css).toMatch(/\.converter-categories button\s*{[^}]*border-radius:\s*999px/s);
    expect(css).toMatch(
      /\.converter-value input,\s*\.converter-value select\s*{[^}]*border-radius:\s*var\(--app-radius-control\)/s,
    );
    expect(css).toMatch(/\.plugin-host-frame\s*{[^}]*border-radius:\s*var\(--app-radius-panel\)/s);
    expect(css).toMatch(
      /\.pinned-image-titlebar\s*{[^}]*background:\s*var\(--screenshot-panel-bg\)/s,
    );
    expect(css).toMatch(
      /\.pinned-image-close:hover,\s*\.pinned-image-close:focus-visible\s*{[^}]*border-color:\s*color-mix\(in srgb, var\(--screenshot-danger\), transparent 52%\)/s,
    );
    expect(css).toMatch(
      /\.pinned-image-close:hover,\s*\.pinned-image-close:focus-visible\s*{[^}]*background:\s*var\(--screenshot-danger-bg\)/s,
    );
  });

  it('uses a single uncluttered launcher surface instead of a nested panel frame', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\.launcher-frame\s*{[^}]*border:\s*0/s);
    expect(css).toMatch(/\.launcher-frame\s*{[^}]*background:\s*transparent/s);
    expect(css).toMatch(/\.launcher-frame\s*{[^}]*box-shadow:\s*none/s);
  });

  it('uses a single uncluttered settings surface while keeping the scroll container', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\.settings-frame\s*{[^}]*border:\s*0/s);
    expect(css).toMatch(/\.settings-frame\s*{[^}]*border-radius:\s*0/s);
    expect(css).toMatch(/\.settings-frame\s*{[^}]*background:\s*transparent/s);
    expect(css).toMatch(/\.settings-frame\s*{[^}]*box-shadow:\s*none/s);
    expect(css).toMatch(/\.settings-grid\s*{[^}]*overflow:\s*auto/s);
  });

  it('keeps the fixed-size settings page scrollable inside the frame', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\.settings-shell\s*{[^}]*height:\s*100vh/s);
    expect(css).toMatch(/\.settings-shell\s*{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.settings-frame\s*{[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.settings-frame\s*{[^}]*height:\s*100%/s);
    expect(css).toMatch(/\.settings-grid\s*{[^}]*flex:\s*1\s+1\s+auto/s);
    expect(css).toMatch(/\.settings-grid\s*{[^}]*overflow:\s*auto/s);
  });

  it('keeps compact layouts responsive after base component styles', () => {
    const css = readFileSync(cssPath, 'utf8');

    const launcherMobileBlock = css.slice(css.indexOf('@media (max-width: 520px)'));
    expect(launcherMobileBlock).toMatch(/\.launcher-shell\s*{[^}]*padding:\s*16px/s);
    expect(launcherMobileBlock).toMatch(
      /\.result-item\s*{[^}]*grid-template-columns:\s*38px minmax\(0,\s*1fr\)/s,
    );
    expect(launcherMobileBlock).toMatch(
      /\.launcher-home-actions\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*1fr/s,
    );

    const converterBaseIndex = css.search(/\.converter-grid\s*{\s*display:\s*grid/);
    expect(converterBaseIndex).toBeGreaterThan(-1);
    const converterMobileBlock = css.slice(
      css.indexOf('@media (max-width: 520px)', converterBaseIndex),
    );
    expect(converterMobileBlock).toMatch(/\.converter-shell\s*{[^}]*padding:\s*16px/s);
    expect(converterMobileBlock).toMatch(/\.converter-grid\s*{[^}]*grid-template-columns:\s*1fr/s);

    const settingsBaseIndex = css.search(/\.settings-shell\s*{\s*display:\s*grid/);
    expect(settingsBaseIndex).toBeGreaterThan(-1);
    const settingsMobileBlock = css.slice(
      css.indexOf('@media (max-width: 520px)', settingsBaseIndex),
    );
    expect(settingsMobileBlock).toMatch(/\.settings-shell\s*{[^}]*padding:\s*16px/s);

    const screenshotMobileBlock = css.slice(css.indexOf('@media (max-width: 820px)'));
    expect(screenshotMobileBlock).toMatch(
      /\.screenshot-toolbar\s*{[^}]*justify-content:\s*flex-start[^}]*overflow-x:\s*auto/s,
    );
    expect(screenshotMobileBlock).toMatch(/\.screenshot-tool-group\s*{[^}]*flex:\s*0 0 auto/s);
  });
});
