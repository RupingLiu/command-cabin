import { describe, expect, it } from 'vitest';

import { createScreenshotCommands } from './screenshotCommands.js';

describe('screenshot commands', () => {
  it('creates static system commands for capture, delayed capture, and OCR', () => {
    expect(createScreenshotCommands()).toEqual([
      expect.objectContaining({
        id: 'system.screenshot.capture',
        source: 'system',
        action: {
          type: 'run-system',
          payload: {
            command: 'screenshot.capture',
          },
        },
      }),
      expect.objectContaining({
        id: 'system.screenshot.capture-delay-3',
        source: 'system',
        action: {
          type: 'run-system',
          payload: {
            command: 'screenshot.capture-delay-3',
          },
        },
      }),
      expect.objectContaining({
        id: 'system.screenshot.capture-delay-5',
        source: 'system',
        action: {
          type: 'run-system',
          payload: {
            command: 'screenshot.capture-delay-5',
          },
        },
      }),
      expect.objectContaining({
        id: 'system.screenshot.ocr',
        source: 'system',
        action: {
          type: 'run-system',
          payload: {
            command: 'screenshot.ocr',
          },
        },
      }),
    ]);
  });

  it('includes Simplified and Traditional Chinese screenshot search keywords', () => {
    const keywords = createScreenshotCommands().flatMap((command) => command.keywords);

    expect(keywords).toEqual(
      expect.arrayContaining([
        '截图',
        '截圖',
        '延时截图',
        '延遲截圖',
        '文字识别',
        '文字辨識',
        'OCR',
      ]),
    );
  });
});
