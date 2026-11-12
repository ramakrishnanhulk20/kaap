'use client';

import gsap from 'gsap';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { effectPhrase, hashHex, proposalId, withText } from '@/lib/labData';
import { buildKolam, type Kolam, type Point } from './kolam';

// Five by six dots: the two counts share no factor, so the thread is one unbroken loop.
const COLS = 5;
const ROWS = 6;
const TAG_WIDE = 224;
const TAG_TALL = 70;
const LOOP_PAD_X = 14;
const LOOP_PAD_Y = 13;

interface Geometry {
  width: number;
  height: number;
  kolam: Kolam;
  lead: string;
  tail: string;
  tag: Point;
  caption: Point;
  below: boolean;
  thick: number;
}

interface Props {
  section: RefObject<HTMLElement | null>;
  line: RefObject<HTMLElement | null>;
  art: RefObject<HTMLElement | null>;
  still: boolean;
}

const n = (value: number) => value.toFixed(1);

function measure(section: HTMLElement, line: HTMLElement, art: HTMLElement): Geometry | null {
  const frame = section.getBoundingClientRect();
  const width = section.clientWidth;
  const height = section.clientHeight;
  if (!width || !height) return null;
  const lineBox = line.getBoundingClientRect();
  const artBox = art.getBoundingClientRect();
  const artLeft = artBox.left - frame.left;
  const artTop = artBox.top - frame.top;
  const compact = width < 640;

  const spacing = Math.max(34, Math.min(60, artBox.width / (COLS + 0.4), (artBox.height - (compact ? 190 : 110)) / ROWS));
  const tableWide = COLS * spacing;
  const tableTall = ROWS * spacing;
  // Beside the pattern when the page has room there, otherwise under it.
  const roomRight = width - (artLeft + tableWide + 8);
  const below = compact || roomRight < TAG_WIDE + 84;
  const centreX = below ? artLeft + artBox.width / 2 : artLeft + tableWide / 2 + 8;
  const centreY = artTop + (below ? tableTall / 2 + 8 : artBox.height / 2 - 18);
  const kolam = buildKolam(COLS, ROWS, spacing, {
    x: centreX - ((COLS - 1) * spacing) / 2,
    y: centreY - ((ROWS - 1) * spacing) / 2,
  });

  // The thread comes in from the page's left edge, runs under the first line of the headline and
  // on into the pattern, arriving along the pattern's own first stroke.
  const underY = lineBox.bottom - frame.top + 4;
  const underEnd = lineBox.right - frame.left + 16;
  const { start, heading } = kolam;
  const arriveX = start.x - 84 * heading.x;
  const arriveY = start.y - 84 * heading.y;
  const lead = compact
    ? `M-14 ${n(underY)}L${n(underEnd)} ${n(underY)}` +
      `C${n(width + 6)} ${n(underY)} ${n(width - 9)} ${n(underY + 30)} ${n(width - 9)} ${n(underY + 84)}` +
      `L${n(width - 9)} ${n(start.y - 150)}` +
      `C${n(width - 9)} ${n(start.y - 70)} ${n(arriveX)} ${n(arriveY)} ${n(start.x)} ${n(start.y)}`
    : `M-14 ${n(underY)}L${n(underEnd)} ${n(underY)}` +
      `C${n(underEnd + 110)} ${n(underY)} ${n(arriveX)} ${n(arriveY)} ${n(start.x)} ${n(start.y)}`;

  const a = TAG_WIDE / 2 + LOOP_PAD_X;
  const b = TAG_TALL / 2 + LOOP_PAD_Y;
  let tag: Point;
  let tail: string;
  if (below) {
    const from = kolam.bottomTurn;
    tag = {
      x: Math.max(a + 10, Math.min(width - a - 10, from.x)),
      y: kolam.bottom + 34 + b,
    };
    tail =
      `M${n(from.x)} ${n(from.y)}` +
      `C${n(from.x)} ${n(from.y + 16)} ${n(tag.x - 8)} ${n(tag.y - b - 14)} ${n(tag.x)} ${n(tag.y - b)}` +
      `A${n(a)} ${n(b)} 0 1 1 ${n(tag.x)} ${n(tag.y + b)}` +
      `A${n(a)} ${n(b)} 0 1 1 ${n(tag.x - 0.1)} ${n(tag.y - b)}` +
      `l-12 -10`;
  } else {
    const from = kolam.rightTurn;
    tag = { x: Math.min(width - a - 16, kolam.right + 40 + a), y: from.y };
    tail =
      `M${n(from.x)} ${n(from.y)}` +
      `C${n(from.x + 22)} ${n(from.y)} ${n(tag.x - a - 20)} ${n(tag.y + 14)} ${n(tag.x - a)} ${n(tag.y)}` +
      `A${n(a)} ${n(b)} 0 1 1 ${n(tag.x + a)} ${n(tag.y)}` +
      `A${n(a)} ${n(b)} 0 1 1 ${n(tag.x - a)} ${n(tag.y + 0.1)}` +
      `l-10 12`;
  }

  const caption = below
    ? { x: width / 2, y: tag.y + b + 20 }
    : { x: (kolam.left + kolam.right) / 2, y: kolam.bottom + 26 };

  return { width, height, kolam, lead, tail, tag, caption, below, thick: compact ? 2.6 : 3.2 };
}

