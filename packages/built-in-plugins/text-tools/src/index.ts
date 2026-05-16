import type { Command } from '@command-cabin/core';

import type { TextTransformKind } from './transforms.js';

export {
  applyTextTransform,
  formatJson,
  removeBlankLines,
  TextTransformError,
} from './transforms.js';
export type { TextTransformKind } from './transforms.js';

export const TEXT_TOOLS_PLUGIN_ID = 'text-tools';

export const TEXT_TOOL_COMMAND_IDS = {
  uppercase: 'text-tools.uppercase',
  lowercase: 'text-tools.lowercase',
  removeBlankLines: 'text-tools.remove-blank-lines',
  formatJson: 'text-tools.format-json',
  urlEncode: 'text-tools.url-encode',
  urlDecode: 'text-tools.url-decode',
} as const;

interface TextToolCommandDefinition {
  id: (typeof TEXT_TOOL_COMMAND_IDS)[keyof typeof TEXT_TOOL_COMMAND_IDS];
  keywords: string[];
  kind: TextTransformKind;
  subtitle: string;
  title: string;
}

const TEXT_TOOL_COMMAND_DEFINITIONS: readonly TextToolCommandDefinition[] = [
  {
    id: TEXT_TOOL_COMMAND_IDS.uppercase,
    keywords: ['text', 'uppercase', 'case'],
    kind: 'uppercase',
    subtitle: 'Convert text to uppercase',
    title: 'Text: Uppercase',
  },
  {
    id: TEXT_TOOL_COMMAND_IDS.lowercase,
    keywords: ['text', 'lowercase', 'case'],
    kind: 'lowercase',
    subtitle: 'Convert text to lowercase',
    title: 'Text: Lowercase',
  },
  {
    id: TEXT_TOOL_COMMAND_IDS.removeBlankLines,
    keywords: ['text', 'blank', 'lines', 'remove'],
    kind: 'remove-blank-lines',
    subtitle: 'Remove blank lines from text',
    title: 'Text: Remove Blank Lines',
  },
  {
    id: TEXT_TOOL_COMMAND_IDS.formatJson,
    keywords: ['text', 'json', 'format', 'pretty'],
    kind: 'format-json',
    subtitle: 'Format JSON with indentation',
    title: 'Text: Format JSON',
  },
  {
    id: TEXT_TOOL_COMMAND_IDS.urlEncode,
    keywords: ['text', 'url', 'encode', 'uri'],
    kind: 'url-encode',
    subtitle: 'URL encode text',
    title: 'Text: URL Encode',
  },
  {
    id: TEXT_TOOL_COMMAND_IDS.urlDecode,
    keywords: ['text', 'url', 'decode', 'uri'],
    kind: 'url-decode',
    subtitle: 'URL decode text',
    title: 'Text: URL Decode',
  },
];

const TEXT_TOOL_COMMAND_ID_TO_KIND: ReadonlyMap<string, TextTransformKind> = new Map(
  TEXT_TOOL_COMMAND_DEFINITIONS.map((definition) => [definition.id, definition.kind]),
);

export function createTextToolCommands(): Command[] {
  return TEXT_TOOL_COMMAND_DEFINITIONS.map((definition) => ({
    id: definition.id,
    source: 'plugin',
    title: definition.title,
    subtitle: definition.subtitle,
    keywords: definition.keywords,
    pluginId: TEXT_TOOLS_PLUGIN_ID,
    action: {
      type: 'run-system',
      payload: {
        command: definition.id,
        transform: definition.kind,
      },
    },
  }));
}

export function getTextToolTransformKind(commandId: string): TextTransformKind | undefined {
  return TEXT_TOOL_COMMAND_ID_TO_KIND.get(commandId);
}

export function isTextToolCommandId(commandId: string): boolean {
  return TEXT_TOOL_COMMAND_ID_TO_KIND.has(commandId);
}
