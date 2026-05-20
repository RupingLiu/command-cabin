import type {
  ScreenshotDisplaySnapshot,
  ScreenshotLaunchState,
  ScreenshotSaveFormat,
} from '../../../shared/screenshotApi.js';
import type {
  ScreenshotAnnotation,
  ScreenshotAnnotationStyle,
  ScreenshotPoint,
  ScreenshotRect,
} from './screenshotState.js';

type CanvasImageSourceLike = unknown;

export interface ScreenshotCanvasLike {
  height: number;
  getContext: (contextId: '2d') => ScreenshotCanvasContextLike | null;
  toDataURL: (mimeType: string, quality?: number) => string;
  width: number;
}

export interface ScreenshotCanvasContextLike {
  beginPath: () => void;
  drawImage: (...args: unknown[]) => void;
  ellipse?: (
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ) => void;
  fillText?: (text: string, x: number, y: number) => void;
  getImageData?: (x: number, y: number, width: number, height: number) => ImageDataLike;
  lineTo: (x: number, y: number) => void;
  moveTo: (x: number, y: number) => void;
  putImageData?: (imageData: ImageDataLike, x: number, y: number) => void;
  rect?: (x: number, y: number, width: number, height: number) => void;
  stroke: () => void;
  fillStyle?: string;
  font?: string;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
  lineWidth?: number;
  strokeStyle?: string;
  textBaseline?: CanvasTextBaseline;
}

export interface ImageDataLike {
  data: Uint8ClampedArray;
  height: number;
  width: number;
}

export interface ComposeScreenshotSelectionOptions {
  annotations?: ScreenshotAnnotation[] | undefined;
  createCanvas?: (() => ScreenshotCanvasLike) | undefined;
  format: ScreenshotSaveFormat;
  jpegQuality?: number | undefined;
  launchState: ScreenshotLaunchState;
  loadImage?: ((source: string) => Promise<CanvasImageSourceLike>) | undefined;
  selection: ScreenshotRect;
}

export async function composeScreenshotSelection({
  annotations = [],
  createCanvas = createBrowserCanvas,
  format,
  jpegQuality = 0.92,
  launchState,
  loadImage = loadBrowserImage,
  selection,
}: ComposeScreenshotSelectionOptions): Promise<string> {
  const canvas = createCanvas();
  canvas.width = Math.max(1, Math.round(selection.width));
  canvas.height = Math.max(1, Math.round(selection.height));
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Unable to create screenshot canvas context.');
  }

  for (const display of launchState.displays) {
    if (!rectsIntersect(display.bounds, selection)) {
      continue;
    }

    const image = await loadImage(display.imageDataUrl);
    drawDisplayImage(context, image, display, selection);
  }

  for (const annotation of annotations) {
    drawAnnotation(context, annotation);
  }

  if (format === 'jpg') {
    return canvas.toDataURL('image/jpeg', jpegQuality);
  }

  return canvas.toDataURL('image/png');
}

function drawDisplayImage(
  context: ScreenshotCanvasContextLike,
  image: CanvasImageSourceLike,
  display: ScreenshotDisplaySnapshot,
  selection: ScreenshotRect,
): void {
  context.drawImage(
    image,
    display.bounds.x - selection.x,
    display.bounds.y - selection.y,
    display.bounds.width,
    display.bounds.height,
  );
}

export function drawAnnotation(
  context: ScreenshotCanvasContextLike,
  annotation: ScreenshotAnnotation,
): void {
  applyStyle(context, annotation.style);

  switch (annotation.type) {
    case 'rectangle':
      drawRectangle(context, annotation.rect);
      break;
    case 'ellipse':
      drawEllipse(context, annotation.rect);
      break;
    case 'arrow':
      drawArrow(context, annotation.from, annotation.to, annotation.style.lineWidth);
      break;
    case 'pen':
      drawPen(context, annotation.points);
      break;
    case 'text':
      drawText(context, annotation.text, annotation.point, annotation.style);
      break;
    case 'mosaic':
      drawMosaic(context, annotation.rect);
      break;
  }
}

