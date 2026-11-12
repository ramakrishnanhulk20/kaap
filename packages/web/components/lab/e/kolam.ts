// A sikku kolam: one unbroken line woven around a grid of dots, the pattern drawn at a Tamil
// threshold. On a grid of `cols` by `rows` dots the line is the path of a ball bouncing at 45
// degrees inside the rectangle that holds the dots; it closes into a single loop whenever the two
// counts share no factor. Each bounce is rounded, so the line curls around the dot beside it.

export interface Point {
  x: number;
  y: number;
}

export interface Kolam {
  dots: Point[];
  /** The loop cut at every bounce, in drawing order; each piece is one SVG path. */
  pieces: string[];
  /** Where the loop begins, and the unit direction it leaves in. */
  start: Point;
  heading: Point;
  /** The outermost point of the turn on the right side nearest the middle, and the same below. */
  rightTurn: Point;
  bottomTurn: Point;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Bounce {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

// How far from a bounce, along the line, the rounding starts, in dot spacings. The shortest run
// between two bounces is 0.707 spacings, so anything under half of that keeps the curves apart.
const ROUNDING = 0.33;

const fixed = (value: number) => value.toFixed(2);

export function buildKolam(cols: number, rows: number, spacing: number, origin: Point): Kolam {
  // Doubled coordinates, so every crossing and every wall is a whole number.
  const wallX = 2 * cols - 1;
  const wallY = 2 * rows - 1;
  const bounces: Bounce[] = [];
  let x = 1;
  let y = 0;
  let dx = 1;
  let dy = 1;
  for (let step = 0; step < 8 * cols * rows; step++) {
    x += dx;
    y += dy;
    const nextDx = x === -1 || x === wallX ? -dx : dx;
    const nextDy = y === -1 || y === wallY ? -dy : dy;
    if (nextDx !== dx || nextDy !== dy) {
      bounces.push({ x, y, inX: dx, inY: dy, outX: nextDx, outY: nextDy });
      dx = nextDx;
      dy = nextDy;
    }
    if (x === 1 && y === 0 && dx === 1 && dy === 1) break;
  }

  const px = (doubled: number) => origin.x + (doubled / 2) * spacing;
  const py = (doubled: number) => origin.y + (doubled / 2) * spacing;
  const reach = (ROUNDING / Math.SQRT2) * spacing;

  // The loop starts just after its last bounce, so the first piece is a whole run.
  const pieces: string[] = [];
  for (let k = 0; k < bounces.length; k++) {
    const from = bounces[(k + bounces.length - 1) % bounces.length];
    const to = bounces[k];
    const startX = px(from.x) + from.outX * reach;
    const startY = py(from.y) + from.outY * reach;
    const cornerX = px(to.x);
    const cornerY = py(to.y);
    pieces.push(
      `M${fixed(startX)} ${fixed(startY)}` +
        `L${fixed(cornerX - to.inX * reach)} ${fixed(cornerY - to.inY * reach)}` +
        `Q${fixed(cornerX)} ${fixed(cornerY)} ${fixed(cornerX + to.outX * reach)} ${fixed(cornerY + to.outY * reach)}`,
    );
  }

  const last = bounces[bounces.length - 1];
  const start = { x: px(last.x) + last.outX * reach, y: py(last.y) + last.outY * reach };
  const heading = { x: last.outX / Math.SQRT2, y: last.outY / Math.SQRT2 };

  const nearest = (wall: 'x' | 'y', value: number, middle: number): Bounce =>
    bounces
      .filter((bounce) => bounce[wall] === value)
      .sort((a, b) => Math.abs((wall === 'x' ? a.y : a.x) - middle) - Math.abs((wall === 'x' ? b.y : b.x) - middle))[0];
  const right = nearest('x', wallX, (wallY - 1) / 2);
  const below = nearest('y', wallY, (wallX - 1) / 2);
  // The rounded turn passes a quarter of the way in from the corner it replaces.
  const turnPoint = (bounce: Bounce): Point => ({
    x: px(bounce.x) + ((bounce.outX - bounce.inX) * reach) / 4,
    y: py(bounce.y) + ((bounce.outY - bounce.inY) * reach) / 4,
  });

  const dots: Point[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) dots.push({ x: origin.x + i * spacing, y: origin.y + j * spacing });
  }

  return {
    dots,
    pieces,
    start,
    heading,
    rightTurn: turnPoint(right),
    bottomTurn: turnPoint(below),
    left: px(-1),
    right: px(wallX),
    top: py(-1),
    bottom: py(wallY),
  };
}
