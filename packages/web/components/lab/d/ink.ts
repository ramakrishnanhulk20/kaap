import { buildShapes, type Cloud, type Shapes } from './shapes';

export type Phase = 'flow' | 'hash' | 'meaning';

export interface InkConfig {
  canvas: HTMLCanvasElement;
  // The box that holds the canvas. Its height is set here: the art zone plus the soft tail below it.
  frame: HTMLElement;
  section: HTMLElement;
  // The label. The art zone ends 24px above its top edge.
  anchor: HTMLElement;
  // The caption box. Shapes never reach up into it.
  caption: HTMLElement;
  hash: string;
  phrase: string;
  still: boolean;
  onPhase: (phase: Phase) => void;
}

const START_DELAY_MS = 600;
const LOOP_SECONDS = 16;
const GATHER_AT = 4;
const GATHER_FOR = 1.4;
const MOVE_AT = 8.5;
const MOVE_FOR = 1.4;
const RELEASE_AT = 13.5;
const RELEASE_FOR = 1.5;
const HASH_CAPTION_FROM = 4.6;
const MEANING_CAPTION_FROM = 9.4;
const STILL_LOOP_TIME = 12;

const ZONE_GAP = 24;
const FADE_TAIL = 240;
const CAPTION_GAP = 8;

const WIDE_COUNT = 220000;
const SMALL_COUNT = 70000;
const GATHER_SHARE = 0.55;
const MAX_DOTS_PER_CELL = 3;
const LEFTOVER_OPACITY = 0.35;
const OTHER_RIBBON_ACCENT = 0.06;

const PUSH_RADIUS = 110;
const PUSH_DISTANCE = 46;
const POINTER_EASE = 0.18;
const POINTER_RAMP_SECONDS = 0.15;
const POINTER_FADE_SECONDS = 0.6;

const FLOATS_PER_DOT = 8;
const BYTES_PER_DOT = FLOATS_PER_DOT * 4;

type Rgb = [number, number, number];

const num = (value: number) => value.toFixed(4);

const VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in vec4 a_flow;
layout(location = 1) in vec4 a_look;
layout(location = 2) in vec4 a_goal;
layout(location = 3) in vec4 a_state;

uniform vec2 u_canvas;
uniform vec2 u_zone;
uniform float u_time;
uniform float u_loop;
uniform float u_dpr;
uniform vec3 u_pointer;
uniform vec3 u_ink;
uniform vec3 u_accent;

out vec4 v_colour;

const float DRIFT[4] = float[4](0.012, -0.009, 0.016, -0.006);
const float BASE[4] = float[4](0.26, 0.62, 0.45, 0.88);
const float AMP[4] = float[4](0.16, 0.15, 0.22, 0.13);
const float FREQ[4] = float[4](0.0030, 0.0041, 0.0022, 0.0052);
const float SHIFT[4] = float[4](0.0, 1.9, 3.7, 5.1);

// How far a dot has got through one move, 0 to 1. Each dot starts a little later than the one
// before it, by its own phase, so a crowd arrives and leaves as a wave.
float settle(float start, float length, float phase) {
  float p = clamp(((u_loop - start) / length - phase * 0.35) / 0.65, 0.0, 1.0);
  return p * p * (3.0 - 2.0 * p);
}

