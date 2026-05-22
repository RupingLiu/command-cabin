import { describe, expect, it, vi } from 'vitest';

import { COMMAND_CABIN_REPOSITORY_URL, openRepository } from './openRepository.js';

describe('openRepository', () => {
  it('opens the CommandCabin GitHub repository in the default browser', async () => {
    const openExternal = vi.fn(async () => undefined);

    await expect(openRepository({ openExternal })).resolves.toBe(true);

    expect(openExternal).toHaveBeenCalledWith(COMMAND_CABIN_REPOSITORY_URL);
  });
});
