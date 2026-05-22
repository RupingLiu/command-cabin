import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MouseEvent, Ref } from 'react';

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

interface PendingTextAnnotation {
  point: ScreenshotPoint;
  value: string;
}

export type OcrPanelState = { status: 'running' } | ScreenshotOcrResult;

type ScreenshotApi = NonNullable<Window['desktopApi']['screenshot']>;
type DesktopApi = Window['desktopApi'];
type PendingTextTimer = ReturnType<typeof setTimeout>;
type ScreenshotStrings = UiStrings['screenshot'];
type MosaicAnnotation = ScreenshotAnnotation & { rect: ScreenshotRect; type: 'mosaic' };

export interface ScreenshotOverlayProps {
  desktopApi?: DesktopApi | undefined;
}

export interface PendingTextAnnotationController {
  cancel: () => void;
  schedule: (callback: () => void) => void;
}

export interface PendingTextAnnotationControllerOptions {
  clearTimer: (timer: PendingTextTimer) => void;
  delayMs: number;
  setTimer: (callback: () => void, delayMs: number) => PendingTextTimer;
}

export interface TextAnnotationKeyInput {
  ctrlKey?: boolean | undefined;
  key: string;
  metaKey?: boolean | undefined;
}

export type TextAnnotationKeyAction = 'cancel' | 'commit' | 'edit';
export type PendingTextPointerAction = 'commit' | 'none';

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

export function getTextAnnotationKeyAction({
  ctrlKey = false,
  key,
  metaKey = false,
}: TextAnnotationKeyInput): TextAnnotationKeyAction {
  if (key === 'Escape') {
    return 'cancel';
  }

  if (key === 'Enter' && (ctrlKey || metaKey)) {
    return 'commit';
  }

  return 'edit';
}

export function getPendingTextPointerAction(
  hasPendingTextAnnotation: boolean,
): PendingTextPointerAction {
  return hasPendingTextAnnotation ? 'commit' : 'none';
}

export function getNextLoadedDisplaySourceIds(
  sourceIds: ReadonlySet<string>,
  sourceId: string,
): Set<string> {
  return new Set([...sourceIds, sourceId]);
}

export function areDisplayImagesLoaded(
  loadedSourceIds: ReadonlySet<string>,
  launchState: Pick<ScreenshotLaunchState, 'displays'>,
): boolean {
  return launchState.displays.every((display) => loadedSourceIds.has(display.sourceId));
}

export function shouldNotifyScreenshotReady(
  loadedSourceIds: ReadonlySet<string>,
  launchState: Pick<ScreenshotLaunchState, 'displays'>,
): boolean {
  return areDisplayImagesLoaded(loadedSourceIds, launchState);
}

