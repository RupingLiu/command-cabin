import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { MouseEvent } from 'react';

import type {
  ScreenshotLaunchState,
  ScreenshotOcrLanguage,
  ScreenshotSaveFormat,
} from '../../../shared/screenshotApi.js';
import { composeScreenshotSelection } from './screenshotCanvas.js';
import {
  createInitialScreenshotState,
  isScreenshotReadyToComplete,
  normalizeScreenshotRect,
  screenshotReducer,
  type ScreenshotPoint,
  type ScreenshotRect,
  type ScreenshotTool,
} from './screenshotState.js';

const toolLabels: Record<ScreenshotTool, string> = {
  arrow: 'Arrow',
  ellipse: 'Ellipse',
  mosaic: 'Mosaic',
  pen: 'Pen',
  rectangle: 'Rectangle',
  text: 'Text',
};

const colors = ['#ff3355', '#f5c542', '#60d394', '#4aa3ff', '#ffffff'];
const lineWidths = [2, 4, 6];
const fontSizes = [16, 22, 30];

interface ScreenshotOverlayStatus {
  tone: 'info' | 'error';
  value: string;
}

export interface ScreenshotOverlayViewProps {
  desktopApi?: Window['desktopApi']['screenshot'] | undefined;
  launchState: ScreenshotLaunchState;
}

export function ScreenshotOverlay() {
  const [launchState, setLaunchState] = useState<ScreenshotLaunchState | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const screenshotApi =
      typeof window !== 'undefined' && 'desktopApi' in window
        ? window.desktopApi.screenshot
        : undefined;

    void screenshotApi
      ?.getLaunchState()
      .then(setLaunchState)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Unable to load screenshot capture.');
      });
  }, []);

  if (error) {
    return <div className="screenshot-overlay screenshot-overlay--empty">{error}</div>;
  }

  if (!launchState) {
    return (
      <div className="screenshot-overlay screenshot-overlay--empty">Loading screenshot...</div>
    );
  }

  return (
    <ScreenshotOverlayView desktopApi={window.desktopApi.screenshot} launchState={launchState} />
  );
}

