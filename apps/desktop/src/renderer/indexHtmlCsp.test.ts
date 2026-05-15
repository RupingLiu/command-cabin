import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexHtmlPath = fileURLToPath(new URL('./index.html', import.meta.url));

describe('renderer CSP', () => {
  it('keeps production connect-src strict', () => {
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');

    expect(indexHtml).toContain("connect-src 'self';");
    expect(indexHtml).not.toContain('http://localhost:*');
    expect(indexHtml).not.toContain('ws:');
  });
});
