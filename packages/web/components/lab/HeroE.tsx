'use client';

import { motion } from 'framer-motion';
import { useRef } from 'react';
import { description, proposalId, sentence, withText } from '@/lib/labData';
import { useStill } from './d/useStill';
import Scene from './e/Scene';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// The text fades in without moving, because the thread is laid out from where the headline sits.
export default function HeroE() {
  const sectionRef = useRef<HTMLElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const still = useStill();

  const fade = (position: number) => ({
    initial: still ? (false as const) : { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.7, ease: EASE, delay: 0.1 + position * 0.09 },
  });

  return (
    <section
      ref={sectionRef}
      className="relative min-h-[max(calc(100svh-var(--bar,56px)),720px)] overflow-hidden bg-bg"
    >
      <p className="sr-only">
        Proposal #{proposalId} says &quot;{description}&quot;. It asks members to sign a hash. Kaap reads the text
        behind it: {sentence} Verdict: {withText.riskFloor}.
      </p>

      <div className="relative z-[2] mx-auto max-w-[1160px] px-6 pt-[clamp(36px,8vh,84px)] pb-14 max-sm:px-5">
        <motion.p {...fade(0)} className="font-mono text-[12px] font-medium uppercase tracking-[0.16em] text-muted">
          A guard for NEAR treasuries
        </motion.p>

        <motion.h1
          {...fade(1)}
          className="mt-4 font-serif text-[clamp(3rem,8.1vw,7.3rem)] font-semibold leading-[1.02] tracking-[-0.022em] text-ink"
        >
          <span ref={lineRef} className="inline-block">
            Stops a theft.
          </span>
          <br />
          Can&apos;t make one.
        </motion.h1>

        <div className="mt-10 grid grid-cols-1 gap-x-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div>
            <motion.p {...fade(2)} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-tamil text-[24px] font-semibold text-ink">காப்பு</span>
              <span className="font-serif text-[18px] italic text-muted">kaappu, a thread tied for protection</span>
            </motion.p>

            <motion.p {...fade(3)} className="mt-5 max-w-[46ch] font-body text-[17px] leading-[1.6] text-muted">
              NEAR treasuries approve payments that show only a hash. Kaap reads each one, tells members in plain
              words what it will do, and vetoes the theft. It can reject. It can never approve or move a cent.
            </motion.p>

            <motion.div {...fade(4)} className="mt-7 flex flex-wrap gap-3 max-sm:flex-col">
              <button
                type="button"
                className="h-[46px] cursor-pointer rounded-lg bg-ink px-5 font-body text-[15px] font-semibold text-bg transition-[background-color,color,transform] duration-150 ease-out hover:-translate-y-px hover:bg-accent hover:text-[#1E1A14] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Check a treasury
              </button>
              <button
                type="button"
                className="h-[46px] cursor-pointer rounded-lg border border-ink/30 px-5 font-body text-[15px] font-semibold text-ink transition-[border-color,background-color] duration-150 ease-out hover:border-ink hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Watch a theft get stopped
              </button>
            </motion.div>
          </div>

          <div ref={artRef} className="h-[470px] max-lg:mt-10 max-sm:h-[520px]" />
        </div>
      </div>

      <Scene section={sectionRef} line={lineRef} art={artRef} still={still} />
    </section>
  );
}
