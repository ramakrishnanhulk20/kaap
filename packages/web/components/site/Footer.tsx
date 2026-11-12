import Link from 'next/link';
import { REPO } from '@/lib/links';

export default function Footer() {
  return (
    <footer className="toy-footer">
      <div className="toy-footer-inner">
        <span className="toy-footer-name">
          <b>காப்பு</b> kaappu, a thread tied for protection
        </span>
        <span className="toy-footer-links">
          <Link href="/check">Check a treasury</Link>
          <Link href="/docs">Docs</Link>
          <a href={REPO}>Code on GitHub</a>
          <span>Built for NEAR treasuries. Open source, MIT licence.</span>
        </span>
      </div>
    </footer>
  );
}