export function ScreenshotOverlay({ desktopApi: injectedDesktopApi }: ScreenshotOverlayProps = {}) {
  const [launchState, setLaunchState] = useState<ScreenshotLaunchState | undefined>();
  const [launchVersion, setLaunchVersion] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [strings, setStrings] = useState<ScreenshotStrings>(defaultScreenshotStrings);

  useEffect(() => {
    const desktopApi =
      injectedDesktopApi ??
      (typeof window !== 'undefined' && 'desktopApi' in window ? window.desktopApi : undefined);
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

    return screenshotApi.onLaunchState((nextLaunchState) => {
      setLaunchState(nextLaunchState);
      setError(undefined);
      setLaunchVersion((version) => version + 1);
    });
  }, [injectedDesktopApi]);

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
      desktopApi={
        injectedDesktopApi?.screenshot ??
        (typeof window !== 'undefined' ? window.desktopApi.screenshot : undefined)
      }
      key={launchVersion}
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
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [saveFormat, setSaveFormat] = useState<ScreenshotSaveFormat>('png');
  const [status, setStatus] = useState<ScreenshotOverlayStatus | undefined>();
  const [ocrPanel, setOcrPanel] = useState<OcrPanelState | undefined>();
  const [pendingTextAnnotation, setPendingTextAnnotation] = useState<
    PendingTextAnnotation | undefined
  >();
  const [loadedDisplaySourceIds, setLoadedDisplaySourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pointer, setPointer] = useState<ScreenshotPoint>({
    x: launchState.virtualBounds.x,
    y: launchState.virtualBounds.y,
  });
  const ready = isScreenshotReadyToComplete(state);
  const offsetSelection = useMemo(
    () => (state.selection ? offsetRect(state.selection, launchState.virtualBounds) : undefined),
    [launchState.virtualBounds, state.selection],
  );
  const visibleAnnotations = useMemo(() => {
    const annotations = state.draftAnnotation
      ? [...state.annotations, state.draftAnnotation]
      : [...state.annotations];
    const text = pendingTextAnnotation?.value.trim();

    if (pendingTextAnnotation && text) {
      annotations.push({
        point: pendingTextAnnotation.point,
        style: { ...state.style },
        text,
        type: 'text',
      });
    }

    return annotations;
  }, [pendingTextAnnotation, state.annotations, state.draftAnnotation, state.style]);

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

  const cancelPendingTextAnnotation = useCallback(() => {
    clearTextPromptTimer();
    setPendingTextAnnotation(undefined);
  }, [clearTextPromptTimer]);

  const commitPendingTextAnnotation = useCallback(() => {
    clearTextPromptTimer();
    setPendingTextAnnotation((pending) => {
      const text = pending?.value.trim();

      if (pending && text) {
        dispatch({
          annotation: {
            point: pending.point,
            text,
            type: 'text',
          },
          type: 'annotation-committed',
        });
      }

      return undefined;
    });
  }, [clearTextPromptTimer]);

  const cancel = useCallback(() => {
    cancelPendingTextAnnotation();
    try {
      void requireScreenshotApi(desktopApi, strings.controlsUnavailable).cancel();
    } catch (reason) {
      setStatus(toStatus(reason, strings));
    }
  }, [cancelPendingTextAnnotation, desktopApi, strings]);

  const exportImage = useCallback(
    async (format: ScreenshotSaveFormat = 'png') => {
      if (!state.selection) {
        throw new Error('Select an area first.');
      }

      return composeScreenshotSelection({
        annotations: visibleAnnotations,
        format,
        launchState,
        selection: state.selection,
      });
    },
    [launchState, state.selection, visibleAnnotations],
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
      if (isEditableEventTarget(event.target)) {
        return;
      }

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

  useEffect(() => {
    textInputRef.current?.focus();
  }, [pendingTextAnnotation]);

  useEffect(() => cancelPendingTextAnnotation, [cancelPendingTextAnnotation]);

  useEffect(() => {
    if (!shouldNotifyScreenshotReady(loadedDisplaySourceIds, launchState)) {
      return;
    }

    const animationFrameId = requestAnimationFrame(() => {
      try {
        void requireScreenshotApi(desktopApi, strings.controlsUnavailable)
          .readyToShow()
          .catch(() => undefined);
      } catch {
        // The overlay can still render in tests or degraded preload contexts.
      }
    });

    return () => cancelAnimationFrame(animationFrameId);
  }, [desktopApi, launchState, loadedDisplaySourceIds, strings.controlsUnavailable]);

  const beginPointer = (point: ScreenshotPoint, detail: number) => {
    setPointer(point);

    if (getPendingTextPointerAction(Boolean(pendingTextAnnotation)) === 'commit') {
      commitPendingTextAnnotation();
    } else {
      clearTextPromptTimer();
    }

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
      setPendingTextAnnotation({
        point,
        value: '',
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
          cancelPendingTextAnnotation();
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
            onLoad={() => {
              setLoadedDisplaySourceIds((sourceIds) =>
                getNextLoadedDisplaySourceIds(sourceIds, display.sourceId),
              );
            }}
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
            <MosaicOverlay
              annotations={visibleAnnotations}
              draftAnnotation={state.draftAnnotation}
            />
            <AnnotationLayer
              annotations={visibleAnnotations}
              draftAnnotation={state.draftAnnotation}
              selection={state.selection}
            />
            {pendingTextAnnotation ? (
              <TextAnnotationInput
                cancelLabel={strings.toolbar.cancel}
                commitLabel={strings.toolbar.done}
                fontSize={state.style.fontSize}
                inputRef={textInputRef}
                point={pendingTextAnnotation.point}
                placeholder={strings.textPrompt.defaultText}
                value={pendingTextAnnotation.value}
                onCancel={cancelPendingTextAnnotation}
                onChange={(value) =>
                  setPendingTextAnnotation((pending) =>
                    pending
                      ? {
                          ...pending,
                          value,
                        }
                      : pending,
                  )
                }
                onCommit={commitPendingTextAnnotation}
              />
            ) : undefined}
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
                  cancelPendingTextAnnotation();
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
                className="screenshot-color-swatch"
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

interface TextAnnotationInputProps {
  cancelLabel: string;
  commitLabel: string;
  fontSize: number;
  inputRef?: Ref<HTMLTextAreaElement> | undefined;
  placeholder: string;
  point: ScreenshotPoint;
  value: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onCommit: () => void;
}

export function TextAnnotationInput({
  cancelLabel,
  commitLabel,
  fontSize,
  inputRef,
  placeholder,
  point,
  value,
  onCancel,
  onChange,
  onCommit,
}: TextAnnotationInputProps) {
  return (
    <div
      className="screenshot-text-editor"
      style={{
        left: point.x,
        top: point.y,
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
    >
      <textarea
        aria-label={placeholder}
        className="screenshot-text-input"
        ref={inputRef}
        rows={2}
        style={{ fontSize }}
        value={value}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;

          if (nextTarget instanceof Node && event.currentTarget.parentElement?.contains(nextTarget)) {
            return;
          }

          onCommit();
        }}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation?.();

          const action = getTextAnnotationKeyAction({
            ctrlKey: event.ctrlKey,
            key: event.key,
            metaKey: event.metaKey,
          });

          if (action === 'commit') {
            event.preventDefault();
            onCommit();
          } else if (action === 'cancel') {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
      />
      <span className="screenshot-text-actions">
        <button
          aria-label={commitLabel}
          onClick={onCommit}
          onMouseDown={(event) => event.preventDefault()}
          title={commitLabel}
          type="button"
        >
          OK
        </button>
        <button
          aria-label={cancelLabel}
          onClick={onCancel}
          onMouseDown={(event) => event.preventDefault()}
          title={cancelLabel}
          type="button"
        >
          X
        </button>
      </span>
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

function isEditableEventTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
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

  const visibleAnnotations = annotations.filter((annotation) => annotation.type !== 'mosaic');

  return (
    <svg
      className="screenshot-annotation-layer"
      height={selection.height}
      viewBox={`0 0 ${selection.width} ${selection.height}`}
      width={selection.width}
    >
      {visibleAnnotations.map((annotation, index) => (
        <AnnotationShape
          annotation={annotation}
          isDraft={annotation === draftAnnotation}
          key={`${annotation.type}-${index}`}
        />
      ))}
    </svg>
  );
}

interface MosaicOverlayProps {
  annotations: ScreenshotAnnotation[];
  draftAnnotation: ScreenshotAnnotation | undefined;
}

function MosaicOverlay({ annotations, draftAnnotation }: MosaicOverlayProps) {
  const mosaics = annotations.filter(isMosaicAnnotation);

  if (mosaics.length === 0) {
    return undefined;
  }

  return (
    <div className="screenshot-mosaic-layer">
      {mosaics.map((annotation, index) => (
        <div
          className="screenshot-mosaic-preview"
          data-annotation-type="mosaic"
          data-draft={annotation === draftAnnotation ? 'true' : undefined}
          key={`mosaic-${index}`}
          style={{
            borderColor: annotation.style.color,
            height: annotation.rect.height,
            left: annotation.rect.x,
            top: annotation.rect.y,
            width: annotation.rect.width,
          }}
        />
      ))}
    </div>
  );
}

function isMosaicAnnotation(annotation: ScreenshotAnnotation): annotation is MosaicAnnotation {
  return annotation.type === 'mosaic';
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
      return undefined;
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
          {annotation.text.split('\n').map((line, index) => (
            <tspan
              dy={index === 0 ? 0 : annotation.style.fontSize * 1.2}
              key={`${index}-${line}`}
              x={annotation.point.x}
            >
              {line}
            </tspan>
          ))}
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
