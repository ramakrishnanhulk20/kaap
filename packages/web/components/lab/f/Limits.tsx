'use client';

import { motion } from 'framer-motion';
import { useStill } from '../d/useStill';
import './limits.css';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SEEN = { once: true, amount: 0.3 } as const;

// Each of these is a property of the guard contract or of the role a treasury gives it, not a
// promise about how Kaap behaves.
const LIMITS = [
  {
    rest: 'approve anything.',
    text: 'The role a treasury gives the guard carries one permission: vote to reject. There is no yes for it to cast.',
  },
  {
    rest: 'move a cent.',
    text: 'It holds no funds and no key to yours. It cannot file a request, pay, or change who decides.',
  },
  {
    rest: 'block its own removal.',
    text: 'Its role leaves out the one kind of request that takes a member off a role. One ordinary vote of yours removes it.',
  },
  {
    rest: 'be rewritten.',
    text: 'No key is left on the contract and it has no upgrade method. A new version is a new contract that you choose to adopt.',
  },
] as const;

/** What the guard is unable to do, by how it is built. */
export default function Limits() {
  const still = useStill();

  return (
    <section id="limits" className="toy-limits">
      <div className="toy-limits-inner">
        <p className="toy-label">By design</p>
        <h2 className="toy-limits-title">What Kaap cannot do.</h2>

        <ul className="toy-limits-grid">
          {LIMITS.map((limit, index) => (
            <motion.li
              key={limit.rest}
              className="toy-limit"
              initial={still ? false : { opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={SEEN}
              transition={{ duration: 0.6, ease: EASE, delay: (index % 2) * 0.1 }}
            >
              <h3 className="toy-limit-title">
                It <span className="toy-limit-cannot">cannot</span> {limit.rest}
              </h3>
              <p className="toy-limit-text">{limit.text}</p>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}
