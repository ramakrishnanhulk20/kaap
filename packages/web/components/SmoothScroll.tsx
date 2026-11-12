'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

// Lenis runs once for the whole app and is switched off while the visitor asks for reduced motion.
export default function SmoothScroll({ children }: { children: React.ReactNode }) {
  const lenis = useRef<Lenis | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      if (query.matches) {
        lenis.current?.destroy();
        lenis.current = null;
      } else if (!lenis.current) {
        lenis.current = new Lenis({ autoRaf: true });
      }
    };
    sync();
    query.addEventListener('change', sync);
    return () => {
      query.removeEventListener('change', sync);
      lenis.current?.destroy();
      lenis.current = null;
    };
  }, []);

  // A page opened by a client-side link can otherwise land at the old scroll position.
  useEffect(() => {
    lenis.current?.scrollTo(0, { immediate: true });
  }, [pathname]);

  return <>{children}</>;
}
