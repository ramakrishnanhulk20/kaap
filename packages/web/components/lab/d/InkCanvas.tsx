'use client';

import { motion } from 'framer-motion';
import { useEffect, useRef, type RefObject } from 'react';
import { effectPhrase, hashHex, proposalId } from '@/lib/labData';
import { startInk, type Phase } from './ink';

const FADE_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

interface Props {
  section: RefObject<HTMLElement | null>;
  label: RefObject<HTMLElement | null>;
  still: boolean;
}

// The ink and its caption. The loop drives the caption by setting opacity directly, so React never
// re-renders while the ink moves. The frame's height is set by the engine from the label's position.
export default function InkCanvas({ section, label, still }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const hashCaption = useRef<HTMLSpanElement>(null);
  const meaningCaption = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const caption = captionRef.current;
    const sectionEl = section.current;
    const anchor = label.current;
    if (!frame || !canvas || !caption || !sectionEl || !anchor) return;

    const show = (phase: Phase) => {
      if (hashCaption.current) hashCaption.current.style.opacity = phase === 'hash' ? '1' : '0';
      if (meaningCaption.current) meaningCaption.current.style.opacity = phase === 'meaning' ? '1' : '0';
    };
    show('flow');

    return startInk({
      canvas,
      frame,
      section: sectionEl,
      anchor,
      caption,
      hash: hashHex,
      phrase: effectPhrase,
      still,
      onPhase: show,
    });
  }, [section, label, still]);

  return (
    <motion.div
      ref={frameRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-[60%]"
      initial={{ opacity: still ? 1 : 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: still ? 0 : 0.9, ease: FADE_EASE }}
    >
      {/* The art zone's canvas stays blank where WebGL2 is missing: the hidden paragraph tells the story. */}
      <canvas ref={canvasRef} className="block size-full" />
      <div
        ref={captionRef}
        className="absolute top-6 right-12 grid max-w-[calc(100%-6rem)] font-mono text-[12px] uppercase tracking-[0.08em] text-muted max-sm:top-4 max-sm:right-5 max-sm:max-w-[calc(100%-2.5rem)]"
      >
        <span
          ref={hashCaption}
          className="text-right opacity-0 transition-opacity duration-300 ease-out [grid-area:1/1] motion-reduce:transition-none"
        >
          Proposal #{proposalId} asks members to sign this
        </span>
        <span
          ref={meaningCaption}
          className="text-right opacity-0 transition-opacity duration-300 ease-out [grid-area:1/1] motion-reduce:transition-none"
        >
          What it does, read by Kaap
        </span>
      </div>
    </motion.div>
  );
}
