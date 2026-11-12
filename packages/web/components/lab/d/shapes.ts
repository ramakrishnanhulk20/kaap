// Turns the two pictures the ink forms (the hash, then what it does) into clouds of target cells.
// Each picture is drawn in black on a hidden canvas the size of the art zone and every filled pixel
// becomes one cell. The engine deals the cells out to the dots, more than one dot to a cell when
// there are plenty of dots, so the letters come out dense but still stippled.

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
  // Lowest y a shape may reach, so nothing formed ever sits under the caption.
  clearTop: number;
  hash: string;
  phrase: string;
  monoFamily: string;
  displayFamily: string;
}

const ROW_PITCH = 1.05;
const LINE_PITCH = 1;
const LONGEST_LINE = 14;
const HASH_COLUMNS = 16;
const RING_WIDER = 1.22;
const RING_TALLER = 1.4;
const RING_THICKNESS = 6;
const RING_SPARE = 8;
const FILLED = 110;
const TAU = Math.PI * 2;

interface Box {
  cx: number;
  cy: number;
  maxWide: number;
  maxTall: number;
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
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > FILLED) {
        xs.push(x);
        ys.push(y);
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

// Draws centred rows of text as large as the box allows and returns the box the text really fills.
// A tighter height limit than the box's own can be passed in when the ring needs room around it.
function drawBlock(
  ctx: CanvasRenderingContext2D,
  box: Box,
  tallest: number,
  widest: number,
  rows: string[],
  font: (size: number) => string,
  pitch: number,
): { width: number; height: number } {
  ctx.font = font(100);
  const rowWidth = Math.max(...rows.map((row) => ctx.measureText(row).width)) / 100;
  const ascent = Math.max(...rows.map((row) => ctx.measureText(row).actualBoundingBoxAscent)) / 100;
  const tallPerSize = (rows.length - 1) * pitch + ascent;
  const size = Math.max(4, Math.min(widest / rowWidth, tallest / tallPerSize));

  ctx.font = font(size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const top = box.cy - (tallPerSize * size) / 2;
  rows.forEach((row, index) => {
    ctx.fillText(row, box.cx, top + ascent * size + index * pitch * size);
  });
  return { width: rowWidth * size, height: tallPerSize * size };
}

export function buildShapes(input: ShapeInput): Shapes {
  const { width, height, compact } = input;
  const box: Box = {
    cx: width * (compact ? 0.5 : 0.6),
    cy: height * 0.5,
    maxWide: width * (compact ? 0.9 : 0.6),
    maxTall: height * 0.78,
  };
  const clearTall = 2 * (box.cy - input.clearTop);
  const ctx = hiddenCanvas(width, height);

  const hashRows = Array.from({ length: Math.ceil(input.hash.length / HASH_COLUMNS) }, (_, row) =>
    input.hash.slice(row * HASH_COLUMNS, (row + 1) * HASH_COLUMNS),
  );
  drawBlock(
    ctx,
    box,
    Math.min(box.maxTall, clearTall),
    box.maxWide,
    hashRows,
    (size) => `700 ${size}px ${input.monoFamily}, monospace`,
    ROW_PITCH,
  );
  const hash = sample(ctx);

  // The phrase must leave room for a ring that is wider and taller than it and still ends 8px short of
  // every edge of the zone, so the room around the box centre decides the largest the phrase can be.
  const edge = RING_SPARE + RING_THICKNESS / 2;
  const roomWide = 2 * (Math.min(box.cx, width - box.cx) - edge);
  const roomTall = 2 * (Math.min(box.cy, height - box.cy) - edge);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const text = drawBlock(
    ctx,
    box,
    Math.min(height * 0.74, clearTall, roomTall / RING_TALLER),
    Math.min(box.maxWide, roomWide / RING_WIDER),
    breakLines(input.phrase.toUpperCase()),
    (size) => `800 ${size}px ${input.displayFamily}, sans-serif`,
    LINE_PITCH,
  );
  const phrase = sample(ctx);

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineWidth = RING_THICKNESS;
  ctx.beginPath();
  ctx.ellipse(box.cx, box.cy, (text.width * RING_WIDER) / 2, (text.height * RING_TALLER) / 2, 0, 0, TAU);
  ctx.stroke();
  const ring = sample(ctx);

  return { hash, phrase, ring };
}
