import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MouseEvent } from 'react';

import type {
  ScreenshotLaunchState,
  ScreenshotOcrResult,
  ScreenshotSaveFormat,
} from '../../../shared/screenshotApi.js';
import { DEFAULT_UI_LANGUAGE, getUiStrings, type UiStrings } from '../i18n.js';
import { composeScreenshotSelection } from './screenshotCanvas.js';
import {
  createInitialScreenshotState,
  isScreenshotReadyToComplete,
  screenshotReducer,
  type ScreenshotAnnotation,
  type ScreenshotPoint,
  type ScreenshotRect,
  type ScreenshotState,
  type ScreenshotTool,
} from './screenshotState.js';

const colors = ['#ff3355', '#f5c542', '#60d394', '#4aa3ff', '#ffffff'];
const lineWidths = [2, 4, 6];
const fontSizes = [16, 22, 30];
const toolOrder: ScreenshotTool[] = ['rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic'];
const defaultScreenshotStrings = getUiStrings(DEFAULT_UI_LANGUAGE).screenshot;

interface ScreenshotOverlayStatus {
  tone: 'info' | 'error';
  value: string;
}

export type OcrPanelState = { status: 'running' } | ScreenshotOcrResult;

type ScreenshotApi = NonNullable<Window['desktopApi']['screenshot']>;
type PendingTextTimer = ReturnType<typeof setTimeout>;
type ScreenshotStrings = UiStrings['screenshot'];

export interface PendingTextAnnotationController {
  cancel: () => void;
  schedule: (callback: () => void) => void;
}

export interface PendingTextAnnotationControllerOptions {
  clearTimer: (timer: PendingTextTimer) => void;
  delayMs: number;
  setTimer: (callback: () => void, delayMs: number) => PendingTextTimer;
}

export interface ScreenshotOverlayViewProps {
  desktopApi?: Window['desktopApi']['screenshot'] | undefined;
  initialState?: ScreenshotState | undefined;
  launchState: ScreenshotLaunchState;
  strings?: ScreenshotStrings | undefined;
}

export function getScreenshotCompletionAction(
  launchState: Pick<ScreenshotLaunchState, 'mode'>,
): 'copy' | 'ocr' {
  return launchState.mode === 'ocr' ? 'ocr' : 'copy';
}

export function requireScreenshotApi(
  screenshotApi: Window['desktopApi']['screenshot'] | undefined,
  unavailableMessage = defaultScreenshotStrings.controlsUnavailable,
): ScreenshotApi {
  if (!screenshotApi) {
    throw new Error(unavailableMessage);
  }

  return screenshotApi;
}

export function createPendingTextAnnotationController({
  clearTimer,
  delayMs,
  setTimer,
}: PendingTextAnnotationControllerOptions): PendingTextAnnotationController {
  let pendingTimer: PendingTextTimer | undefined;

  const cancel = () => {
    if (pendingTimer !== undefined) {
      clearTimer(pendingTimer);
      pendingTimer = undefined;
    }
  };

  return {
    cancel,
    schedule: (callback) => {
      cancel();
      pendingTimer = setTimer(() => {
        pendingTimer = undefined;
        callback();
      }, delayMs);
    },
  };
}

export function ScreenshotOverlay() {
  const [launchState, setLaunchState] = useState<ScreenshotLaunchState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [strings, setStrings] = useState<ScreenshotStrings>(defaultScreenshotStrings);

  useEffect(() => {
    const desktopApi =
      typeof window !== 'undefined' && 'desktopApi' in window ? window.desktopApi : undefined;
    let screenshotApi: ScreenshotApi;

    try {
      screenshotApi = requireScreenshotApi(desktopApi?.screenshot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : defaultScreenshotStrings.loadError);
      return;
    }

    void desktopApi
      ?.getSettings()
      .then((settings) => {
        setStrings(getUiStrings(settings.language).screenshot);
      })
      .catch(() => undefined);

    void screenshotApi
      .getLaunchState()
      .then(setLaunchState)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : defaultScreenshotStrings.loadError);
      });
  }, []);

  if (error) {
    return <div className="screenshot-overlay screenshot-overlay--empty">{error}</div>;
  }

  if (!launchState) {
    return (
      <div className="screenshot-overlay screenshot-overlay--empty">{strings.loading}</div>
    );
  }

  return (
    <ScreenshotOverlayView
      desktopApi={window.desktopApi.screenshot}
      launchState={launchState}
      strings={strings}
    />
  );
}

