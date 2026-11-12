// Turns the two pictures the ink forms (the hash, then what it does) into clouds of target points.
// Each picture is drawn in black on a hidden canvas and sampled on a coarse grid, so the dots that
// fill it look stippled, never solid.

export interface Cloud {
  x: Float32Array;
  y: Float32Array;
}

export interface Shapes {
  hash: Cloud;
  phrase: Cloud;
  ring: Cloud;
}

export interface ShapeInput {
  width: number;
  height: number;
  compact: boolean;
  hash: string;
  phrase: string;
  monoFamily: string;
  displayFamily: string;
}

const STEP = 3;
const ROW_PITCH = 1.05;
const LINE_PITCH = 1;
const LONGEST_LINE = 14;
const RING_WIDER = 1.16;
const RING_TALLER = 1.34;
const RING_THICKNESS = 5;
const TAU = Math.PI * 2;

interface Frame {
  cx: number;
  cy: number;
  targetWidth: number;
  maxHeight: number;
}

// The block sits at 62 percent across and 42 percent down (centred on small screens). The height
// limit keeps a tall block, such as the 8 by 8 hash on a phone, inside the canvas.
function frameFor(input: ShapeInput): Frame {
  return {
    cx: input.width * (input.compact ? 0.5 : 0.62),
    cy: input.height * 0.42,
    targetWidth: input.width * (input.compact ? 0.86 : 0.58),
    maxHeight: input.height * 0.84 - 16,
  };
}

function breakLines(text: string): string[] {
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= LONGEST_LINE) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

function hiddenCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = 'black';
  ctx.strokeStyle = 'black';
  return ctx;
}

function sample(ctx: CanvasRenderingContext2D): Cloud {
  const { width, height } = ctx.canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      if (data[(y * width + x) * 4 + 3] > 127) {
        xs.push(Math.min(x + Math.random() * STEP, width));
        ys.push(Math.min(y + Math.random() * STEP, height));
      }
    }
  }
  const order = Array.from(xs.keys());
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { x: Float32Array.from(order, (i) => xs[i]), y: Float32Array.from(order, (i) => ys[i]) };
}

// Draws centred rows of text so the whole block is as wide as the frame asks, then shrinks it if it
// would be taller than the canvas allows. Returns the box the text really fills.
function drawBlock(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  rows: string[],
  font: (size: number) => string,
  pitch: number,
): { width: number; height: number } {
  ctx.font = font(100);
  const widest = Math.max(...rows.map((row) => ctx.measureText(row).width)) / 100;
  const glyphHeight = ctx.measureText('H').actualBoundingBoxAscent / 100;
  const heightPerSize = (rows.length - 1) * pitch + glyphHeight;
  const size = Math.min(frame.targetWidth / widest, frame.maxHeight / heightPerSize);

  ctx.font = font(size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const top = frame.cy - (heightPerSize * size) / 2;
  rows.forEach((row, index) => {
    ctx.fillText(row, frame.cx, top + glyphHeight * size + index * pitch * size);
  });
  return { width: widest * size, height: heightPerSize * size };
}

export function buildShapes(input: ShapeInput): Shapes {
  const frame = frameFor(input);
  const ctx = hiddenCanvas(input.width, input.height);

  const columns = input.compact ? 8 : 16;
  const hashRows = Array.from({ length: Math.ceil(input.hash.length / columns) }, (_, row) =>
    input.hash.slice(row * columns, (row + 1) * columns),
  );
  drawBlock(ctx, frame, hashRows, (size) => `700 ${size}px ${input.monoFamily}, monospace`, ROW_PITCH);
  const hash = sample(ctx);

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const box = drawBlock(
    ctx,
    frame,
    breakLines(input.phrase.toUpperCase()),
    (size) => `800 ${size}px ${input.displayFamily}, sans-serif`,
    LINE_PITCH,
  );
  const phrase = sample(ctx);

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineWidth = RING_THICKNESS;
  ctx.beginPath();
  ctx.ellipse(frame.cx, frame.cy, (box.width * RING_WIDER) / 2, (box.height * RING_TALLER) / 2, 0, 0, TAU);
  ctx.stroke();
  const ring = sample(ctx);

  return { hash, phrase, ring };
}