void main() {
  float u = a_flow.x;
  float v = a_flow.y;
  float phase = a_flow.z;
  int r = int(a_flow.w + 0.5);
  float t = u_time;
  float h = u_zone.y;

  float x = fract(u + t * DRIFT[r]) * (u_zone.x + 200.0) - 100.0;
  float centre = h * (BASE[r]
    + AMP[r] * sin(x * FREQ[r] + SHIFT[r] + t * 0.11)
    + 0.5 * AMP[r] * sin(x * FREQ[r] * 2.3 + SHIFT[r] * 1.7 - t * 0.07));
  float thick = h * (0.045 + 0.075 * (0.5 + 0.5 * sin(x * 0.0049 + SHIFT[r] * 2.0 + t * 0.05)));
  float y = centre + v * thick;
  x += 6.0 * sin(phase * 40.0 + y * 0.031 + t * 0.9);
  y += 6.0 * sin(phase * 53.0 + x * 0.027 + t * 0.7);
  vec2 flow = vec2(x, y);

  float gather = settle(${num(GATHER_AT)}, ${num(GATHER_FOR)}, phase);
  float move = settle(${num(MOVE_AT)}, ${num(MOVE_FOR)}, phase);
  float release = settle(${num(RELEASE_AT)}, ${num(RELEASE_FOR)}, phase);
  float hasHash = a_state.x;
  float hasPhrase = a_state.y;
  float noHash = a_state.z;
  float noPhrase = a_state.w;

  float toHash = hasHash * gather * (1.0 - move);
  float toPhrase = hasPhrase * move * (1.0 - release);
  float held = clamp(toHash + toPhrase, 0.0, 1.0);

  // Flow, then into the hash, then on to the meaning (or back to the flow for a dot with no place
  // in it), then released.
  vec2 pos = mix(flow, a_goal.xy, hasHash * gather);
  pos = mix(pos, mix(flow, a_goal.zw, hasPhrase), move);
  pos = mix(pos, flow, release);
  pos += held * vec2(
    0.3 * sin(t * 23.0 + phase * 113.0) + 0.3 * sin(t * 31.0 + phase * 47.0),
    0.3 * sin(t * 19.0 + phase * 71.0) + 0.3 * sin(t * 29.0 + phase * 89.0)
  );

  vec2 away = pos - u_pointer.xy;
  float d = length(away);
  if (u_pointer.z > 0.0 && d < ${num(PUSH_RADIUS)}) {
    float s = 1.0 - d / ${num(PUSH_RADIUS)};
    vec2 dir = d > 0.001 ? away / d : vec2(0.0, -1.0);
    pos += dir * s * s * ${num(PUSH_DISTANCE)} * u_pointer.z;
  }

  float tail = 1.0 - smoothstep(0.0, ${num(FADE_TAIL)}, pos.y - h);
  float profile = exp(-0.5 * v * v * 0.6);
  float body = mix(profile, 1.0, held);
  float dim = 1.0 - ${num(1 - LEFTOVER_OPACITY)} * clamp(noHash * gather * (1.0 - move) + noPhrase * move * (1.0 - release), 0.0, 1.0);
  float alpha = a_look.y * body * dim * tail;

  vec3 rgb = mix(u_ink, u_accent, a_look.z);
  v_colour = vec4(rgb * alpha, alpha);
  gl_PointSize = a_look.x * u_dpr;
  gl_Position = vec4(pos.x / u_canvas.x * 2.0 - 1.0, 1.0 - pos.y / u_canvas.y * 2.0, 0.0, 1.0);
  if (alpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;

in vec4 v_colour;
out vec4 outColour;

void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  if (r > 1.0) discard;
  outColour = v_colour * (1.0 - smoothstep(0.7, 1.0, r));
}
`;

const UNIFORMS = ['u_canvas', 'u_zone', 'u_time', 'u_loop', 'u_dpr', 'u_pointer', 'u_ink', 'u_accent'] as const;

interface Gpu {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  flowBuffer: WebGLBuffer;
  goalBuffer: WebGLBuffer;
  uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
}

interface Dots {
  count: number;
  // Per dot, eight numbers that never change: place along its ribbon, offset across it, phase, ribbon
  // number, then size, opacity, colour flag and a spare.
  flow: Float32Array;
  accent: Uint8Array;
}

const normal = () => {
  const radius = Math.sqrt(-2 * Math.log(1 - Math.random()));
  return Math.max(-4, Math.min(4, radius * Math.cos(Math.PI * 2 * Math.random())));
};

function createDots(count: number): Dots {
  const flow = new Float32Array(count * FLOATS_PER_DOT);
  const accent = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const ribbon = Math.floor(Math.random() * 4);
    const isAccent = ribbon === 2 || Math.random() < OTHER_RIBBON_ACCENT;
    const o = i * FLOATS_PER_DOT;
    flow[o] = Math.random();
    flow[o + 1] = normal();
    flow[o + 2] = Math.random();
    flow[o + 3] = ribbon;
    flow[o + 4] = 1 + Math.random() * 0.9;
    flow[o + 5] = 0.25 + Math.random() * 0.5;
    flow[o + 6] = isAccent ? 1 : 0;
    accent[i] = isAccent ? 1 : 0;
  }
  return { count, flow, accent };
}

// How many dots can share one cell of a picture: as many as the crowd allows, up to a small limit.
function dotsPerCell(dots: number, cells: number): number {
  if (cells === 0) return 0;
  return Math.max(1, Math.min(MAX_DOTS_PER_CELL, Math.floor(dots / cells)));
}

function aim(out: Float32Array, at: number, cloud: Cloud, index: number) {
  out[at] = cloud.x[index] + Math.random();
  out[at + 1] = cloud.y[index] + Math.random();
}

// Per dot, eight numbers: where it goes for the hash, where it goes for the meaning, then four flags:
// has a hash place, has a meaning place, wants one but the picture ran out of cells (hash), the same
// for the meaning. Only the first 55 percent of the dots ever gather. Ink dots take the hash and the
// phrase, accent dots take the ring.
function dealGoals(dots: Dots, shapes: Shapes | null): Float32Array {
  const out = new Float32Array(dots.count * FLOATS_PER_DOT);
  if (!shapes) return out;
  const eligible = Math.floor(dots.count * GATHER_SHARE);
  let inkEligible = 0;
  for (let i = 0; i < eligible; i++) if (!dots.accent[i]) inkEligible++;
  const accentEligible = eligible - inkEligible;

  const hashCells = shapes.hash.x.length;
  const phraseCells = shapes.phrase.x.length;
  const ringCells = shapes.ring.x.length;
  const hashReach = hashCells * dotsPerCell(inkEligible, hashCells);
  const phraseReach = phraseCells * dotsPerCell(inkEligible, phraseCells);
  const ringReach = ringCells * dotsPerCell(accentEligible, ringCells);

  let inkSeen = 0;
  let accentSeen = 0;
  for (let i = 0; i < eligible; i++) {
    const o = i * FLOATS_PER_DOT;
    if (dots.accent[i]) {
      const k = accentSeen++;
      if (k < ringReach) {
        aim(out, o + 2, shapes.ring, k % ringCells);
        out[o + 5] = 1;
      } else {
        out[o + 7] = 1;
      }
    } else {
      const k = inkSeen++;
      if (k < hashReach) {
        aim(out, o, shapes.hash, k % hashCells);
        out[o + 4] = 1;
      } else {
        out[o + 6] = 1;
      }
      if (k < phraseReach) {
        aim(out, o + 2, shapes.phrase, k % phraseCells);
        out[o + 5] = 1;
      } else {
        out[o + 7] = 1;
      }
    }
  }
  return out;
}

// Offset of an element from the top of an ancestor, ignoring transforms (the entrance animation
// lifts the label 24px while it fades in, which must not move the art zone).
function topWithin(element: HTMLElement, ancestor: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

/** Starts the ink on a canvas. Returns the function that stops it and removes every listener. */
export function startInk(config: InkConfig): () => void {
  const { canvas, frame, section, anchor, caption, still } = config;
  const noop = () => undefined;

  const startedAt = performance.now();
  const compactQuery = window.matchMedia('(max-width: 639.98px)');

  let disposed = false;
  let gpu: Gpu | null = null;
  let width = 0;
  let zoneHeight = 0;
  let ratio = 1;
  let dots: Dots | null = null;
  let shapes: Shapes | null = null;
  let goals: Float32Array | null = null;
  let fontsReady = false;
  let started = false;
  let inView = true;
  let inkColour: Rgb = [0, 0, 0];
  let accentColour: Rgb = [0, 0, 0];
  let phase: Phase = 'flow';
  let raf = 0;
  let startTimer = 0;
  let layoutTimer = 0;
  let lastNow = 0;
  let flowClock = 0;
  let loopClock = 0;
  const pointer = { x: 0, y: 0, goalX: 0, goalY: 0, strength: 0, active: false };

  const setPhase = (next: Phase) => {
    if (next === phase) return;
    phase = next;
    config.onPhase(next);
  };

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

  const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const buildGpu = (): Gpu | null => {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return null;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return null;
    }

    const vao = gl.createVertexArray();
    const flowBuffer = gl.createBuffer();
    const goalBuffer = gl.createBuffer();
    if (!vao || !flowBuffer || !goalBuffer) return null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, BYTES_PER_DOT, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_DOT, 16);
    gl.bindBuffer(gl.ARRAY_BUFFER, goalBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, BYTES_PER_DOT, 0);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, BYTES_PER_DOT, 16);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    const uniforms = {} as Gpu['uniforms'];
    for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(program, name);
    return { gl, program, vao, flowBuffer, goalBuffer, uniforms };
  };

  const uploadFlow = () => {
    if (!gpu || !dots) return;
    gpu.gl.bindBuffer(gpu.gl.ARRAY_BUFFER, gpu.flowBuffer);
    gpu.gl.bufferData(gpu.gl.ARRAY_BUFFER, dots.flow, gpu.gl.STATIC_DRAW);
  };

  const uploadGoals = () => {
    if (!gpu || !goals) return;
    gpu.gl.bindBuffer(gpu.gl.ARRAY_BUFFER, gpu.goalBuffer);
    gpu.gl.bufferData(gpu.gl.ARRAY_BUFFER, goals, gpu.gl.STATIC_DRAW);
  };

  const render = (flow: number, loop: number) => {
    if (!gpu || !dots || !width || !zoneHeight || gpu.gl.isContextLost()) return;
    const { gl, uniforms } = gpu;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(gpu.program);
    gl.uniform2f(uniforms.u_canvas, width, zoneHeight + FADE_TAIL);
    gl.uniform2f(uniforms.u_zone, width, zoneHeight);
    gl.uniform1f(uniforms.u_time, flow);
    gl.uniform1f(uniforms.u_loop, loop);
    gl.uniform1f(uniforms.u_dpr, ratio);
    gl.uniform3f(uniforms.u_pointer, pointer.x, pointer.y, pointer.strength);
    gl.uniform3f(uniforms.u_ink, inkColour[0] / 255, inkColour[1] / 255, inkColour[2] / 255);
    gl.uniform3f(uniforms.u_accent, accentColour[0] / 255, accentColour[1] / 255, accentColour[2] / 255);
    gl.bindVertexArray(gpu.vao);
    gl.drawArrays(gl.POINTS, 0, dots.count);
    gl.bindVertexArray(null);
  };

  const redraw = () => {
    if (still) render(STILL_LOOP_TIME, STILL_LOOP_TIME);
    else render(flowClock, loopClock);
  };

  const rebuildGoals = () => {
    if (!dots || !fontsReady || !width || !zoneHeight) return;
    const { mono, display } = families();
    shapes = buildShapes({
      width,
      height: zoneHeight,
      compact: compactQuery.matches,
      clearTop: topWithin(caption, frame) + caption.offsetHeight + CAPTION_GAP,
      hash: config.hash,
      phrase: config.phrase,
      monoFamily: mono,
      displayFamily: display,
    });
    goals = dealGoals(dots, shapes);
    uploadGoals();
  };

  const layout = () => {
    const nextWidth = section.clientWidth;
    const nextZone = Math.max(60, Math.round(topWithin(anchor, section) - ZONE_GAP));
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    const wanted = compactQuery.matches ? SMALL_COUNT : WIDE_COUNT;
    if (!nextWidth || (dots?.count === wanted && nextWidth === width && nextZone === zoneHeight && nextRatio === ratio)) {
      return;
    }
    width = nextWidth;
    zoneHeight = nextZone;
    ratio = nextRatio;
    frame.style.height = `${zoneHeight + FADE_TAIL}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round((zoneHeight + FADE_TAIL) * ratio);
    if (!dots || dots.count !== wanted) {
      dots = createDots(wanted);
      // Empty goals until the fonts are in, so the first frames have a full buffer to read.
      goals = dealGoals(dots, null);
      uploadFlow();
      uploadGoals();
    }
    rebuildGoals();
    redraw();
  };

  const shouldRun = () => started && inView && !document.hidden && !disposed && !!gpu && !still;

  const frameLoop = (now: number) => {
    raf = requestAnimationFrame(frameLoop);
    const dt = Math.min(Math.max((now - lastNow) / 1000, 0), 0.05);
    lastNow = now;
    flowClock += dt;
    loopClock = (loopClock + dt) % LOOP_SECONDS;
    if (pointer.active) {
      pointer.strength = Math.min(1, pointer.strength + dt / POINTER_RAMP_SECONDS);
      const ease = 1 - Math.pow(1 - POINTER_EASE, dt * 60);
      pointer.x += (pointer.goalX - pointer.x) * ease;
      pointer.y += (pointer.goalY - pointer.y) * ease;
    } else {
      pointer.strength = Math.max(0, pointer.strength - dt / POINTER_FADE_SECONDS);
    }
    setPhase(
      loopClock >= HASH_CAPTION_FROM && loopClock < MOVE_AT
        ? 'hash'
        : loopClock >= MEANING_CAPTION_FROM && loopClock < RELEASE_AT
          ? 'meaning'
          : 'flow',
    );
    render(flowClock, loopClock);
  };

  const sync = () => {
    if (shouldRun()) {
      if (!raf) {
        lastNow = performance.now();
        raf = requestAnimationFrame(frameLoop);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const place = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    pointer.goalX = event.clientX - box.left;
    pointer.goalY = event.clientY - box.top;
    if (!pointer.active && pointer.strength <= 0.001) {
      pointer.x = pointer.goalX;
      pointer.y = pointer.goalY;
    }
    pointer.active = true;
  };
  const release = () => {
    pointer.active = false;
  };
  const releaseTouch = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') pointer.active = false;
  };

  const queueLayout = () => {
    window.clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(layout, 100);
  };

  const themeWatcher = new MutationObserver(() => {
    readColours();
    redraw();
  });
  const sizeWatcher = new ResizeObserver(queueLayout);
  const viewWatcher = new IntersectionObserver((entries) => {
    inView = entries[entries.length - 1].isIntersecting;
    sync();
  });

  const onLost = (event: Event) => {
    event.preventDefault();
    gpu = null;
    sync();
  };
  const onRestored = () => {
    gpu = buildGpu();
    uploadFlow();
    uploadGoals();
    redraw();
    sync();
  };

  readColours();
  gpu = buildGpu();
  if (!gpu) return noop;
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  layout();
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  sizeWatcher.observe(section);
  window.addEventListener('resize', queueLayout);
  if (!still) {
    viewWatcher.observe(section);
    section.addEventListener('pointermove', place, { passive: true });
    section.addEventListener('pointerdown', place, { passive: true });
    section.addEventListener('pointerleave', release, { passive: true });
    section.addEventListener('pointerup', releaseTouch, { passive: true });
    section.addEventListener('pointercancel', release, { passive: true });
    window.addEventListener('scroll', release, { passive: true });
    document.addEventListener('visibilitychange', sync);
  }

  // The shapes need the real fonts. If they are slow, give up waiting after three seconds and use
  // whatever the browser has.
  const { mono, display } = families();
  Promise.race([
    Promise.all([
      document.fonts.load(`700 40px ${mono}`, config.hash),
      document.fonts.load(`800 40px ${display}`, config.phrase.toUpperCase()),
    ]),
    new Promise((resolve) => window.setTimeout(resolve, 3000)),
  ])
    .catch(() => undefined)
    .then(() => {
      if (disposed) return;
      fontsReady = true;
      rebuildGoals();
      redraw();
      if (still) {
        phase = 'meaning';
        config.onPhase('meaning');
        return;
      }
      startTimer = window.setTimeout(
        () => {
          started = true;
          sync();
        },
        Math.max(0, START_DELAY_MS - (performance.now() - startedAt)),
      );
    });

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    window.clearTimeout(startTimer);
    window.clearTimeout(layoutTimer);
    themeWatcher.disconnect();
    sizeWatcher.disconnect();
    viewWatcher.disconnect();
    window.removeEventListener('resize', queueLayout);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    section.removeEventListener('pointermove', place);
    section.removeEventListener('pointerdown', place);
    section.removeEventListener('pointerleave', release);
    section.removeEventListener('pointerup', releaseTouch);
    section.removeEventListener('pointercancel', release);
    window.removeEventListener('scroll', release);
    document.removeEventListener('visibilitychange', sync);
    if (gpu && !gpu.gl.isContextLost()) {
      gpu.gl.deleteBuffer(gpu.flowBuffer);
      gpu.gl.deleteBuffer(gpu.goalBuffer);
      gpu.gl.deleteVertexArray(gpu.vao);
      gpu.gl.deleteProgram(gpu.program);
    }
    gpu = null;
  };
}