/** The thread, the pattern it draws around the treasury, and the short scene that plays on it. */
export default function Scene({ section, line, art, still }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useEffect(() => {
    const sectionEl = section.current;
    const lineEl = line.current;
    const artEl = art.current;
    if (!sectionEl || !lineEl || !artEl) return;
    let timer = 0;
    const read = () => setGeometry(measure(sectionEl, lineEl, artEl));
    const queue = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 120);
    };
    // The headline's width is only final once its typeface is in.
    document.fonts.ready.then(read).catch(read);
    const watcher = new ResizeObserver(queue);
    watcher.observe(sectionEl);
    return () => {
      window.clearTimeout(timer);
      watcher.disconnect();
    };
  }, [section, line, art]);

  useEffect(() => {
    const host = root.current;
    if (!host || !geometry) return;
    const ctx = gsap.context(() => {
      const strands = gsap.utils.toArray<SVGGElement>('.k-piece');
      const lengths = strands.map((strand) => (strand.lastElementChild as SVGPathElement).getTotalLength());
      const whole = lengths.reduce((sum, length) => sum + length, 0) || 1;

      if (still) {
        gsap.set('.k-dot', { opacity: 0.5 });
        gsap.set('.k-thread', { strokeDashoffset: 0, opacity: 1 });
        gsap.set('.k-tag, .k-chip, .k-tag-b, .k-cap-c', { opacity: 1 });
        gsap.set('.k-tag-a', { opacity: 0 });
        return;
      }

      const draw = { strokeDashoffset: 0 };
      const hidden = { strokeDashoffset: 1, opacity: 1 };
      const intro = gsap.timeline({ delay: 0.3 });
      intro.to('.k-dot', { opacity: 0.5, duration: 0.5, stagger: 0.012, ease: 'power1.out' }, 0);
      intro.fromTo('.k-lead', hidden, { ...draw, duration: 1.2, ease: 'power2.inOut', immediateRender: false }, 0.1);
      strands.forEach((strand, index) => {
        intro.fromTo(
          strand.children,
          hidden,
          { ...draw, duration: (lengths[index] / whole) * 3.2, ease: 'none', immediateRender: false },
          index === 0 ? '>-0.05' : '>',
        );
      });

      const story = gsap.timeline({ repeat: -1, repeatDelay: 0.9 });
      story
        .to('.k-cap-a', { opacity: 1, duration: 0.4 }, 0)
        .to('.k-cap-a', { opacity: 0, duration: 0.3 }, 1.9)
        .set('.k-tag-a', { opacity: 1 }, 1.9)
        .set('.k-tag-b, .k-chip', { opacity: 0 }, 1.9)
        .fromTo(
          '.k-tag',
          { opacity: 0, x: geometry.below ? 0 : 150, y: geometry.below ? 90 : 0 },
          { opacity: 1, x: 0, y: 0, duration: 1.0, ease: 'power3.out' },
          2.0,
        )
        .to('.k-cap-b', { opacity: 1, duration: 0.4 }, 2.2)
        .fromTo('.k-tail', hidden, { ...draw, duration: 1.0, ease: 'power2.inOut', immediateRender: false }, 3.9)
        .fromTo('.k-tag', { x: geometry.below ? 0 : -7, y: geometry.below ? -6 : 0 }, { x: 0, y: 0, duration: 0.35, ease: 'elastic.out(1, 0.5)', immediateRender: false }, 4.75)
        .to('.k-cap-b', { opacity: 0, duration: 0.3 }, 4.9)
        .to('.k-tag-a', { opacity: 0, duration: 0.3 }, 5.0)
        .to('.k-tag-b', { opacity: 1, duration: 0.4 }, 5.2)
        .fromTo('.k-chip', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2.2)' }, 5.5)
        .to('.k-cap-c', { opacity: 1, duration: 0.4 }, 5.3)
        .to('.k-tag', { opacity: 0, y: geometry.below ? 20 : 26, duration: 0.6, ease: 'power2.in' }, 9.4)
        .to('.k-tail', { strokeDashoffset: 1, duration: 0.7, ease: 'power2.inOut' }, 9.5)
        .set('.k-tail', { opacity: 0 }, 10.2)
        .to('.k-cap-c', { opacity: 0, duration: 0.3 }, 9.6);
      intro.add(story, '>0.2');
    }, host);
    return () => ctx.revert();
  }, [geometry, still]);

  if (!geometry) return <div ref={root} className="pointer-events-none absolute inset-0" aria-hidden="true" />;

  const { kolam, tag, caption, thick } = geometry;
  const thread = {
    fill: 'none',
    stroke: 'var(--accent)',
    strokeWidth: thick,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    pathLength: 1,
    strokeDasharray: '1 1',
    strokeDashoffset: 1,
    opacity: 0,
  };
  const riskWord = withText.riskFloor.charAt(0).toUpperCase() + withText.riskFloor.slice(1);

  return (
    <div ref={root} className="pointer-events-none absolute inset-0 z-[1]" aria-hidden="true">
      <svg width={geometry.width} height={geometry.height} className="absolute inset-0 overflow-visible">
        {kolam.dots.map((dot, index) => (
          <circle key={index} className="k-dot" cx={dot.x} cy={dot.y} r={thick * 0.85} fill="var(--ink)" opacity={0} />
        ))}
        <path className="k-thread k-lead" d={geometry.lead} {...thread} />
        {kolam.pieces.map((piece, index) => (
          <g key={index} className="k-piece">
            {/* A wider stroke in the page's colour under each strand, so a later strand reads as lying over an earlier one. */}
            <path className="k-thread" d={piece} {...thread} stroke="var(--bg)" strokeWidth={thick * 2.6} strokeLinecap="butt" />
            <path className="k-thread" d={piece} {...thread} />
          </g>
        ))}
        <path className="k-thread k-tail" d={geometry.tail} {...thread} />
      </svg>

      <div
        className="k-tag absolute grid rounded-lg border border-line bg-bg px-4 py-3 opacity-0 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.25)]"
        style={{ left: tag.x - TAG_WIDE / 2, top: tag.y - TAG_TALL / 2, width: TAG_WIDE, height: TAG_TALL }}
      >
        <div className="k-tag-a [grid-area:1/1]">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Proposal #{proposalId} asks to sign</p>
          <p className="mt-1.5 font-mono text-[15px] font-medium text-ink">
            {hashHex.slice(0, 10)}…{hashHex.slice(-6)}
          </p>
        </div>
        <div className="k-tag-b opacity-0 [grid-area:1/1]">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Kaap reads</p>
          <p className="mt-1 font-body text-[14.5px] font-semibold leading-[1.25] text-ink">{effectPhrase}</p>
        </div>
        <span className="k-chip absolute -top-3 -right-3 rounded-md bg-ink px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-bg opacity-0">
          {riskWord} · do not sign
        </span>
      </div>

      <div
        className="absolute grid w-[300px] -translate-x-1/2 text-center font-mono text-[11.5px] uppercase leading-[1.5] tracking-[0.12em] text-muted"
        style={{ left: caption.x, top: caption.y }}
      >
        <span className="k-cap-a opacity-0 [grid-area:1/1]">A treasury, with Kaap tied around it</span>
        <span className="k-cap-b opacity-0 [grid-area:1/1]">A request arrives. Members see only a hash</span>
        <span className="k-cap-c opacity-0 [grid-area:1/1]">Kaap reads what the hash hides</span>
      </div>
    </div>
  );
}
