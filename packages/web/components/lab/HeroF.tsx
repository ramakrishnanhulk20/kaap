'use client';

import { motion, useScroll, useTransform } from 'framer-motion';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { description, effectPhrase, proposalId } from '@/lib/labData';
import { useStill } from './d/useStill';
import './f/stage.css';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// One twist of two-ply thread every 14px: each ply is a slanted lozenge.
const TWIST = 14;

function Thread() {
  return (
    <svg className="toy-thread" aria-hidden="true">
      <defs>
        <pattern id="toy-twist" width={TWIST} height="12" patternUnits="userSpaceOnUse">
          <rect width={TWIST} height="12" fill="var(--accent)" />
          <path d="M-3 12 L5 0 M4 12 L12 0 M11 12 L19 0" stroke="rgb(30 26 20 / 0.34)" strokeWidth="1.6" />
        </pattern>
      </defs>
      <rect x="0" y="1" width="100%" height="10" rx="5" fill="url(#toy-twist)" />
    </svg>
  );
}

export default function HeroF() {
  const still = useStill();
  const picture = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const { scrollY } = useScroll();
  const drift = useTransform(scrollY, [0, 600], [0, 36]);
  // The engine's phrase starts a sentence; here it ends one.
  const reading = effectPhrase.charAt(0).toLowerCase() + effectPhrase.slice(1);

  // A picture served from the browser's cache has loaded before React attaches onLoad.
  useEffect(() => {
    if (picture.current?.complete) setLoaded(true);
  }, []);

  const rise = (position: number) => ({
    initial: still ? (false as const) : { opacity: 0, y: 22 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, ease: EASE, delay: 0.25 + position * 0.08 },
  });

  return (
    <section className="toy-hero">
      <motion.div
        className="toy-film"
        style={still ? undefined : { y: drift }}
        initial={still ? false : { opacity: 0, scale: 1.035 }}
        animate={loaded || still ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 1.035 }}
        transition={{ duration: 1.1, ease: EASE }}
      >
        <Image
          src="/world/watchman.jpg"
          alt="A set of painted wooden toys. Three treasury members bring sealed letters to a striped round treasury. A watchman with a big moustache holds one letter up to his lantern, and the light shows a key hidden inside it. A yellow thread is tied around the treasury and knotted across its door."
          width={3000}
          height={1500}
          priority
          ref={picture}
          onLoad={() => setLoaded(true)}
          sizes="(max-width: 859px) 170vw, 100vw"
        />
        <span className="toy-lamp" aria-hidden="true" />
      </motion.div>

      <div className="toy-words">
        <div>
          <motion.p {...rise(0)} className="toy-label">
            A guard for NEAR treasuries
          </motion.p>
          <motion.h1 {...rise(1)} className="toy-title">
            <span className="toy-tied">
              Stops a theft.
              <motion.span
                className="absolute inset-0"
                aria-hidden="true"
                initial={still ? false : { clipPath: 'inset(0% 100% -30% 0%)' }}
                animate={{ clipPath: 'inset(0% 0% -30% 0%)' }}
                transition={{ duration: 0.8, delay: 0.85, ease: 'easeOut' }}
              >
                <Thread />
              </motion.span>
            </span>
            <br />
            Can&apos;t make one.
          </motion.h1>
          <motion.p {...rise(2)} className="toy-name">
            <span className="toy-name-tamil">காப்பு</span>
            <span className="toy-name-meaning">kaappu, a thread tied for protection</span>
          </motion.p>
        </div>

        <div>
          <motion.p {...rise(3)} className="toy-pitch">
            NEAR treasuries approve payments that show only a hash. Kaap reads each one, tells members in plain
            words what it will do, and vetoes the theft. It can reject. It can never approve or move a cent.
          </motion.p>
          <motion.div {...rise(4)} className="toy-actions">
            <button type="button" className="toy-btn toy-btn--main">
              Check a treasury
            </button>
            <button type="button" className="toy-btn toy-btn--side">
              Watch a theft get stopped
            </button>
          </motion.div>
          <motion.p {...rise(5)} className="toy-live">
            <span className="toy-live-dot" aria-hidden="true" />
            <span>
              On testnet, proposal #{proposalId} says &ldquo;{description}&rdquo;. Kaap reads the hash behind it:{' '}
              <b>{reading}</b>.
            </span>
          </motion.p>
        </div>
      </div>
    </section>
  );
}
