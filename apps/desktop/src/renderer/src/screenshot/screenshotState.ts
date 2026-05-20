export interface ScreenshotPoint {
  x: number;
  y: number;
}

export interface ScreenshotRect extends ScreenshotPoint {
  height: number;
  width: number;
}

export type ScreenshotTool = 'rectangle' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic';

export interface ScreenshotAnnotationStyle {
  color: string;
  fontSize: number;
  lineWidth: number;
}

interface StyledAnnotation {
  style: ScreenshotAnnotationStyle;
}

export type ScreenshotAnnotation =
  | (StyledAnnotation & {
      rect: ScreenshotRect;
      type: 'rectangle' | 'ellipse' | 'mosaic';
    })
  | (StyledAnnotation & {
      from: ScreenshotPoint;
      to: ScreenshotPoint;
      type: 'arrow';
    })
  | (StyledAnnotation & {
      points: ScreenshotPoint[];
      type: 'pen';
    })
  | (StyledAnnotation & {
      point: ScreenshotPoint;
      text: string;
      type: 'text';
    });

export type ScreenshotAnnotationInput =
  | Omit<Extract<ScreenshotAnnotation, { type: 'rectangle' | 'ellipse' | 'mosaic' }>, 'style'>
  | Omit<Extract<ScreenshotAnnotation, { type: 'arrow' }>, 'style'>
  | Omit<Extract<ScreenshotAnnotation, { type: 'pen' }>, 'style'>
  | Omit<Extract<ScreenshotAnnotation, { type: 'text' }>, 'style'>;

export interface ScreenshotState {
  annotations: ScreenshotAnnotation[];
  draftAnnotation: ScreenshotAnnotation | undefined;
  redoAnnotations: ScreenshotAnnotation[];
  selection: ScreenshotRect | undefined;
  selectionAnchor: ScreenshotPoint | undefined;
  style: ScreenshotAnnotationStyle;
  tool: ScreenshotTool;
}

export type ScreenshotAction =
  | {
      point: ScreenshotPoint;
      type: 'selection-started';
    }
  | {
      point: ScreenshotPoint;
      type: 'selection-updated';
    }
  | {
      type: 'selection-ended';
    }
  | {
      rect: ScreenshotRect;
      type: 'selection-set';
    }
  | {
      tool: ScreenshotTool;
      type: 'tool-selected';
    }
  | {
      color: string;
      type: 'color-selected';
    }
  | {
      lineWidth: number;
      type: 'line-width-selected';
    }
  | {
      fontSize: number;
      type: 'font-size-selected';
    }
  | {
      annotation: ScreenshotAnnotationInput;
      type: 'annotation-committed';
    }
  | {
      type: 'undo';
    }
  | {
      type: 'redo';
    };

export function createInitialScreenshotState(): ScreenshotState {
  return {
    annotations: [],
    draftAnnotation: undefined,
    redoAnnotations: [],
    selection: undefined,
    selectionAnchor: undefined,
    style: {
      color: '#ff3355',
      fontSize: 18,
      lineWidth: 3,
    },
    tool: 'rectangle',
  };
}

export function normalizeScreenshotRect(
  from: ScreenshotPoint,
  to: ScreenshotPoint,
): ScreenshotRect {
  return {
    height: Math.abs(to.y - from.y),
    width: Math.abs(to.x - from.x),
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
  };
}

export function isNonEmptyScreenshotRect(rect: ScreenshotRect | undefined): rect is ScreenshotRect {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

export function isScreenshotReadyToComplete(state: ScreenshotState): boolean {
  return isNonEmptyScreenshotRect(state.selection);
}

export function screenshotReducer(
  state: ScreenshotState,
  action: ScreenshotAction,
): ScreenshotState {
  switch (action.type) {
    case 'selection-started':
      return {
        ...state,
        selection: { height: 0, width: 0, x: action.point.x, y: action.point.y },
        selectionAnchor: action.point,
      };
    case 'selection-updated': {
      const anchor = state.selectionAnchor ?? action.point;

      return {
        ...state,
        selection: normalizeScreenshotRect(anchor, action.point),
      };
    }
    case 'selection-ended':
      return {
        ...state,
        selectionAnchor: undefined,
      };
    case 'selection-set':
      return {
        ...state,
        selection: normalizePositiveRect(action.rect),
        selectionAnchor: undefined,
      };
    case 'tool-selected':
      return {
        ...state,
        tool: action.tool,
      };
    case 'color-selected':
      return {
        ...state,
        style: {
          ...state.style,
          color: action.color,
        },
      };
    case 'line-width-selected':
      return {
        ...state,
        style: {
          ...state.style,
          lineWidth: action.lineWidth,
        },
      };
    case 'font-size-selected':
      return {
        ...state,
        style: {
          ...state.style,
          fontSize: action.fontSize,
        },
      };
    case 'annotation-committed':
      return {
        ...state,
        annotations: [...state.annotations, withStyle(action.annotation, state.style)],
        draftAnnotation: undefined,
        redoAnnotations: [],
      };
    case 'undo': {
      const undone = state.annotations.at(-1);

      if (!undone) {
        return state;
      }

      return {
        ...state,
        annotations: state.annotations.slice(0, -1),
        redoAnnotations: [undone, ...state.redoAnnotations],
      };
    }
    case 'redo': {
      const [redone, ...remainingRedo] = state.redoAnnotations;

      if (!redone) {
        return state;
      }

      return {
        ...state,
        annotations: [...state.annotations, redone],
        redoAnnotations: remainingRedo,
      };
    }
  }
}

function normalizePositiveRect(rect: ScreenshotRect): ScreenshotRect {
  return normalizeScreenshotRect(rect, {
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  });
}

function withStyle(
  annotation: ScreenshotAnnotationInput,
  style: ScreenshotAnnotationStyle,
): ScreenshotAnnotation {
  return {
    ...annotation,
    style: { ...style },
  } as ScreenshotAnnotation;
}
