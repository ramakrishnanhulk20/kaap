'use client';

import { motion } from 'framer-motion';
import { useEffect, useRef, type RefObject } from 'react';
import { effectPhrase, hashHex, proposalId } from '@/lib/labData';
import { startInk, type Phase } from './ink';

const FADE_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

interface Props {
  section: RefObject<HTMLElement | null>;
  still: boolean;
}

// The ink and its caption. The loop drives the caption by setting opacity directly, so React never
// re-renders while the ink moves.
export default function InkCanvas({ section, still }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hashCaption = useRef<HTMLSpanElement>(null);
  const meaningCaption = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const listenOn = section.current;
    if (!canvas || !listenOn) return;

    const show = (phase: Phase) => {
      if (hashCaption.current) hashCaption.current.style.opacity = phase === 'hash' ? '1' : '0';
      if (meaningCaption.current) meaningCaption.current.style.opacity = phase === 'meaning' ? '1' : '0';
    };
    show('flow');

    return startInk({ canvas, listenOn, hash: hashHex, phrase: effectPhrase, still, onPhase: show });
  }, [section, still]);

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-[72%] max-sm:h-[300px]"
      initial={{ opacity: still ? 1 : 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: still ? 0 : 0.9, ease: FADE_EASE }}
    >
      <canvas ref={canvasRef} className="block size-full" />
      <div className="absolute right-12 bottom-4 grid max-w-[calc(100%-4rem)] font-mono text-[12px] uppercase tracking-[0.08em] text-muted">
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
