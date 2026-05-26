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
    expect(css).toMatch(/--app-accent:\s*#ff2d55/i);
    expect(css).toMatch(/--app-secondary-accent:\s*#007aff/i);
    expect(css).toMatch(/--app-success:\s*#34c759/i);
    expect(css).toMatch(/--app-warm:\s*#ff9f0a/i);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{[^}]*--app-accent:\s*#ff375f/is);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{[^}]*--app-success:\s*#30d158/is);
    expect(css).toMatch(/^:root\s*{[^}]*radial-gradient\(circle at 16% 8%/is);
    expect(css).toMatch(/:root\[data-theme='light'\]\s*{[^}]*--app-bg:[^}]*radial-gradient\(circle at 16% 8%/is);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{[^}]*radial-gradient\(circle at 16% 8%/is);
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

  it('applies frosted rounded surfaces to launcher and add-app picker', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\.search-field-wrap\s*{[^}]*border-radius:\s*var\(--app-radius-panel\)/s);
    expect(css).toMatch(/\.search-field-wrap\s*{[^}]*backdrop-filter:\s*var\(--app-surface-blur\)/s);
    expect(css).toMatch(/\.result-item\s*{[^}]*border-radius:\s*20px/s);
    expect(css).toMatch(
      /\.result-item\[data-selected='true'\]\s*{[^}]*inset 4px 0 0 var\(--app-accent\)/s,
    );
    expect(css).toMatch(/\.launcher-home-actions button\s*{[^}]*border-radius:\s*999px/s);
    expect(css).toMatch(/\.add-app-picker\s*{[^}]*border-radius:\s*var\(--app-radius-panel\)/s);
    expect(css).toMatch(/\.add-app-picker\s*{[^}]*backdrop-filter:\s*var\(--app-surface-blur\)/s);
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
});
