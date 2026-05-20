import type { Command } from '@command-cabin/core';

export function createScreenshotCommands(): readonly Command[] {
  return [
    {
      id: 'system.screenshot.capture',
      source: 'system',
      title: 'Capture Screenshot',
      subtitle: 'Select an area to capture',
      keywords: ['screenshot', 'capture', 'screen capture', '截图', '截圖'],
      action: {
        type: 'run-system',
        payload: {
          command: 'screenshot.capture',
        },
      },
    },
    {
      id: 'system.screenshot.capture-delay-3',
      source: 'system',
      title: 'Capture Screenshot in 3 Seconds',
      subtitle: 'Start a delayed screenshot capture',
      keywords: ['screenshot', 'capture', 'delay', '3 seconds', '延时截图', '延遲截圖'],
      action: {
        type: 'run-system',
        payload: {
          command: 'screenshot.capture-delay-3',
        },
      },
    },
    {
      id: 'system.screenshot.capture-delay-5',
      source: 'system',
      title: 'Capture Screenshot in 5 Seconds',
      subtitle: 'Start a delayed screenshot capture',
      keywords: ['screenshot', 'capture', 'delay', '5 seconds', '延时截图', '延遲截圖'],
      action: {
        type: 'run-system',
        payload: {
          command: 'screenshot.capture-delay-5',
        },
      },
    },
    {
      id: 'system.screenshot.ocr',
      source: 'system',
      title: 'Recognize Text from Screenshot',
      subtitle: 'Capture an area and run OCR',
      keywords: [
        'screenshot',
        'ocr',
        'text recognition',
        '截图',
        '截圖',
        '文字识别',
        '文字辨識',
        'OCR',
      ],
      action: {
        type: 'run-system',
        payload: {
          command: 'screenshot.ocr',
        },
      },
    },
  ];
}
