import Link from 'next/link';
import { STOPPED_THEFT } from '@/lib/links';
import './closing.css';

export default function Closing() {
  return (
    <section className="toy-closing">
      <h2 className="toy-closing-title">Put a watchman at your treasury&apos;s door.</h2>
      <p className="toy-closing-text">
        Enrolling is one ordinary vote of your own DAO. So is leaving. Until then, you can check any request on any
        NEAR treasury without a wallet.
      </p>
      <div className="toy-actions">
        <Link className="toy-btn toy-btn--main" href="/check">
          Check a treasury
        </Link>
        <Link className="toy-btn toy-btn--side" href={STOPPED_THEFT}>
          Watch a theft get stopped
        </Link>
      </div>
    </section>
  );
}