function applyStyle(context: ScreenshotCanvasContextLike, style: ScreenshotAnnotationStyle): void {
  context.strokeStyle = style.color;
  context.fillStyle = style.color;
  context.lineWidth = style.lineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.font = `${style.fontSize}px sans-serif`;
  context.textBaseline = 'top';
}

function drawRectangle(context: ScreenshotCanvasContextLike, rect: ScreenshotRect): void {
  context.beginPath();
  context.rect?.(rect.x, rect.y, rect.width, rect.height);
  context.stroke();
}

function drawEllipse(context: ScreenshotCanvasContextLike, rect: ScreenshotRect): void {
  context.beginPath();
  context.ellipse?.(
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    rect.width / 2,
    rect.height / 2,
    0,
    0,
    Math.PI * 2,
  );
  context.stroke();
}

function drawArrow(
  context: ScreenshotCanvasContextLike,
  from: ScreenshotPoint,
  to: ScreenshotPoint,
  lineWidth: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLength = Math.max(12, lineWidth * 4);

  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.lineTo(
    to.x - headLength * Math.cos(angle - Math.PI / 6),
    to.y - headLength * Math.sin(angle - Math.PI / 6),
  );
  context.moveTo(to.x, to.y);
  context.lineTo(
    to.x - headLength * Math.cos(angle + Math.PI / 6),
    to.y - headLength * Math.sin(angle + Math.PI / 6),
  );
  context.stroke();
}

function drawPen(context: ScreenshotCanvasContextLike, points: ScreenshotPoint[]): void {
  const [firstPoint, ...remainingPoints] = points;

  if (!firstPoint) {
    return;
  }

  context.beginPath();
  context.moveTo(firstPoint.x, firstPoint.y);

  for (const point of remainingPoints) {
    context.lineTo(point.x, point.y);
  }

  context.stroke();
}

function drawText(
  context: ScreenshotCanvasContextLike,
  text: string,
  point: ScreenshotPoint,
  style: ScreenshotAnnotationStyle,
): void {
  context.font = `${style.fontSize}px sans-serif`;
  context.fillText?.(text, point.x, point.y);
}

function drawMosaic(context: ScreenshotCanvasContextLike, rect: ScreenshotRect): void {
  if (!context.getImageData || !context.putImageData) {
    drawRectangle(context, rect);
    return;
  }

  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const imageData = context.getImageData(Math.round(rect.x), Math.round(rect.y), width, height);

  pixelate(imageData, 8);
  context.putImageData(imageData, Math.round(rect.x), Math.round(rect.y));
}

function pixelate(imageData: ImageDataLike, blockSize: number): void {
  for (let y = 0; y < imageData.height; y += blockSize) {
    for (let x = 0; x < imageData.width; x += blockSize) {
      const sourceIndex = (y * imageData.width + x) * 4;
      const red = imageData.data[sourceIndex] ?? 0;
      const green = imageData.data[sourceIndex + 1] ?? 0;
      const blue = imageData.data[sourceIndex + 2] ?? 0;
      const alpha = imageData.data[sourceIndex + 3] ?? 255;

      for (let blockY = y; blockY < Math.min(y + blockSize, imageData.height); blockY += 1) {
        for (let blockX = x; blockX < Math.min(x + blockSize, imageData.width); blockX += 1) {
          const targetIndex = (blockY * imageData.width + blockX) * 4;
          imageData.data[targetIndex] = red;
          imageData.data[targetIndex + 1] = green;
          imageData.data[targetIndex + 2] = blue;
          imageData.data[targetIndex + 3] = alpha;
        }
      }
    }
  }
}

function rectsIntersect(a: ScreenshotRect, b: ScreenshotRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function createBrowserCanvas(): ScreenshotCanvasLike {
  return document.createElement('canvas') as ScreenshotCanvasLike;
}

function loadBrowserImage(source: string): Promise<CanvasImageSourceLike> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load screenshot display image.'));
    image.src = source;
  });
}
