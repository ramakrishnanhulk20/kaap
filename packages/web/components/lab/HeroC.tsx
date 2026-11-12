'use client';

import { motion } from 'framer-motion';
import { useRef } from 'react';
import { Truth, Wall } from './c/Layers';
import ReadingPanel from './c/ReadingPanel';
import Rim from './c/Rim';
import styles from './c/lens.module.css';
import { useLens } from './c/useLens';
import { useStill } from './c/useStill';

const RISE_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// The content block has no position, opacity or transform of its own, so its children take part in
// the section's stacking order: the title and body sit under the lens, the buttons and the panel sit over it.
export default function HeroC() {
  const sectionRef = useRef<HTMLElement>(null);
  const still = useStill();
  useLens(sectionRef, still);

  const rise = (position: number) => ({
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.6, ease: RISE_EASE, delay: 0.1 + position * 0.09 },
  });

  return (
    <section ref={sectionRef} className={styles.lens}>
      <Wall />
      <div className={styles.scrim} aria-hidden="true" />
      <Truth />
      <Rim />
      <div className="max-w-[60%] p-12 max-sm:max-w-full max-sm:p-5">
        <motion.h1
          {...rise(0)}
          className={`${styles.title} relative z-[1] font-grotesk font-extrabold uppercase text-ink`}
        >
          Read before you sign.
        </motion.h1>
        <motion.p
          {...rise(1)}
          className="relative z-[1] mt-5 max-w-[44ch] font-body text-[18px] leading-[1.5] text-muted"
        >
          NEAR treasuries approve payments that show only a hash. Kaap reads each one inside sealed hardware, tells
          members in plain words what it will do, and vetoes the theft. It can reject. It can never approve or move a
          cent.
        </motion.p>
        <motion.div
          {...rise(2)}
          className="relative z-[4] mt-6 flex items-center gap-4 max-sm:flex-col max-sm:items-stretch"
        >
          <button
            type="button"
            data-shrink
            className="cursor-pointer rounded-lg bg-accent px-[22px] py-[14px] font-body text-[16px] font-semibold text-bg transition-colors duration-150 ease-out hover:bg-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:h-12 max-sm:py-0"
          >
            Check a treasury
          </button>
          <button
            type="button"
            data-shrink
            className="group cursor-pointer font-body text-[16px] font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:h-12"
          >
            <span className="relative inline-block">
              Watch a theft get stopped
              <span className="absolute inset-x-0 -bottom-[2px] h-[2px] origin-left scale-x-0 bg-accent transition-transform duration-200 ease-out group-hover:scale-x-100" />
            </span>
          </button>
        </motion.div>
        <ReadingPanel still={still} />
      </div>
    </section>
  );
}
