'use client';

import { motion } from 'framer-motion';
import { description, effectPhrase, hashHex, proposalId, sentence, withoutText, withText } from '@/lib/hashProposal';
import { useStill } from '@/lib/useStill';
import './reading.css';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SEEN = { once: true, amount: 0.35 } as const;

function Lantern() {
  return (
    <svg className="toy-between-lantern" viewBox="0 0 64 96" aria-hidden="true">
      <circle cx="32" cy="9" r="6" fill="none" stroke="#c9942e" strokeWidth="3.4" />
      <path d="M22 26 L27 16 H37 L42 26 Z" fill="#c9942e" />
      <path d="M21 26 Q11 48 22 70 H42 Q53 48 43 26 Z" fill="#ffd45e" />
      <path d="M26 30 Q19 48 27 66 H37 Q45 48 38 30 Z" fill="#fff3c2" />
      <path d="M21 26 Q11 48 22 70 M43 26 Q53 48 42 70" fill="none" stroke="#c9942e" strokeWidth="2.6" />
      <path d="M19 70 H45 L48 82 H16 Z" fill="#c9942e" />
      <rect x="14" y="82" width="36" height="6" rx="3" fill="#a77a22" />
    </svg>
  );
}

/**
 * The same proposal twice: as the treasury's members are shown it, and as Kaap reads it once it
 * is given the text behind the hash. Every value comes from the saved testnet proposal.
 */
export default function Reading() {
  const still = useStill();
  const hashLines = [hashHex.slice(0, 32), hashHex.slice(32)];

  const enter = (delay: number, from: { x?: number; y?: number }) => ({
    initial: still ? (false as const) : { opacity: 0, ...from },
    whileInView: { opacity: 1, x: 0, y: 0 },
    viewport: SEEN,
    transition: { duration: 0.7, ease: EASE, delay },
  });

  return (
    <section className="toy-reading">
      <div className="toy-reading-inner">
        <motion.p {...enter(0, { y: 18 })} className="toy-label">
          The problem
        </motion.p>
        <motion.h2 {...enter(0.06, { y: 18 })} className="toy-reading-title">
          A treasury signs what it cannot read.
        </motion.h2>
        <motion.p {...enter(0.12, { y: 18 })} className="toy-reading-lede">
          A NEAR treasury can be asked to approve a signature over a hash. The words behind the hash are not on the
          page members vote on. This one is real: proposal #{proposalId} on testnet.
        </motion.p>

        <div className="toy-pair">
          <motion.article {...enter(0.1, { x: -28 })} className="toy-sheet toy-sheet--sealed">
            <div className="toy-sheet-body">
              <p className="toy-sheet-label">What members see</p>
              <p className="toy-sheet-words">&ldquo;{description}&rdquo;</p>
              <p className="toy-sheet-small">It asks the treasury to sign this:</p>
              <p className="toy-sheet-code">
                {hashLines[0]}
                <wbr />
                {hashLines[1]}
              </p>
              <p className="toy-sheet-foot">
                <span className="toy-wax" aria-hidden="true" />
                <span>
                  Shown only this, Kaap rates it <b>{withoutText.riskFloor}</b> and says it cannot be read.
                </span>
              </p>
            </div>
          </motion.article>

          <div className="toy-between" aria-hidden="true">
            <motion.span
              className="toy-between-thread"
              initial={still ? false : { scaleX: 0, scaleY: 0 }}
              whileInView={{ scaleX: 1, scaleY: 1 }}
              viewport={SEEN}
              transition={{ duration: 0.6, ease: EASE, delay: 0.45 }}
            />
            <motion.span
              initial={still ? false : { opacity: 0, rotate: -16 }}
              whileInView={{ opacity: 1, rotate: 0 }}
              viewport={SEEN}
              transition={{ duration: 0.9, ease: EASE, delay: 0.7 }}
              style={{ transformOrigin: '50% 0%' }}
            >
              <Lantern />
            </motion.span>
          </div>

          <motion.article {...enter(0.2, { x: 28 })} className="toy-sheet toy-sheet--read">
            <div className="toy-sheet-body">
              <motion.span
                className="toy-sheet-light"
                aria-hidden="true"
                initial={still ? false : { opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={SEEN}
                transition={{ duration: 1.1, ease: 'easeOut', delay: 1.0 }}
              />
              <p className="toy-sheet-label">What Kaap reads behind the hash</p>
              <motion.p
                className="toy-sheet-words"
                initial={still ? false : { opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={SEEN}
                transition={{ duration: 0.8, ease: 'easeOut', delay: 1.25 }}
              >
                {effectPhrase}.
              </motion.p>
              <motion.p
                className="toy-sheet-code"
                initial={still ? false : { opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={SEEN}
                transition={{ duration: 0.8, ease: 'easeOut', delay: 1.4 }}
              >
                {sentence}
              </motion.p>
              <motion.p
                className="toy-sheet-foot"
                initial={still ? false : { opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={SEEN}
                transition={{ duration: 0.8, ease: 'easeOut', delay: 1.6 }}
              >
                <span className="toy-verdict">{withText.riskFloor}</span>
                <span>{withText.mustVeto ? <b>The guard must veto this.</b> : 'The guard leaves this to the members.'}</span>
              </motion.p>
            </div>
          </motion.article>
        </div>
      </div>
    </section>
  );
}
