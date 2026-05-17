import { describe, expect, it } from 'vitest';

import {
  TEXT_TOOL_COMMAND_IDS,
  applyTextTransform,
  createTextToolCommands,
} from '../../packages/built-in-plugins/text-tools/src/index.js';
import { createLauncherCommandService } from '../../apps/desktop/src/main/launcher/launcherCommandService.js';

describe('text tools transforms', () => {
  it('converts clipboard text to uppercase and lowercase', () => {
    expect(applyTextTransform('uppercase', 'Command Cabin')).toBe('COMMAND CABIN');
    expect(applyTextTransform('lowercase', 'Command Cabin')).toBe('command cabin');
  });

  it('removes blank lines while keeping non-empty lines', () => {
    expect(applyTextTransform('remove-blank-lines', 'first\n\n  \nsecond\r\nthird')).toBe(
      'first\nsecond\nthird',
    );
  });

  it('formats JSON with stable indentation', () => {
    expect(applyTextTransform('format-json', '{"name":"CommandCabin","enabled":true}')).toBe(
      '{\n  "name": "CommandCabin",\n  "enabled": true\n}',
    );
  });

  it('encodes and decodes URL text', () => {
    const encoded = applyTextTransform('url-encode', 'hello world?x=1&label=Command Cabin');

    expect(encoded).toBe('hello%20world%3Fx%3D1%26label%3DCommand%20Cabin');
    expect(applyTextTransform('url-decode', encoded)).toBe('hello world?x=1&label=Command Cabin');
  });

  it('throws clear errors for invalid JSON and malformed URL encoding', () => {
    expect(() => applyTextTransform('format-json', '{bad json')).toThrow('Invalid JSON');
    expect(() => applyTextTransform('url-decode', '%E0%A4%A')).toThrow('Invalid URL encoded text');
  });
});

describe('text tools commands', () => {
  it('creates static plugin commands for each transform', () => {
    expect(createTextToolCommands()).toEqual([
      expect.objectContaining({
        id: TEXT_TOOL_COMMAND_IDS.uppercase,
        keywords: expect.arrayContaining(['text', 'uppercase']),
        title: 'Text: Uppercase',
      }),
      expect.objectContaining({
        id: TEXT_TOOL_COMMAND_IDS.lowercase,
        keywords: expect.arrayContaining(['text', 'lowercase']),
        title: 'Text: Lowercase',
      }),
      expect.objectContaining({
        id: TEXT_TOOL_COMMAND_IDS.removeBlankLines,
        keywords: expect.arrayContaining(['text', 'blank', 'lines']),
        title: 'Text: Remove Blank Lines',
      }),
      expect.objectContaining({
        id: TEXT_TOOL_COMMAND_IDS.formatJson,
        keywords: expect.arrayContaining(['text', 'json', 'format']),
        title: 'Text: Format JSON',
      }),
      expect.objectContaining({
        id: TEXT_TOOL_COMMAND_IDS.urlEncode,
        keywords: expect.arrayContaining(['text', 'url', 'encode']),
        title: 'Text: URL Encode',
      }),
      expect.objectContaining({
        id: TEXT_TOOL_COMMAND_IDS.urlDecode,
        keywords: expect.arrayContaining(['text', 'url', 'decode']),
        title: 'Text: URL Decode',
      }),
    ]);
  });
});

describe('launcher text tools integration', () => {
  it('searches text tool commands and writes transformed clipboard text after success', async () => {
    const writtenText: string[] = [];
    const service = createLauncherCommandService({
      commands: [],
      readClipboardText: () => 'Command Cabin',
      writeClipboardText: (text) => {
        writtenText.push(text);
      },
    });

    const [result] = await service.searchCommands('uppercase text');

    expect(result).toMatchObject({
      id: TEXT_TOOL_COMMAND_IDS.uppercase,
      source: 'plugin',
      title: 'Text: Uppercase',
    });

    await expect(service.executeCommand(result!.id)).resolves.toMatchObject({
      commandId: TEXT_TOOL_COMMAND_IDS.uppercase,
      metadata: {
        textTransform: 'uppercase',
      },
      status: 'success',
    });
    expect(writtenText).toEqual(['COMMAND CABIN']);
  });

  it('returns failure and keeps clipboard untouched when JSON formatting fails', async () => {
    const writtenText: string[] = [];
    const service = createLauncherCommandService({
      commands: [],
      readClipboardText: () => '{bad json',
      writeClipboardText: (text) => {
        writtenText.push(text);
      },
    });

    const result = await service.executeCommand(TEXT_TOOL_COMMAND_IDS.formatJson);

    expect(result).toMatchObject({
      commandId: TEXT_TOOL_COMMAND_IDS.formatJson,
      error: {
        code: 'handler-error',
        message: expect.stringContaining('Invalid JSON') as string,
      },
      status: 'failure',
    });
    expect(writtenText).toEqual([]);
  });
});
