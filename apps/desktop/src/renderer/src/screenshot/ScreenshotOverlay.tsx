import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MouseEvent, ReactNode, Ref } from 'react';

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
const screenshotToolbarGap = 12;
const defaultScreenshotToolbarSize = { height: 48, width: 520 };

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

export interface ScreenshotToolbarPlacementInput {
  selection: ScreenshotRect;
  toolbar: {
    height: number;
    width: number;
  };
  viewport: {
    height: number;
    width: number;
  };
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

export function getScreenshotToolbarPlacement({
  selection,
  toolbar,
  viewport,
}: ScreenshotToolbarPlacementInput): ScreenshotPoint {
  const centeredX = selection.x + selection.width / 2 - toolbar.width / 2;
  const x = clamp(centeredX, 0, Math.max(0, viewport.width - toolbar.width));
  const belowY = selection.y + selection.height + screenshotToolbarGap;
  const aboveY = selection.y - toolbar.height - screenshotToolbarGap;

  if (belowY + toolbar.height <= viewport.height) {
    return { x, y: belowY };
  }

  if (aboveY >= 0) {
    return { x, y: aboveY };
  }

  return {
    x,
    y: clamp(belowY, 0, Math.max(0, viewport.height - toolbar.height)),
  };
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
    return <div className="screenshot-overlay screenshot-overlay--empty">{strings.loading}</div>;
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
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarSize, setToolbarSize] = useState(defaultScreenshotToolbarSize);
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
  const toolbarPlacement = useMemo(
    () =>
      offsetSelection
        ? getScreenshotToolbarPlacement({
            selection: offsetSelection,
            toolbar: toolbarSize,
            viewport: {
              height: launchState.virtualBounds.height,
              width: launchState.virtualBounds.width,
            },
          })
        : undefined,
    [
      launchState.virtualBounds.height,
      launchState.virtualBounds.width,
      offsetSelection,
      toolbarSize,
    ],
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
    const toolbarRect = toolbarRef.current?.getBoundingClientRect();

    if (!toolbarRect || toolbarRect.width === 0 || toolbarRect.height === 0) {
      return;
    }

    const nextToolbarSize = {
      height: toolbarRect.height,
      width: toolbarRect.width,
    };

    setToolbarSize((currentToolbarSize) =>
      currentToolbarSize.height === nextToolbarSize.height &&
      currentToolbarSize.width === nextToolbarSize.width
        ? currentToolbarSize
        : nextToolbarSize,
    );
  }, [offsetSelection]);

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

      {offsetSelection && ready ? (
        <div
          className="screenshot-controls"
          data-floating={toolbarPlacement ? 'true' : undefined}
          style={
            toolbarPlacement
              ? {
                  left: toolbarPlacement.x,
                  top: toolbarPlacement.y,
                }
              : undefined
          }
        >
          {ocrPanel ? (
            <OcrPanel state={ocrPanel} strings={strings} onCopyAll={copyOcrText} />
          ) : undefined}
          {status ? (
            <div className="screenshot-status" data-tone={status.tone}>
              {status.value}
            </div>
          ) : undefined}
          <div className="screenshot-toolbar" ref={toolbarRef} role="toolbar">
            <div className="screenshot-tool-group">
              {toolOrder.map((tool) => (
                <button
                  aria-label={strings.tools[tool]}
                  data-active={state.tool === tool}
                  key={tool}
                  onClick={() => {
                    cancelPendingTextAnnotation();
                    dispatch({ tool, type: 'tool-selected' });
                  }}
                  title={strings.tools[tool]}
                  type="button"
                >
                  <span className="screenshot-icon">{toolIcon(tool)}</span>
                  <span className="screenshot-button-label">{strings.tools[tool]}</span>
                </button>
              ))}
            </div>
            <div className="screenshot-tool-group">
              <button
                aria-label={strings.toolbar.undo}
                onClick={() => dispatch({ type: 'undo' })}
                title={strings.toolbar.undo}
                type="button"
              >
                <span className="screenshot-icon">{toolbarIcon('undo')}</span>
                <span className="screenshot-button-label">{strings.toolbar.undo}</span>
              </button>
              <button
                aria-label={strings.toolbar.redo}
                onClick={() => dispatch({ type: 'redo' })}
                title={strings.toolbar.redo}
                type="button"
              >
                <span className="screenshot-icon">{toolbarIcon('redo')}</span>
                <span className="screenshot-button-label">{strings.toolbar.redo}</span>
              </button>
            </div>
            <details className="screenshot-style-menu">
              <summary
                aria-label={`${strings.groups.color} / ${strings.groups.line}`}
                title={`${strings.groups.color} / ${strings.groups.line}`}
              >
                <span className="screenshot-icon">{toolbarIcon('style')}</span>
              </summary>
              <div className="screenshot-style-menu__panel">
                <fieldset className="screenshot-style-group">
                  <legend>{strings.groups.color}</legend>
                  {colors.map((color) => (
                    <button
                      aria-label={`${strings.groups.color} ${color}`}
                      className="screenshot-color-swatch"
                      data-active={state.style.color === color}
                      key={color}
                      onClick={() => dispatch({ color, type: 'color-selected' })}
                      style={{ backgroundColor: color }}
                      title={`${strings.groups.color} ${color}`}
                      type="button"
                    />
                  ))}
                </fieldset>
                {state.tool === 'text' ? (
                  <fieldset className="screenshot-style-group">
                    <legend>{strings.groups.font}</legend>
                    {fontSizes.map((fontSize) => (
                      <button
                        aria-label={`${strings.groups.font} ${fontSize}`}
                        data-active={state.style.fontSize === fontSize}
                        key={fontSize}
                        onClick={() => dispatch({ fontSize, type: 'font-size-selected' })}
                        title={`${strings.groups.font} ${fontSize}`}
                        type="button"
                      >
                        {fontSize}
                      </button>
                    ))}
                  </fieldset>
                ) : (
                  <fieldset className="screenshot-style-group">
                    <legend>{strings.groups.line}</legend>
                    {lineWidths.map((lineWidth) => (
                      <button
                        aria-label={`${strings.groups.line} ${lineWidth}`}
                        data-active={state.style.lineWidth === lineWidth}
                        key={lineWidth}
                        onClick={() => dispatch({ lineWidth, type: 'line-width-selected' })}
                        title={`${strings.groups.line} ${lineWidth}`}
                        type="button"
                      >
                        <span
                          className="screenshot-line-preview"
                          style={{ height: Math.max(2, lineWidth) }}
                        />
                      </button>
                    ))}
                  </fieldset>
                )}
                <fieldset className="screenshot-style-group">
                  <legend>{strings.groups.format}</legend>
                  {(['png', 'jpg'] as ScreenshotSaveFormat[]).map((format) => (
                    <button
                      aria-label={`${strings.groups.format} ${format.toUpperCase()}`}
                      data-active={saveFormat === format}
                      key={format}
                      onClick={() => setSaveFormat(format)}
                      title={`${strings.groups.format} ${format.toUpperCase()}`}
                      type="button"
                    >
                      {format.toUpperCase()}
                    </button>
                  ))}
                </fieldset>
              </div>
            </details>
            <div className="screenshot-tool-group screenshot-tool-group--actions">
              <button
                aria-label={strings.toolbar.ocr}
                onClick={() => void runOutputAction('ocr')}
                title={strings.toolbar.ocr}
                type="button"
              >
                <span className="screenshot-icon">{toolbarIcon('ocr')}</span>
                <span className="screenshot-button-label">{strings.toolbar.ocr}</span>
              </button>
              <button
                aria-label={strings.toolbar.pin}
                onClick={() => void runOutputAction('pin')}
                title={strings.toolbar.pin}
                type="button"
              >
                <span className="screenshot-icon">{toolbarIcon('pin')}</span>
                <span className="screenshot-button-label">{strings.toolbar.pin}</span>
              </button>
              <button
                aria-label={strings.toolbar.save}
                onClick={() => void runOutputAction('save')}
                title={strings.toolbar.save}
                type="button"
              >
                <span className="screenshot-icon">{toolbarIcon('save')}</span>
                <span className="screenshot-button-label">{strings.toolbar.save}</span>
              </button>
              <button
                aria-label={strings.toolbar.done}
                className="screenshot-action-button screenshot-action-button--done"
                onClick={() => void finish()}
                title={strings.toolbar.done}
                type="button"
              >
                <span className="screenshot-icon">{toolbarIcon('done')}</span>
                <span className="screenshot-button-label">{strings.toolbar.done}</span>
              </button>
              <button
                aria-label={strings.toolbar.cancel}
                className="screenshot-action-button screenshot-action-button--cancel"
                onClick={cancel}
                title={strings.toolbar.cancel}
                type="button"
              >
                <span className="screenshot-icon">{toolbarIcon('cancel')}</span>
                <span className="screenshot-button-label">{strings.toolbar.cancel}</span>
              </button>
            </div>
          </div>
        </div>
      ) : undefined}
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

          if (
            nextTarget instanceof Node &&
            event.currentTarget.parentElement?.contains(nextTarget)
          ) {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

type ToolbarIconName = 'cancel' | 'done' | 'ocr' | 'pin' | 'redo' | 'save' | 'style' | 'undo';

function ScreenshotIcon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

function toolIcon(tool: ScreenshotTool) {
  switch (tool) {
    case 'rectangle':
      return (
        <ScreenshotIcon>
          <rect height="12" rx="1.5" width="14" x="5" y="6" />
        </ScreenshotIcon>
      );
    case 'ellipse':
      return (
        <ScreenshotIcon>
          <ellipse cx="12" cy="12" rx="7" ry="5" />
        </ScreenshotIcon>
      );
    case 'arrow':
      return (
        <ScreenshotIcon>
          <path d="M5 18 18 5" />
          <path d="M11 5h7v7" />
        </ScreenshotIcon>
      );
    case 'pen':
      return (
        <ScreenshotIcon>
          <path d="M5 18.5 7 14l8.8-8.8a2.1 2.1 0 0 1 3 3L10 17l-5 1.5Z" />
          <path d="m14.5 6.5 3 3" />
        </ScreenshotIcon>
      );
    case 'text':
      return (
        <ScreenshotIcon>
          <path d="M5 6h14" />
          <path d="M12 6v12" />
          <path d="M9 18h6" />
        </ScreenshotIcon>
      );
    case 'mosaic':
      return (
        <ScreenshotIcon>
          <rect height="4" width="4" x="5" y="5" />
          <rect height="4" width="4" x="10" y="5" />
          <rect height="4" width="4" x="15" y="5" />
          <rect height="4" width="4" x="5" y="10" />
          <rect height="4" width="4" x="10" y="10" />
          <rect height="4" width="4" x="15" y="10" />
          <rect height="4" width="4" x="5" y="15" />
          <rect height="4" width="4" x="10" y="15" />
          <rect height="4" width="4" x="15" y="15" />
        </ScreenshotIcon>
      );
  }
}

function toolbarIcon(icon: ToolbarIconName) {
  switch (icon) {
    case 'undo':
      return (
        <ScreenshotIcon>
          <path d="M9 7 5 11l4 4" />
          <path d="M6 11h8a5 5 0 0 1 5 5v1" />
        </ScreenshotIcon>
      );
    case 'redo':
      return (
        <ScreenshotIcon>
          <path d="m15 7 4 4-4 4" />
          <path d="M18 11h-8a5 5 0 0 0-5 5v1" />
        </ScreenshotIcon>
      );
    case 'style':
      return (
        <ScreenshotIcon>
          <circle cx="7" cy="7" r="2" />
          <circle cx="13" cy="6" r="2" />
          <circle cx="17" cy="11" r="2" />
          <path d="M12 21a8 8 0 1 1 7.6-10.5c.5 1.5-.5 3-2.1 3H15a2 2 0 0 0-2 2v1.5a2.5 2.5 0 0 1-1 4Z" />
        </ScreenshotIcon>
      );
    case 'ocr':
      return (
        <ScreenshotIcon>
          <path d="M5 7V5h14v2" />
          <path d="M12 5v14" />
          <path d="M8 19h8" />
          <path d="M5 12h4" />
          <path d="M15 12h4" />
        </ScreenshotIcon>
      );
    case 'pin':
      return (
        <ScreenshotIcon>
          <path d="m14 4 6 6-3 1-4 4v5l-4-4-5 5 5-5-4-4h5l4-4 1-4Z" />
        </ScreenshotIcon>
      );
    case 'save':
      return (
        <ScreenshotIcon>
          <path d="M6 4h10l2 2v14H6Z" />
          <path d="M9 4v6h6V4" />
          <path d="M9 17h6" />
        </ScreenshotIcon>
      );
    case 'done':
      return (
        <ScreenshotIcon>
          <path d="m5 12 4 4L19 6" />
        </ScreenshotIcon>
      );
    case 'cancel':
      return (
        <ScreenshotIcon>
          <path d="M6 6 18 18" />
          <path d="M18 6 6 18" />
        </ScreenshotIcon>
      );
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
