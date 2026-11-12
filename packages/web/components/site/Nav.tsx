import Link from 'next/link';

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

/** The bar at the top of every page. `onHome` is true on the landing page, whose sections its
 *  first two links jump to; elsewhere they lead back there. */
export default function Nav({ onHome = false }: { onHome?: boolean }) {
  const home = onHome ? '' : '/';
  return (
    <nav className="toy-nav" aria-label="Main">
      <Link className="toy-brand" href="/">
        <Mark />
        Kaap
      </Link>
      <div className="toy-nav-links">
        <a className="toy-nav-link toy-nav-link--wide" href={`${home}#how-it-works`}>
          How it works
        </a>
        <a className="toy-nav-link toy-nav-link--wide" href={`${home}#live`}>
          What is live
        </a>
        <Link className="toy-nav-link" href="/docs">
          Docs
        </Link>
        <Link className="toy-btn toy-btn--main toy-btn--small" href="/check">
          Check a treasury
        </Link>
      </div>
    </nav>
  );
}
