import { useSyncExternalStore } from 'react';

const STILL = '(prefers-reduced-motion: reduce)';

// Read straight from the browser: framer-motion's own hook prints a console warning for every
// visitor who has reduced motion on.
export function useStill(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(STILL);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(STILL).matches,
    () => false,
  );
}
