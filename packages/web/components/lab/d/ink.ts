import { buildShapes, type Shapes } from './shapes';

export type Phase = 'flow' | 'hash' | 'meaning';

export interface InkConfig {
  canvas: HTMLCanvasElement;
  listenOn: HTMLElement;
  hash: string;
  phrase: string;
  still: boolean;
  onPhase: (phase: Phase) => void;
}

const START_DELAY_MS = 600;
const LOOP_SECONDS = 15;
const GATHER_AT = 4;
const MEANING_AT = 8;
const RELEASE_AT = 12.5;

const WIDE_COUNT = 14000;
const SMALL_COUNT = 6000;
const INK_SHARE = 0.86;
const INK_OPACITY = 0.55;
const ACCENT_OPACITY = 0.8;
const LEFTOVER_OPACITY = 0.3;

// Velocities are in pixels per frame at 60 frames a second, and every step is scaled by how many
// 60ths of a second really passed, so a fast screen does not change the picture.
const FLOW_SPEED = 22 / 60;
const FLOW_EASE = 0.04;
const SPRING = 0.06;
const DAMPING = 0.82;
const JITTER = 0.35;
const PUSH_RADIUS = 90;
const PUSH_ACCEL = 900 / 3600;
const LEVEL_EASE = 0.08;

// Flowing dots live on a strip a little wider than the canvas. A dot that leaves re-enters from the
// opposite side, and the field can push dots outward on both seams at once; with no strip they would
// pile up on the visible edge, with it they do their shuffling out of sight.
const MARGIN = 24;

type Rgb = [number, number, number];

type Shape = 0 | 1 | 2;

interface Dots {
  count: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  radius: Float32Array;
  accent: Uint8Array;
  // -1 for a spare dot dimmed while a picture forms, 0 while flowing, 1 while sitting in a picture.
  level: Float32Array;
  hashX: Float32Array;
  hashY: Float32Array;
  meanX: Float32Array;
  meanY: Float32Array;
  hasHash: Uint8Array;
  hasMean: Uint8Array;
  alpha: Float32Array;
}

function createDots(count: number, width: number, height: number): Dots {
  const dots: Dots = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    radius: new Float32Array(count),
    accent: new Uint8Array(count),
    level: new Float32Array(count),
    hashX: new Float32Array(count),
    hashY: new Float32Array(count),
    meanX: new Float32Array(count),
    meanY: new Float32Array(count),
    hasHash: new Uint8Array(count),
    hasMean: new Uint8Array(count),
    alpha: new Float32Array(count),
  };
  const inkCount = Math.round(count * INK_SHARE);
  for (let i = 0; i < count; i++) {
    dots.x[i] = Math.random() * (width + 2 * MARGIN) - MARGIN;
    dots.y[i] = Math.random() * (height + 2 * MARGIN) - MARGIN;
    dots.radius[i] = 0.6 + Math.random() * 0.8;
    dots.accent[i] = i < inkCount ? 0 : 1;
  }
  return dots;
}

// Ink dots take the hash points and the phrase points. Accent dots take the ring points.
function dealTargets(dots: Dots, shapes: Shapes) {
  let inkSeen = 0;
  let accentSeen = 0;
  for (let i = 0; i < dots.count; i++) {
    if (dots.accent[i]) {
      const k = accentSeen++;
      dots.hasHash[i] = 0;
      dots.hasMean[i] = k < shapes.ring.x.length ? 1 : 0;
      if (dots.hasMean[i]) {
        dots.meanX[i] = shapes.ring.x[k];
        dots.meanY[i] = shapes.ring.y[k];
      }
    } else {
      const k = inkSeen++;
      dots.hasHash[i] = k < shapes.hash.x.length ? 1 : 0;
      if (dots.hasHash[i]) {
        dots.hashX[i] = shapes.hash.x[k];
        dots.hashY[i] = shapes.hash.y[k];
      }
      dots.hasMean[i] = k < shapes.phrase.x.length ? 1 : 0;
      if (dots.hasMean[i]) {
        dots.meanX[i] = shapes.phrase.x[k];
        dots.meanY[i] = shapes.phrase.y[k];
      }
    }
  }
}

