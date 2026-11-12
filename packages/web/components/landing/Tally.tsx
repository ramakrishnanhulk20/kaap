'use client';

import { animate, motion, useInView } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import census from '@/data/census.json';
import { useStill } from '@/lib/useStill';
import './tally.css';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SEEN = { once: true, amount: 0.6 } as const;

const whole = new Intl.NumberFormat('en-US');
const { report } = census;

// The block's time is in nanoseconds, as NEAR writes it.
const readOn = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
  new Date(Number(report.block.timestamp_ns.slice(0, -6))),
);

const COUNTS = [
  { to: report.sign_requests, suffix: '', says: 'requests in the last year asked a NEAR treasury to sign a hash.' },
  { to: report.sign_approved, suffix: '', says: 'of them were approved.' },
  {
    to: Math.round((100 * report.sign_requests) / report.calls),
    suffix: '%',
    says: 'of the contract calls filed with treasuries were one of these.',
  },
];

function Count({ to, suffix, still }: { to: number; suffix: string; still: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, SEEN);

  // The number is written straight into the page as it climbs, so React renders it once.
  useEffect(() => {
    const node = ref.current;
    if (still || !seen || !node) return;
    const run = animate(0, to, {
      duration: 1.5,
      ease: EASE,
      onUpdate: (value) => {
        node.textContent = `${whole.format(Math.round(value))}${suffix}`;
      },
    });
    return () => run.stop();
  }, [seen, still, to, suffix]);

  return <span ref={ref}>{`${whole.format(to)}${suffix}`}</span>;
}

/**
 * How often NEAR treasuries are asked to sign a hash, from the census the command line runs
 * (`kaap census`), saved by scripts/census-data.mjs. No number here is typed by hand.
 */
export default function Tally() {
  const still = useStill();

  return (
    <div className="toy-tally">
      <motion.p
        className="toy-tally-lead"
        initial={still ? false : { opacity: 0, y: 18 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={SEEN}
        transition={{ duration: 0.7, ease: EASE }}
      >
        And it is not rare.
      </motion.p>

      <div className="toy-tally-row">
        {COUNTS.map((count, index) => (
          <motion.div
            key={count.says}
            className="toy-tally-item"
            initial={still ? false : { opacity: 0, y: 22 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={SEEN}
            transition={{ duration: 0.7, ease: EASE, delay: 0.1 * index }}
          >
            <p className="toy-tally-number">
              <Count to={count.to} suffix={count.suffix} still={still} />
            </p>
            <p className="toy-tally-says">{count.says}</p>
          </motion.div>
        ))}
      </div>

      <p className="toy-tally-source">
        Counted on NEAR mainnet on {readOn}, at block {whole.format(report.block.height)}, across all{' '}
        {whole.format(report.daos)} treasuries the Sputnik DAO factory has made. For such a request the chain holds
        the hash and not the words.
        {report.unreadable > 0
          ? ` ${whole.format(report.unreadable)} treasuries could not be read in full, so the true counts are at least these.`
          : ''}{' '}
        <Link href="/docs/getting-started/command-line">Count them yourself</Link> with <code>kaap census</code>.
      </p>
    </div>
  );
}
