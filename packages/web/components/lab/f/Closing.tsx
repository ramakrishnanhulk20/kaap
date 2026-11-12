import proof from '@/data/proof.json';
import './closing.css';

const STOPPED_THEFT = `/check?dao=${proof.treasury.account}&network=${proof.network}&id=${proof.stopped.proposalId}`;

/** Kaap's mark: the bow the thread ties across the treasury door. */
export function Mark() {
  return (
    <svg className="toy-mark" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <g stroke="var(--accent)" strokeWidth="3.1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 12.5 C9.5 4.5 2.5 6 3.5 12 C4.3 16.6 10.5 15.8 14 12.5 Z" />
        <path d="M14 12.5 C18.5 4.5 25.5 6 24.5 12 C23.7 16.6 17.5 15.8 14 12.5 Z" />
        <path className="toy-mark-tail" d="M13.4 14 C12 18 10.2 21.4 8.2 24.6" />
        <path className="toy-mark-tail" d="M14.6 14 C16 18 17.8 21.4 19.8 24.6" />
      </g>
      <circle cx="14" cy="12.8" r="3.3" fill="var(--accent)" stroke="var(--ink)" strokeWidth="1.3" />
    </svg>
  );
}

/** `home` is where the landing page lives, for pages other than it: its links then lead back there. */
export function Nav({ home = '' }: { home?: string }) {
  return (
    <nav className="toy-nav" aria-label="Main">
      <a className="toy-brand" href={`${home}#top`}>
        <Mark />
        Kaap
      </a>
      <div className="toy-nav-links">
        <a className="toy-nav-link toy-nav-link--wide" href={`${home}#how-it-works`}>
          How it works
        </a>
        <a className="toy-nav-link toy-nav-link--wide" href={`${home}#limits`}>
          What it cannot do
        </a>
        <a className="toy-nav-link" href={`${home}#live`}>
          What is live
        </a>
      </div>
    </nav>
  );
}

export default function Closing() {
  return (
    <>
      <section className="toy-closing">
        <h2 className="toy-closing-title">Put a watchman at your treasury&apos;s door.</h2>
        <p className="toy-closing-text">
          Enrolling is one ordinary vote of your own DAO. So is leaving. Until then, you can check any request on any
          NEAR treasury without a wallet.
        </p>
        <div className="toy-actions">
          <a className="toy-btn toy-btn--main" href="/check">
            Check a treasury
          </a>
          <a className="toy-btn toy-btn--side" href={STOPPED_THEFT}>
            Watch a theft get stopped
          </a>
        </div>
      </section>
      <footer className="toy-footer">
        <div className="toy-footer-inner">
          <span className="toy-footer-name">
            <b>காப்பு</b> kaappu, a thread tied for protection
          </span>
          <span>Built for NEAR treasuries. Open source under the MIT licence.</span>
        </div>
      </footer>
    </>
  );
}
