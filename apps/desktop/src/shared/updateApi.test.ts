import { describe, expect, it } from 'vitest';

import { parseUpdateInstallResult, parseUpdateStatus } from './updateApi.js';

describe('update API parsers', () => {
  it('accepts a downloaded status with version metadata', () => {
    expect(
      parseUpdateStatus({
        canCheck: true,
        canInstall: true,
        phase: 'downloaded',
        version: '0.3.0',
      }),
    ).toEqual({
      canCheck: true,
      canInstall: true,
      error: undefined,
      percent: undefined,
      phase: 'downloaded',
      version: '0.3.0',
    });
  });

  it('accepts download progress', () => {
    expect(
      parseUpdateStatus({
        canCheck: false,
        canInstall: false,
        percent: 42.5,
        phase: 'downloading',
        version: '0.3.0',
      }),
    ).toMatchObject({
      percent: 42.5,
      phase: 'downloading',
    });
  });

  it('rejects malformed status payloads', () => {
    expect(() => parseUpdateStatus({ phase: 'surprise' })).toThrow('Invalid update status phase.');
    expect(() =>
      parseUpdateStatus({
        canCheck: true,
        canInstall: false,
        percent: -1,
        phase: 'downloading',
      }),
    ).toThrow('Invalid update status percent must be between 0 and 100.');
  });

  it('parses install results', () => {
    expect(parseUpdateInstallResult({ ok: true })).toEqual({ ok: true });
    expect(parseUpdateInstallResult({ error: 'Update is not ready.', ok: false })).toEqual({
      error: 'Update is not ready.',
      ok: false,
    });
  });
});