export function ScreenshotOverlayView({
  desktopApi,
  initialState,
  launchState,
  strings = defaultScreenshotStrings,
}: ScreenshotOverlayViewProps) {
  const [state, dispatch] = useReducer(
    screenshotReducer,
    initialState ?? createInitialScreenshotState(),
  );
  const [dragMode, setDragMode] = useState<'annotation' | 'selection' | undefined>();
  const dragStartRef = useRef<
    | {
        mode: 'annotation' | 'selection';
        point: ScreenshotPoint;
      }
    | undefined
  >(undefined);
  const textPromptControllerRef = useRef<PendingTextAnnotationController | undefined>(undefined);
  const [saveFormat, setSaveFormat] = useState<ScreenshotSaveFormat>('png');
  const [status, setStatus] = useState<ScreenshotOverlayStatus | undefined>();
  const [ocrPanel, setOcrPanel] = useState<OcrPanelState | undefined>();
  const [pointer, setPointer] = useState<ScreenshotPoint>({
    x: launchState.virtualBounds.x,
    y: launchState.virtualBounds.y,
  });
  const ready = isScreenshotReadyToComplete(state);
  const offsetSelection = useMemo(
    () => (state.selection ? offsetRect(state.selection, launchState.virtualBounds) : undefined),
    [launchState.virtualBounds, state.selection],
  );

  const getTextPromptController = useCallback(() => {
    if (!textPromptControllerRef.current) {
      textPromptControllerRef.current = createPendingTextAnnotationController({
        clearTimer: globalThis.clearTimeout,
        delayMs: 220,
        setTimer: globalThis.setTimeout,
      });
    }

    return textPromptControllerRef.current;
  }, []);

  const clearTextPromptTimer = useCallback(() => {
    textPromptControllerRef.current?.cancel();
  }, []);

  const cancel = useCallback(() => {
    clearTextPromptTimer();
    try {
      void requireScreenshotApi(desktopApi, strings.controlsUnavailable).cancel();
    } catch (reason) {
      setStatus(toStatus(reason, strings));
    }
  }, [clearTextPromptTimer, desktopApi, strings]);

  const exportImage = useCallback(
    async (format: ScreenshotSaveFormat = 'png') => {
      if (!state.selection) {
        throw new Error('Select an area first.');
      }

      return composeScreenshotSelection({
        annotations: state.draftAnnotation
          ? [...state.annotations, state.draftAnnotation]
          : state.annotations,
        format,
        launchState,
        selection: state.selection,
      });
    },
    [launchState, state.annotations, state.draftAnnotation, state.selection],
  );

  const runOcr = useCallback(
    async (imageDataUrl: string) => {
      const screenshotApi = requireScreenshotApi(desktopApi, strings.controlsUnavailable);

      setOcrPanel({ status: 'running' });
      const result = await screenshotApi.runOcr({ imageDataUrl, language: 'en-US' });
      setOcrPanel(result);
    },
    [desktopApi, strings.controlsUnavailable],
  );

  const finish = useCallback(async () => {
    clearTextPromptTimer();
    try {
      const imageDataUrl = await exportImage('png');
      const screenshotApi = requireScreenshotApi(desktopApi, strings.controlsUnavailable);

      if (getScreenshotCompletionAction(launchState) === 'ocr') {
        await runOcr(imageDataUrl);
      } else {
        await screenshotApi.copyImage({ imageDataUrl });
        await screenshotApi.cancel();
      }
    } catch (reason) {
      if (getScreenshotCompletionAction(launchState) === 'ocr') {
        setOcrPanel({
          language: 'en-US',
          message: reason instanceof Error ? reason.message : strings.ocr.failed,
          status: 'error',
        });
      } else {
        setStatus(toStatus(reason, strings));
      }
    }
  }, [clearTextPromptTimer, desktopApi, exportImage, launchState, runOcr, strings]);

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

  useEffect(() => clearTextPromptTimer, [clearTextPromptTimer]);

  const beginPointer = (point: ScreenshotPoint, detail: number) => {
    setPointer(point);
    clearTextPromptTimer();

    if (detail > 1) {
      return;
    }

    if (state.selection && pointInRect(point, state.selection)) {
      const localPoint = toSelectionPoint(point, state.selection);

      setDragMode('annotation');
      dragStartRef.current = { mode: 'annotation', point: localPoint };
      dispatch({ point: localPoint, type: 'annotation-started' });
      return;
    }

    setDragMode('selection');
    dragStartRef.current = { mode: 'selection', point };
    dispatch({ point, type: 'selection-started' });
  };

  const movePointer = (point: ScreenshotPoint) => {
    setPointer(point);

    if (dragMode === 'selection') {
      dispatch({ point, type: 'selection-updated' });
    } else if (dragMode === 'annotation' && state.selection) {
      dispatch({
        point: toSelectionPoint(point, state.selection),
        type: 'annotation-updated',
      });
    }
  };

  const endPointer = (point: ScreenshotPoint, detail: number) => {
    setPointer(point);

    if (detail > 1) {
      clearTextPromptTimer();
      setDragMode(undefined);
      dragStartRef.current = undefined;
      dispatch({ type: 'annotation-canceled' });
      return;
    }

    if (!dragMode) {
      return;
    }

    if (dragMode === 'selection') {
      dispatch({ type: 'selection-ended' });
    } else if (state.tool === 'text' && state.selection) {
      const start = dragStartRef.current?.point;
      const end = toSelectionPoint(point, state.selection);

      dispatch({ type: 'annotation-canceled' });

      if (start && distance(start, end) <= 3) {
        scheduleTextAnnotation(end);
      }
    } else {
      dispatch({ type: 'annotation-finished' });
    }

    setDragMode(undefined);
    dragStartRef.current = undefined;
  };

  const scheduleTextAnnotation = (point: ScreenshotPoint) => {
    getTextPromptController().schedule(() => {
      const text =
        typeof window !== 'undefined'
          ? window.prompt(strings.textPrompt.title, strings.textPrompt.defaultText)?.trim() || ''
          : strings.textPrompt.defaultText;

      if (!text) {
        return;
      }

      dispatch({
        annotation: {
          point,
          text,
          type: 'text',
        },
        type: 'annotation-committed',
      });
    });
  };

  const runOutputAction = async (action: 'ocr' | 'pin' | 'save') => {
    try {
      const imageDataUrl = await exportImage(action === 'save' ? saveFormat : 'png');
      const screenshotApi = requireScreenshotApi(desktopApi, strings.controlsUnavailable);

      if (action === 'save') {
        const result = await screenshotApi.saveImage({ format: saveFormat, imageDataUrl });
        setStatus({
          tone: 'info',
          value: result?.canceled ? strings.status.saveCanceled : strings.status.imageSaved,
        });
      } else if (action === 'pin') {
        await screenshotApi.pinImage({ imageDataUrl });
        setStatus({ tone: 'info', value: strings.status.pinned });
      } else {
        await runOcr(imageDataUrl);
      }
    } catch (reason) {
      if (action === 'ocr') {
        setOcrPanel({
          language: 'en-US',
          message: reason instanceof Error ? reason.message : strings.ocr.failed,
          status: 'error',
        });
      } else {
        setStatus(toStatus(reason, strings));
      }
    }
  };

  const copyOcrText = useCallback(() => {
    if (!ocrPanel || ocrPanel.status !== 'success' || ocrPanel.text.length === 0) {
      return;
    }

    void navigator.clipboard?.writeText(ocrPanel.text).catch((reason: unknown) => {
      setStatus(toStatus(reason, strings));
    });
  }, [ocrPanel, strings]);

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
          clearTextPromptTimer();
          if (ready) {
            void finish();
          }
        }}
        onMouseDown={(event) => {
          if (event.button === 0) {
            beginPointer(toVirtualPoint(event, launchState.virtualBounds), event.detail);
          }
        }}
        onMouseMove={(event) => movePointer(toVirtualPoint(event, launchState.virtualBounds))}
        onMouseUp={(event) =>
          endPointer(toVirtualPoint(event, launchState.virtualBounds), event.detail)
        }
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
            <AnnotationLayer
              annotations={
                state.draftAnnotation
                  ? [...state.annotations, state.draftAnnotation]
                  : state.annotations
              }
              draftAnnotation={state.draftAnnotation}
              selection={state.selection}
            />
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

      <div className="screenshot-controls">
        {ocrPanel ? (
          <OcrPanel state={ocrPanel} strings={strings} onCopyAll={copyOcrText} />
        ) : undefined}
        {status ? (
          <div className="screenshot-status" data-tone={status.tone}>
            {status.value}
          </div>
        ) : undefined}
        <div className="screenshot-toolbar" role="toolbar">
          <div className="screenshot-tool-group">
            {toolOrder.map((tool) => (
              <button
                data-active={state.tool === tool}
                key={tool}
                onClick={() => {
                  clearTextPromptTimer();
                  dispatch({ tool, type: 'tool-selected' });
                }}
                title={strings.tools[tool]}
                type="button"
              >
                <span>{toolIcon(tool)}</span>
                {strings.tools[tool]}
              </button>
            ))}
          </div>
          <div className="screenshot-tool-group">
            <button onClick={() => dispatch({ type: 'undo' })} type="button">
              <span>&lt;</span>
              {strings.toolbar.undo}
            </button>
            <button onClick={() => dispatch({ type: 'redo' })} type="button">
              <span>&gt;</span>
              {strings.toolbar.redo}
            </button>
          </div>
          <fieldset className="screenshot-tool-group">
            <legend>{strings.groups.color}</legend>
            {colors.map((color) => (
              <button
                aria-label={`${strings.groups.color} ${color}`}
                data-active={state.style.color === color}
                key={color}
                onClick={() => dispatch({ color, type: 'color-selected' })}
                style={{ backgroundColor: color }}
                type="button"
              />
            ))}
          </fieldset>
          <fieldset className="screenshot-tool-group">
            <legend>{strings.groups.line}</legend>
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
            <legend>{strings.groups.font}</legend>
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
            <legend>{strings.groups.format}</legend>
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
              {strings.toolbar.ocr}
            </button>
            <button disabled={!ready} onClick={() => void runOutputAction('pin')} type="button">
              <span>^</span>
              {strings.toolbar.pin}
            </button>
            <button disabled={!ready} onClick={() => void runOutputAction('save')} type="button">
              <span>v</span>
              {strings.toolbar.save}
            </button>
            <button disabled={!ready} onClick={() => void finish()} type="button">
              <span>OK</span>
              {strings.toolbar.done}
            </button>
            <button onClick={cancel} type="button">
              <span>X</span>
              {strings.toolbar.cancel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface OcrPanelProps {
  onCopyAll: () => void;
  state: OcrPanelState;
  strings?: ScreenshotStrings | undefined;
}

export function OcrPanel({ onCopyAll, state, strings = defaultScreenshotStrings }: OcrPanelProps) {
  if (state.status === 'running') {
    return (
      <div className="screenshot-ocr-panel" role="status">
        {strings.ocr.recognizing}
      </div>
    );
  }

  if (state.status === 'success') {
    const hasText = state.text.trim().length > 0;

    return (
      <div className="screenshot-ocr-panel">
        <pre>{hasText ? state.text : strings.ocr.noText}</pre>
        <button disabled={!hasText} onClick={onCopyAll} type="button">
          {strings.ocr.copyAll}
        </button>
      </div>
    );
  }

  return (
    <div className="screenshot-ocr-panel" data-tone={state.status}>
      {state.message}
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

function toSelectionPoint(point: ScreenshotPoint, selection: ScreenshotRect): ScreenshotPoint {
  return {
    x: Math.max(0, Math.min(point.x - selection.x, selection.width)),
    y: Math.max(0, Math.min(point.y - selection.y, selection.height)),
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

function distance(from: ScreenshotPoint, to: ScreenshotPoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
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

interface AnnotationLayerProps {
  annotations: ScreenshotAnnotation[];
  draftAnnotation: ScreenshotAnnotation | undefined;
  selection: ScreenshotRect | undefined;
}

function AnnotationLayer({ annotations, draftAnnotation, selection }: AnnotationLayerProps) {
  if (!selection) {
    return undefined;
  }

  return (
    <svg
      className="screenshot-annotation-layer"
      height={selection.height}
      viewBox={`0 0 ${selection.width} ${selection.height}`}
      width={selection.width}
    >
      {annotations.map((annotation, index) => (
        <AnnotationShape
          annotation={annotation}
          isDraft={annotation === draftAnnotation}
          key={`${annotation.type}-${index}`}
        />
      ))}
    </svg>
  );
}

interface AnnotationShapeProps {
  annotation: ScreenshotAnnotation;
  isDraft: boolean;
}

function AnnotationShape({ annotation, isDraft }: AnnotationShapeProps) {
  const commonProps = {
    'data-annotation-type': annotation.type,
    'data-draft': isDraft ? 'true' : undefined,
    fill: 'none',
    stroke: annotation.style.color,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: annotation.style.lineWidth,
  };

  switch (annotation.type) {
    case 'rectangle':
      return <rect {...commonProps} {...annotation.rect} />;
    case 'ellipse':
      return (
        <ellipse
          {...commonProps}
          cx={annotation.rect.x + annotation.rect.width / 2}
          cy={annotation.rect.y + annotation.rect.height / 2}
          rx={annotation.rect.width / 2}
          ry={annotation.rect.height / 2}
        />
      );
    case 'mosaic':
      return (
        <rect
          {...commonProps}
          {...annotation.rect}
          className="screenshot-annotation-mosaic"
          fill={annotation.style.color}
        />
      );
    case 'arrow':
      return <ArrowShape annotation={annotation} isDraft={isDraft} />;
    case 'pen':
      return (
        <polyline
          {...commonProps}
          points={annotation.points.map((point) => `${point.x},${point.y}`).join(' ')}
        />
      );
    case 'text':
      return (
        <text
          data-annotation-type={annotation.type}
          data-draft={isDraft ? 'true' : undefined}
          fill={annotation.style.color}
          fontSize={annotation.style.fontSize}
          x={annotation.point.x}
          y={annotation.point.y}
        >
          {annotation.text}
        </text>
      );
  }
}

function ArrowShape({
  annotation,
  isDraft,
}: {
  annotation: Extract<ScreenshotAnnotation, { type: 'arrow' }>;
  isDraft: boolean;
}) {
  const angle = Math.atan2(
    annotation.to.y - annotation.from.y,
    annotation.to.x - annotation.from.x,
  );
  const headLength = Math.max(10, annotation.style.lineWidth * 4);
  const left = {
    x: annotation.to.x - headLength * Math.cos(angle - Math.PI / 6),
    y: annotation.to.y - headLength * Math.sin(angle - Math.PI / 6),
  };
  const right = {
    x: annotation.to.x - headLength * Math.cos(angle + Math.PI / 6),
    y: annotation.to.y - headLength * Math.sin(angle + Math.PI / 6),
  };
  const points = [
    `${annotation.from.x},${annotation.from.y}`,
    `${annotation.to.x},${annotation.to.y}`,
    `${left.x},${left.y}`,
    `${annotation.to.x},${annotation.to.y}`,
    `${right.x},${right.y}`,
  ].join(' ');

  return (
    <polyline
      data-annotation-type={annotation.type}
      data-draft={isDraft ? 'true' : undefined}
      fill="none"
      points={points}
      stroke={annotation.style.color}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={annotation.style.lineWidth}
    />
  );
}

function toStatus(reason: unknown, strings: ScreenshotStrings): ScreenshotOverlayStatus {
  return {
    tone: 'error',
    value: reason instanceof Error ? reason.message : strings.actionFailed,
  };
}