/** Starts the ink on a canvas. Returns the function that stops it and removes every listener. */
export function startInk(config: InkConfig): () => void {
  const { canvas, listenOn, still } = config;
  const ctx = canvas.getContext('2d')!;
  const startedAt = performance.now();

  let disposed = false;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let dots: Dots | null = null;
  let shapes: Shapes | null = null;
  let fontsReady = false;
  let inkColour: Rgb = [0, 0, 0];
  let accentColour: Rgb = [0, 0, 0];
  let image: ImageData | null = null;
  let phase: Phase = 'flow';
  let raf = 0;
  let loopTimer = 0;
  let layoutTimer = 0;
  let running = false;
  let lastFrame = 0;
  let loopClock = 0;
  let flowClock = 0;
  const pointer = { x: 0, y: 0, active: false };

  const setPhase = (next: Phase) => {
    if (next === phase) return;
    phase = next;
    config.onPhase(next);
  };

  // Any CSS colour, turned into numbers by painting it on a one pixel canvas.
  const toRgb = (css: string): Rgb => {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
    probeCtx.fillStyle = css || 'black';
    probeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  };

  const readColours = () => {
    const style = getComputedStyle(canvas);
    inkColour = toRgb(style.getPropertyValue('--ink').trim());
    accentColour = toRgb(style.getPropertyValue('--accent').trim());
  };

  const families = () => {
    const style = getComputedStyle(canvas);
    return {
      mono: style.getPropertyValue('--font-mono').trim(),
      display: style.getPropertyValue('--font-grotesk').trim(),
    };
  };

  const rebuildShapes = () => {
    if (!dots || !fontsReady || !width || !height) return;
    const { mono, display } = families();
    shapes = buildShapes({
      width,
      height,
      compact: window.matchMedia('(max-width: 639.98px)').matches,
      hash: config.hash,
      phrase: config.phrase,
      monoFamily: mono,
      displayFamily: display,
    });
    dealTargets(dots, shapes);
  };

  // Work out each dot's position, its opacity step, and nothing else. Drawing is a separate pass.
  const step = (dt: number, t: number, shape: Shape) => {
    if (!dots) return;
    const d = dots;
    const k = dt * 60;
    const flowEase = 1 - Math.pow(1 - FLOW_EASE, k);
    const damp = Math.pow(DAMPING, k);
    const pull = SPRING * k;
    const levelEase = 1 - Math.pow(1 - LEVEL_EASE, k);
    const push = PUSH_ACCEL * k;
    const shake = JITTER * Math.sqrt(k);
    const pushOn = pointer.active;
    const t07 = t * 0.07;
    const t05 = t * 0.05;
    const t03 = t * 0.03;
    const t04 = t * 0.04;

    for (let i = 0; i < d.count; i++) {
      let x = d.x[i];
      let y = d.y[i];
      let vx = d.vx[i];
      let vy = d.vy[i];
      const accent = d.accent[i];

      const seated = shape === 1 ? d.hasHash[i] : shape === 2 ? d.hasMean[i] : 0;
      let wanted = 0;
      if (seated) wanted = 1;
      else if (shape === 2 || (shape === 1 && !accent)) wanted = -1;
      d.level[i] += (wanted - d.level[i]) * levelEase;

      if (pushOn) {
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const near = dx * dx + dy * dy;
        if (near < PUSH_RADIUS * PUSH_RADIUS && near > 0.0001) {
          const dist = Math.sqrt(near);
          const strength = (push * (1 - dist / PUSH_RADIUS)) / dist;
          vx += dx * strength;
          vy += dy * strength;
        }
      }

      if (seated) {
        const tx = shape === 1 ? d.hashX[i] : d.meanX[i];
        const ty = shape === 1 ? d.hashY[i] : d.meanY[i];
        vx += (tx - x) * pull;
        vy += (ty - y) * pull;
        vx *= damp;
        vy *= damp;
        x += vx * k + (Math.random() - 0.5) * 2 * shake;
        y += vy * k + (Math.random() - 0.5) * 2 * shake;
      } else {
        const angle =
          2.2 * Math.sin(x * 0.0021 + t07) + 1.7 * Math.cos(y * 0.0027 - t05) + 1.3 * Math.sin((x + y) * 0.0016 + t03);
        vx += (Math.cos(angle) * FLOW_SPEED - vx) * flowEase;
        vy += (Math.sin(angle) * FLOW_SPEED - vy) * flowEase;
        x += vx * k;
        y += vy * k;
        if (x < -MARGIN) x += width + 2 * MARGIN;
        else if (x > width + MARGIN) x -= width + 2 * MARGIN;
        if (y < -MARGIN) y += height + 2 * MARGIN;
        else if (y > height + MARGIN) y -= height + 2 * MARGIN;
      }

      d.x[i] = x;
      d.y[i] = y;
      d.vx[i] = vx;
      d.vy[i] = vy;

      const ribbon = Math.min(
        1,
        Math.max(0, 0.15 + 1.1 * (0.5 + 0.5 * Math.sin(x * 0.004 + 1.3 * Math.sin(y * 0.003 + t04)))),
      );
      const own = accent ? ACCENT_OPACITY : INK_OPACITY;
      const level = d.level[i];
      const alpha =
        level >= 0
          ? own * (ribbon + (1 - ribbon) * level)
          : (own + (LEFTOVER_OPACITY - own) * -level) * ribbon;
      const unseen = x < -2 || x > width + 2 || y < -2 || y > height + 2;
      d.alpha[i] = unseen ? 0 : alpha;
    }
  };

  // Each dot is written straight into a pixel buffer, which is then sent to the canvas in one call.
  // Thousands of tiny arcs through the canvas drawing calls cost far more than this on a laptop GPU.
  const draw = () => {
    if (!dots || !image) return;
    const d = dots;
    const pixels = image.data;
    const stride = image.width;
    const rows = image.height;
    pixels.fill(0);

    for (let i = 0; i < d.count; i++) {
      const alpha = d.alpha[i];
      if (alpha <= 0.004) continue;
      const rgb = d.accent[i] ? accentColour : inkColour;
      const cx = d.x[i] * ratio;
      const cy = d.y[i] * ratio;
      const rr = d.radius[i] * ratio;
      const x0 = Math.max(0, Math.floor(cx - rr - 1));
      const x1 = Math.min(stride - 1, Math.ceil(cx + rr + 1));
      const y0 = Math.max(0, Math.floor(cy - rr - 1));
      const y1 = Math.min(rows - 1, Math.ceil(cy + rr + 1));
      for (let py = y0; py <= y1; py++) {
        const dy = py + 0.5 - cy;
        let o = (py * stride + x0) * 4;
        for (let px = x0; px <= x1; px++, o += 4) {
          const dx = px + 0.5 - cx;
          let cover = rr + 0.5 - Math.sqrt(dx * dx + dy * dy);
          if (cover <= 0) continue;
          if (cover > 1) cover = 1;
          const source = cover * alpha;
          const below = pixels[o + 3] / 255;
          if (below === 0) {
            pixels[o] = rgb[0];
            pixels[o + 1] = rgb[1];
            pixels[o + 2] = rgb[2];
            pixels[o + 3] = source * 255;
          } else {
            const keep = below * (1 - source);
            const total = source + keep;
            pixels[o] = (rgb[0] * source + pixels[o] * keep) / total;
            pixels[o + 1] = (rgb[1] * source + pixels[o + 1] * keep) / total;
            pixels[o + 2] = (rgb[2] * source + pixels[o + 2] * keep) / total;
            pixels[o + 3] = total * 255;
          }
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  };

  // The still picture: only the dots that belong to the phrase and its ring, each on its point.
  const drawStill = () => {
    if (!dots || !shapes) return;
    const d = dots;
    for (let i = 0; i < d.count; i++) {
      if (d.hasMean[i]) {
        d.x[i] = d.meanX[i];
        d.y[i] = d.meanY[i];
        d.alpha[i] = d.accent[i] ? ACCENT_OPACITY : INK_OPACITY;
      } else {
        d.alpha[i] = 0;
      }
    }
    draw();
  };

  const layout = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (!w || !h || (dots && w === width && h === height && nextRatio === ratio)) return;
    ratio = nextRatio;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    image = ctx.createImageData(canvas.width, canvas.height);

    const compact = window.matchMedia('(max-width: 639.98px)').matches;
    const wanted = compact ? SMALL_COUNT : WIDE_COUNT;
    if (!dots || dots.count !== wanted) {
      dots = createDots(wanted, w, h);
    } else if (width && height) {
      for (let i = 0; i < dots.count; i++) {
        dots.x[i] = ((dots.x[i] + MARGIN) * (w + 2 * MARGIN)) / (width + 2 * MARGIN) - MARGIN;
        dots.y[i] = ((dots.y[i] + MARGIN) * (h + 2 * MARGIN)) / (height + 2 * MARGIN) - MARGIN;
      }
    }
    width = w;
    height = h;
    rebuildShapes();
    if (still) drawStill();
    else if (!running) {
      step(0, 0, 0);
      draw();
    }
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.05);
    lastFrame = now;
    loopClock = (loopClock + dt) % LOOP_SECONDS;
    flowClock += dt;
    const shape: Shape = loopClock < GATHER_AT ? 0 : loopClock < MEANING_AT ? 1 : loopClock < RELEASE_AT ? 2 : 0;
    setPhase(shape === 0 ? 'flow' : shape === 1 ? 'hash' : 'meaning');
    step(dt, flowClock, shape);
    draw();
  };

  const startLoop = () => {
    running = true;
    lastFrame = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const onVisibility = () => {
    if (!running) return;
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };

  const place = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
    pointer.active = true;
  };
  const release = () => {
    pointer.active = false;
  };
  const releaseTouch = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') pointer.active = false;
  };

  const themeWatcher = new MutationObserver(() => {
    readColours();
    if (still) drawStill();
  });
  const sizeWatcher = new ResizeObserver(() => {
    window.clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(layout, 100);
  });

  readColours();
  layout();
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  sizeWatcher.observe(canvas);
  if (!still) {
    listenOn.addEventListener('pointermove', place, { passive: true });
    listenOn.addEventListener('pointerdown', place, { passive: true });
    listenOn.addEventListener('pointerleave', release, { passive: true });
    listenOn.addEventListener('pointerup', releaseTouch, { passive: true });
    listenOn.addEventListener('pointercancel', release, { passive: true });
    window.addEventListener('scroll', release, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
  }

  // The shapes need the real fonts. If they are slow, give up waiting after three seconds and use
  // whatever the browser has.
  const { mono, display } = families();
  const waitForFonts = Promise.race([
    Promise.all([
      document.fonts.load(`700 40px ${mono}`, config.hash),
      document.fonts.load(`800 40px ${display}`, config.phrase.toUpperCase()),
    ]),
    new Promise((resolve) => window.setTimeout(resolve, 3000)),
  ]);
  waitForFonts
    .catch(() => undefined)
    .then(() => {
      if (disposed) return;
      fontsReady = true;
      rebuildShapes();
      if (still) {
        drawStill();
        phase = 'meaning';
        config.onPhase('meaning');
        return;
      }
      loopTimer = window.setTimeout(startLoop, Math.max(0, START_DELAY_MS - (performance.now() - startedAt)));
    });

  return () => {
    disposed = true;
    running = false;
    cancelAnimationFrame(raf);
    window.clearTimeout(loopTimer);
    window.clearTimeout(layoutTimer);
    themeWatcher.disconnect();
    sizeWatcher.disconnect();
    listenOn.removeEventListener('pointermove', place);
    listenOn.removeEventListener('pointerdown', place);
    listenOn.removeEventListener('pointerleave', release);
    listenOn.removeEventListener('pointerup', releaseTouch);
    listenOn.removeEventListener('pointercancel', release);
    window.removeEventListener('scroll', release);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