export function ScreenshotOverlayView({ desktopApi, launchState }: ScreenshotOverlayViewProps) {
  const [state, dispatch] = useReducer(screenshotReducer, undefined, createInitialScreenshotState);
  const [dragStart, setDragStart] = useState<ScreenshotPoint | undefined>();
  const [saveFormat, setSaveFormat] = useState<ScreenshotSaveFormat>('png');
  const [status, setStatus] = useState<ScreenshotOverlayStatus | undefined>();
  const [pointer, setPointer] = useState<ScreenshotPoint>({
    x: launchState.virtualBounds.x,
    y: launchState.virtualBounds.y,
  });
  const ready = isScreenshotReadyToComplete(state);
  const offsetSelection = useMemo(
    () => (state.selection ? offsetRect(state.selection, launchState.virtualBounds) : undefined),
    [launchState.virtualBounds, state.selection],
  );

  const cancel = useCallback(() => {
    void desktopApi?.cancel();
  }, [desktopApi]);

  const exportImage = useCallback(
    async (format: ScreenshotSaveFormat = 'png') => {
      if (!state.selection) {
        throw new Error('Select an area first.');
      }

      return composeScreenshotSelection({
        annotations: state.annotations,
        format,
        launchState,
        selection: state.selection,
      });
    },
    [launchState, state.annotations, state.selection],
  );

  const finish = useCallback(async () => {
    try {
      const imageDataUrl = await exportImage('png');
      await desktopApi?.copyImage({ imageDataUrl });
      await desktopApi?.cancel();
    } catch (reason) {
      setStatus(toStatus(reason));
    }
  }, [desktopApi, exportImage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel();
      }

      if (event.key === 'Enter' && ready) {
        void finish();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancel, finish, ready]);

  const beginPointer = (point: ScreenshotPoint) => {
    setPointer(point);

    if (state.selection && pointInRect(point, state.selection)) {
      commitToolAnnotation(point);
      return;
    }

    setDragStart(point);
    dispatch({ point, type: 'selection-started' });
  };

  const movePointer = (point: ScreenshotPoint) => {
    setPointer(point);

    if (dragStart) {
      dispatch({ point, type: 'selection-updated' });
    }
  };

  const endPointer = (point: ScreenshotPoint) => {
    setPointer(point);

    if (!dragStart) {
      return;
    }

    const rect = normalizeScreenshotRect(dragStart, point);
    setDragStart(undefined);
    dispatch({ type: 'selection-ended' });

    if (rect.width < 3 || rect.height < 3) {
      commitToolAnnotation(point);
    }
  };

  const commitToolAnnotation = (point: ScreenshotPoint) => {
    if (!state.selection || !pointInRect(point, state.selection)) {
      return;
    }

    const localPoint = {
      x: point.x - state.selection.x,
      y: point.y - state.selection.y,
    };
    const rect = clampRectToSelection(
      {
        height: 56,
        width: 92,
        x: localPoint.x - 46,
        y: localPoint.y - 28,
      },
      state.selection,
    );

    if (state.tool === 'arrow') {
      dispatch({
        annotation: {
          from: { x: rect.x, y: rect.y + rect.height },
          to: { x: rect.x + rect.width, y: rect.y },
          type: 'arrow',
        },
        type: 'annotation-committed',
      });
      return;
    }

    if (state.tool === 'pen') {
      dispatch({
        annotation: {
          points: [
            { x: rect.x, y: rect.y + rect.height / 2 },
            { x: rect.x + rect.width / 3, y: rect.y },
            { x: rect.x + rect.width, y: rect.y + rect.height },
          ],
          type: 'pen',
        },
        type: 'annotation-committed',
      });
      return;
    }

    if (state.tool === 'text') {
      const text =
        typeof window !== 'undefined'
          ? window.prompt('Text annotation', 'Text')?.trim() || 'Text'
          : 'Text';

      dispatch({
        annotation: {
          point: { x: localPoint.x, y: localPoint.y },
          text,
          type: 'text',
        },
        type: 'annotation-committed',
      });
      return;
    }

    dispatch({
      annotation: {
        rect,
        type: state.tool,
      },
      type: 'annotation-committed',
    });
  };

  const runOutputAction = async (action: 'ocr' | 'pin' | 'save') => {
    try {
      const imageDataUrl = await exportImage(action === 'save' ? saveFormat : 'png');

      if (action === 'save') {
        const result = await desktopApi?.saveImage({ format: saveFormat, imageDataUrl });
        setStatus({ tone: 'info', value: result?.canceled ? 'Save canceled.' : 'Image saved.' });
      } else if (action === 'pin') {
        await desktopApi?.pinImage({ imageDataUrl });
        setStatus({ tone: 'info', value: 'Pinned selection.' });
      } else {
        const result = await desktopApi?.runOcr({ imageDataUrl, language: 'en-US' });
        setStatus({ tone: 'info', value: result?.text || 'No OCR text found.' });
      }
    } catch (reason) {
      setStatus(toStatus(reason));
    }
  };

  return (
    <div
      className="screenshot-overlay"
      onContextMenu={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <div
        className="screenshot-stage"
        onDoubleClick={() => {
          if (ready) {
            void finish();
          }
        }}
        onMouseDown={(event) => {
          if (event.button === 0) {
            beginPointer(toVirtualPoint(event, launchState.virtualBounds));
          }
        }}
        onMouseMove={(event) => movePointer(toVirtualPoint(event, launchState.virtualBounds))}
        onMouseUp={(event) => endPointer(toVirtualPoint(event, launchState.virtualBounds))}
        role="application"
      >
        {launchState.displays.map((display) => (
          <img
            alt=""
            className="screenshot-display"
            data-source-id={display.sourceId}
            draggable={false}
            key={display.sourceId}
            src={display.imageDataUrl}
            style={{
              height: display.bounds.height,
              left: display.bounds.x - launchState.virtualBounds.x,
              top: display.bounds.y - launchState.virtualBounds.y,
              width: display.bounds.width,
            }}
          />
        ))}
        {offsetSelection ? (
          <div
            className="screenshot-selection"
            style={{
              height: offsetSelection.height,
              left: offsetSelection.x,
              top: offsetSelection.y,
              width: offsetSelection.width,
            }}
          >
            <span className="screenshot-size-badge">
              {Math.round(offsetSelection.width)} x {Math.round(offsetSelection.height)}
            </span>
          </div>
        ) : undefined}
        <div
          className="screenshot-magnifier"
          style={{
            left: pointer.x - launchState.virtualBounds.x + 14,
            top: pointer.y - launchState.virtualBounds.y + 14,
          }}
        >
          {Math.round(pointer.x)}, {Math.round(pointer.y)}
        </div>
      </div>

      <div className="screenshot-toolbar" role="toolbar">
        <div className="screenshot-tool-group">
          {(Object.keys(toolLabels) as ScreenshotTool[]).map((tool) => (
            <button
              data-active={state.tool === tool}
              key={tool}
              onClick={() => dispatch({ tool, type: 'tool-selected' })}
              title={toolLabels[tool]}
              type="button"
            >
              <span>{toolIcon(tool)}</span>
              {toolLabels[tool]}
            </button>
          ))}
        </div>
        <div className="screenshot-tool-group">
          <button onClick={() => dispatch({ type: 'undo' })} type="button">
            <span>&lt;</span>
            Undo
          </button>
          <button onClick={() => dispatch({ type: 'redo' })} type="button">
            <span>&gt;</span>
            Redo
          </button>
        </div>
        <fieldset className="screenshot-tool-group">
          <legend>Color</legend>
          {colors.map((color) => (
            <button
              aria-label={`Color ${color}`}
              data-active={state.style.color === color}
              key={color}
              onClick={() => dispatch({ color, type: 'color-selected' })}
              style={{ backgroundColor: color }}
              type="button"
            />
          ))}
        </fieldset>
        <fieldset className="screenshot-tool-group">
          <legend>Line</legend>
          {lineWidths.map((lineWidth) => (
            <button
              data-active={state.style.lineWidth === lineWidth}
              key={lineWidth}
              onClick={() => dispatch({ lineWidth, type: 'line-width-selected' })}
              type="button"
            >
              {lineWidth}
            </button>
          ))}
        </fieldset>
        <fieldset className="screenshot-tool-group">
          <legend>Font</legend>
          {fontSizes.map((fontSize) => (
            <button
              data-active={state.style.fontSize === fontSize}
              key={fontSize}
              onClick={() => dispatch({ fontSize, type: 'font-size-selected' })}
              type="button"
            >
              {fontSize}
            </button>
          ))}
        </fieldset>
        <fieldset className="screenshot-tool-group">
          <legend>Format</legend>
          {(['png', 'jpg'] as ScreenshotSaveFormat[]).map((format) => (
            <button
              data-active={saveFormat === format}
              key={format}
              onClick={() => setSaveFormat(format)}
              type="button"
            >
              {format.toUpperCase()}
            </button>
          ))}
        </fieldset>
        <div className="screenshot-tool-group screenshot-tool-group--actions">
          <button disabled={!ready} onClick={() => void runOutputAction('ocr')} type="button">
            <span>Tx</span>
            OCR
          </button>
          <button disabled={!ready} onClick={() => void runOutputAction('pin')} type="button">
            <span>^</span>
            Pin
          </button>
          <button disabled={!ready} onClick={() => void runOutputAction('save')} type="button">
            <span>v</span>
            Save
          </button>
          <button disabled={!ready} onClick={() => void finish()} type="button">
            <span>OK</span>
            Done
          </button>
          <button onClick={cancel} type="button">
            <span>X</span>
            Cancel
          </button>
        </div>
      </div>
      {status ? (
        <div className="screenshot-status" data-tone={status.tone}>
          {status.value}
        </div>
      ) : undefined}
    </div>
  );
}

function toVirtualPoint(event: MouseEvent, virtualBounds: ScreenshotRect): ScreenshotPoint {
  return {
    x: event.clientX + virtualBounds.x,
    y: event.clientY + virtualBounds.y,
  };
}

function offsetRect(rect: ScreenshotRect, virtualBounds: ScreenshotRect): ScreenshotRect {
  return {
    ...rect,
    x: rect.x - virtualBounds.x,
    y: rect.y - virtualBounds.y,
  };
}

function pointInRect(point: ScreenshotPoint, rect: ScreenshotRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function clampRectToSelection(rect: ScreenshotRect, selection: ScreenshotRect): ScreenshotRect {
  return {
    height: Math.min(rect.height, selection.height),
    width: Math.min(rect.width, selection.width),
    x: Math.max(0, Math.min(rect.x, selection.width - rect.width)),
    y: Math.max(0, Math.min(rect.y, selection.height - rect.height)),
  };
}

function toolIcon(tool: ScreenshotTool): string {
  switch (tool) {
    case 'rectangle':
      return '[]';
    case 'ellipse':
      return '()';
    case 'arrow':
      return '->';
    case 'pen':
      return '/';
    case 'text':
      return 'T';
    case 'mosaic':
      return '#';
  }
}

function toStatus(reason: unknown): ScreenshotOverlayStatus {
  return {
    tone: 'error',
    value: reason instanceof Error ? reason.message : 'Screenshot action failed.',
  };
}
