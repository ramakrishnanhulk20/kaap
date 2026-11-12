'use client';

import { motion } from 'framer-motion';
import { useRef, type CSSProperties } from 'react';
import { description, proposalId, sentence, withText } from '@/lib/labData';
import InkCanvas from './d/InkCanvas';
import { useStill } from './d/useStill';

const RISE_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const BUTTON =
  'inline-flex h-11 cursor-pointer items-center justify-center rounded-full border px-5 font-body text-[14px] font-medium transition-[background-color,color,border-color,translate] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:h-12';

export default function HeroD() {
  const sectionRef = useRef<HTMLElement>(null);
  const still = useStill();

  const rise = (position: number) => ({
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.6, ease: RISE_EASE, delay: 0.1 + position * 0.08 },
  });

  return (
    <section
      ref={sectionRef}
      style={{ '--hero-h': 'max(calc(100svh - var(--bar, 56px)), 720px)' } as CSSProperties}
      className="relative min-h-[var(--hero-h)] overflow-hidden bg-bg text-ink"
    >
      <InkCanvas section={sectionRef} still={still} />

      <p className="sr-only">
        Proposal #{proposalId} says &quot;{description}&quot;. It asks members to sign a hash. Kaap reads the text behind
        it: {sentence} Verdict: {withText.riskFloor}.
      </p>

      <div className="relative mx-auto max-w-[1100px] px-6 pt-[calc(var(--hero-h)_*_0.46)] pb-14 max-sm:px-5 max-sm:pt-[300px]">
        <motion.p
          {...rise(0)}
          className="flex items-baseline gap-[10px] font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-muted"
        >
          <span aria-hidden="true" className="size-2 shrink-0 bg-accent" />
          NEAR TREASURIES · SPUTNIK DAO · A GUARD THAT CAN ONLY SAY NO
        </motion.p>

        <h1 className="mt-[18px] font-grotesk text-[clamp(2.75rem,7.6vw,6.85rem)] font-bold uppercase leading-[0.96] tracking-[-0.025em] text-ink">
          <motion.span {...rise(1)} className="block">
            Stops a theft.
          </motion.span>
          <motion.span {...rise(2)} className="block">
            Can&apos;t make one.
          </motion.span>
        </h1>

        <motion.div {...rise(3)} className="relative mt-[22px] flex items-baseline gap-3">
          <span className="font-grotesk text-[20px] font-bold text-ink">Kaap</span>
          <span lang="ta" className="font-tamil text-[18px] font-semibold text-accent">
            காப்பு
          </span>
          <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">protection, on NEAR</span>
          <span
            aria-hidden="true"
            className="absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted [writing-mode:vertical-rl] max-sm:hidden"
          >
            Scroll
            <svg width="10" height="14" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.25">
              <path d="M5 0v13M1 9l4 4 4-4" />
            </svg>
          </span>
        </motion.div>

        <motion.div
          {...rise(4)}
          className="mx-auto mt-14 max-w-[560px] text-center font-body text-[16.5px] leading-[1.6] text-muted max-sm:mx-0 max-sm:max-w-none max-sm:text-left"
        >
          <p>
            NEAR treasuries approve payments that show only a hash. Kaap reads each one, tells members in plain words
            what it will do, and vetoes the theft.
          </p>
          <p className="mt-3">
            Underneath: a guard contract that can only reject, a rules engine anyone can run, and verdicts signed inside
            sealed hardware.
          </p>
        </motion.div>

        <motion.div
          {...rise(5)}
          className="mt-6 flex flex-wrap justify-center gap-[10px] max-sm:flex-col max-sm:items-stretch"
        >
          <button
            type="button"
            className={`${BUTTON} border-transparent bg-ink text-bg hover:-translate-y-px hover:bg-accent hover:text-[#111111]`}
          >
            Check a treasury
          </button>
          <button
            type="button"
            className={`${BUTTON} border-ink/35 bg-transparent text-ink hover:border-ink hover:bg-ink/6`}
          >
            Watch a theft get stopped
          </button>
          <button
            type="button"
            className={`${BUTTON} border-ink/35 bg-transparent text-ink hover:border-ink hover:bg-ink/6`}
          >
            Read the code
          </button>
        </motion.div>
      </div>
    </section>
  );
}
