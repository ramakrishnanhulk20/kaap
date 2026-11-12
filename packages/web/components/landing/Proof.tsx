'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import proof from '@/data/proof.json';
import { accountLink as account, transactionLink as transaction } from '@/lib/links';
import { useStill } from '@/lib/useStill';
import './proof.css';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SEEN = { once: true, amount: 0.2 } as const;


interface Row {
  what: string;
  live: boolean;
  proof: ReactNode;
  link?: { href: string; text: string };
}

// A contract with no access key left cannot be changed by anyone, its deployer included.
const locked = (keysLeft: number) =>
  keysLeft === 0 ? 'No key is left on the account, so nobody can change the code.' : `${keysLeft} access keys are still on the account.`;

const { guard, registry, treasury, sealed, stopped, evaluation } = proof;

const ROWS: Row[] = [
  {
    what: 'The guard',
    live: true,
    proof: <>The contract that casts the reject vote. {locked(guard.accessKeysLeft)}</>,
    link: { href: account(guard.account), text: guard.account },
  },
  {
    what: 'The registry',
    live: true,
    proof: <>The public record of every verdict Kaap has signed. Anyone can read one and check its signature. {locked(registry.accessKeysLeft)}</>,
    link: { href: account(registry.account), text: registry.account },
  },
  {
    what: 'A demo treasury',
    live: true,
    proof: (
      <>
        A Sputnik DAO with {treasury.policyFrom.replace(/, read .*$/, '')}.{' '}
        {treasury.enrolled ? 'It enrolled the guard by its own vote.' : 'It has not enrolled the guard.'}
      </>
    ),
    link: { href: account(treasury.account), text: treasury.account },
  },
  {
    what: 'The sealed reader',
    live: true,
    proof: <>Reads each request inside sealed hardware on OutLayer and signs its verdict there. Every run leaves an attestation.</>,
    link: { href: sealed.attestationUrl, text: 'attestation of a run' },
  },
  {
    what: 'A theft, stopped',
    live: true,
    proof: (
      <>
        Request #{stopped.proposalId} on the demo treasury said &ldquo;{stopped.said}&rdquo; and paid the lookalike account{' '}
        {stopped.paid} The guard&apos;s reject landed <b>{stopped.seconds} seconds</b> after it was filed.
      </>
    ),
    link: { href: transaction(stopped.vetoTx), text: "the guard's vote" },
  },
  {
    what: 'The evaluation',
    live: true,
    proof: (
      <>
        On {evaluation.records} test proposals the guard would veto{' '}
        <b>
          {evaluation.caught.withAi} of {evaluation.caught.total}
        </b>{' '}
        that should be vetoed, and{' '}
        <b>
          {evaluation.wronglyVetoed.withAi} of {evaluation.wronglyVetoed.total}
        </b>{' '}
        that should not. The misses are listed in the report.
      </>
    ),
  },
  {
    what: 'The always-on watcher',
    live: false,
    proof: <>Built and tested, but not hosted yet. In the stopped theft above, a script played its part.</>,
  },
  {
    what: 'Mainnet',
    live: false,
    proof: <>Kaap reads any mainnet treasury today. Its guard votes only on {proof.network} so far.</>,
  },
];

/** What exists today and where to check it, from the deploy record and the evaluation report. */
export default function Proof() {
  const still = useStill();

  return (
    <section id="live" className="toy-proof">
      <div className="toy-proof-inner">
        <p className="toy-label">What is live</p>
        <h2 className="toy-proof-title">Check every line yourself.</h2>
        <p className="toy-proof-lede">
          Nothing on this page is a mock-up. Each line says what is running on NEAR {proof.network} now, where to look
          it up, and what is not there yet.
        </p>

        <div className="toy-ledger" role="table" aria-label="What is live">
          <div className="toy-ledger-row toy-ledger-head" role="row">
            <span role="columnheader">What</span>
            <span role="columnheader">State</span>
            <span role="columnheader">Where to check</span>
          </div>
          {ROWS.map((row, index) => (
            <motion.div
              key={row.what}
              className="toy-ledger-row"
              role="row"
              initial={still ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={SEEN}
              transition={{ duration: 0.55, ease: EASE, delay: index * 0.07 }}
            >
              <span className="toy-ledger-what" role="cell">
                {row.what}
              </span>
              <span role="cell">
                <span className={`toy-ledger-state${row.live ? '' : ' toy-ledger-state--not'}`}>
                  {row.live ? 'Live' : 'Not yet'}
                </span>
              </span>
              <span className="toy-ledger-proof" role="cell">
                {row.proof}
                {row.link ? (
                  <>
                    <br />
                    <a className="toy-ledger-link" href={row.link.href} target="_blank" rel="noreferrer">
                      {row.link.text}
                    </a>
                  </>
                ) : null}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
