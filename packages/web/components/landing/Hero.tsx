'use client';

import { motion, useScroll, useTransform } from 'framer-motion';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import Nav from '@/components/site/Nav';
import { description, effectPhrase, proposalId } from '@/lib/hashProposal';
import { STOPPED_THEFT } from '@/lib/links';
import { useStill } from '@/lib/useStill';
import Film from './Film';
import './hero.css';

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

// The first screen comes in with plain CSS, in the order given here, so it shows before any
// script has run.
const order = (position: number) => ({ '--i': position }) as CSSProperties;

export default function Hero() {
  const still = useStill();
  const { scrollY } = useScroll();
  const drift = useTransform(scrollY, [0, 600], [0, 36]);
  // The engine's phrase starts a sentence; here it ends one.
  const reading = effectPhrase.charAt(0).toLowerCase() + effectPhrase.slice(1);

  return (
    <section id="top" className="toy-hero">
      <Nav onHome />
      <motion.div className="toy-film" style={still ? undefined : { y: drift }}>
        <Film />
      </motion.div>

      <div className="toy-words">
        <div>
          <p className="toy-label toy-rise" style={order(0)}>
            A guard for NEAR treasuries
          </p>
          <h1 className="toy-title toy-rise" style={order(1)}>
            <span className="toy-tied">
              Stops a theft.
              <Thread />
            </span>
            <br />
            Can&apos;t make one.
          </h1>
          <p className="toy-name toy-rise" style={order(2)}>
            <span className="toy-name-tamil">காப்பு</span>
            <span className="toy-name-meaning">kaappu, a thread tied for protection</span>
          </p>
        </div>

        <div>
          <p className="toy-pitch toy-rise" style={order(3)}>
            NEAR treasuries approve payments that show only a hash. Kaap reads each one, tells members in plain
            words what it will do, and vetoes the theft. It can reject. It can never approve or move a cent.
          </p>
          <div className="toy-actions toy-rise" style={order(4)}>
            <Link className="toy-btn toy-btn--main" href="/check">
              Check a treasury
            </Link>
            <Link className="toy-btn toy-btn--side" href={STOPPED_THEFT}>
              Watch a theft get stopped
            </Link>
          </div>
          <p className="toy-live toy-rise" style={order(5)}>
            <span className="toy-live-dot" aria-hidden="true" />
            <span>
              On testnet, proposal #{proposalId} says &ldquo;{description}&rdquo;. Kaap reads the hash behind it:{' '}
              <b>{reading}</b>.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
