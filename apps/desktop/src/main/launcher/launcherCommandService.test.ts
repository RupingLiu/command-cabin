import { describe, expect, it } from 'vitest';

import { createLauncherCommandService } from './launcherCommandService.js';

describe('launcher command service', () => {
  it('returns demo command results for an empty query', () => {
    const service = createLauncherCommandService();

    const results = service.searchCommands('');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      id: expect.any(String) as string,
      source: 'system',
      title: expect.any(String) as string,
    });
  });

  it('executes a selected command through the core command executor', async () => {
    const service = createLauncherCommandService();
    const [firstResult] = service.searchCommands('');

    expect(firstResult).toBeDefined();

    const executionResult = await service.executeCommand(firstResult!.id);

    expect(executionResult).toMatchObject({
      commandId: firstResult!.id,
      status: 'success',
    });
  });

  it('returns a structured failure for unknown command ids', async () => {
    const service = createLauncherCommandService();

    await expect(service.executeCommand('missing.command')).resolves.toMatchObject({
      commandId: 'missing.command',
      error: {
        code: 'invalid-command',
      },
      status: 'failure',
    });
  });
});
