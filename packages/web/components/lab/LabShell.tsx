'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useSearchParams } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import HeroD from './HeroD';
import HeroE from './HeroE';
import PageF from './PageF';
import ThemeToggle from './ThemeToggle';

const DIRECTIONS = [
  { id: 'f', label: 'F  Watchman', Hero: PageF },
  { id: 'e', label: 'E  Kaappu', Hero: HeroE },
  { id: 'd', label: 'D  Ink', Hero: HeroD },
] as const;

type DirectionId = (typeof DIRECTIONS)[number]['id'];

const STILL = '(prefers-reduced-motion: reduce)';

// Read straight from the browser: framer-motion's own hook prints a console warning for every
// visitor who has reduced motion on.
function useStill() {
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

export default function LabShell() {
  const asked = useSearchParams().get('d');
  const chosen: DirectionId = DIRECTIONS.some((direction) => direction.id === asked) ? (asked as DirectionId) : 'f';
  const still = useStill();
  const { Hero } = DIRECTIONS.find((direction) => direction.id === chosen)!;

  // The tab lives in the URL so a link opens one direction. Replacing the entry keeps the back
  // button from stepping through every tab press.
  const choose = (id: DirectionId) => {
    window.history.replaceState(null, '', `?d=${id}`);
  };

  return (
    <div data-direction={chosen} className="min-h-svh bg-bg text-ink [--bar:101px] sm:[--bar:56px]">
      <header className="fixed inset-x-0 top-0 z-40 grid grid-cols-[1fr_auto] items-center border-b border-line bg-bg/80 backdrop-blur-[12px] max-sm:grid-rows-[56px_44px] sm:h-14 sm:grid-cols-[1fr_auto_1fr]">
        <span className="px-4 font-mono text-[12px] tracking-[0.2em] text-muted max-sm:col-start-1 max-sm:row-start-1 sm:px-6">
          KAAP LAB
        </span>
        <div
          role="tablist"
          aria-label="Hero direction"
          className="grid h-full grid-cols-3 max-sm:col-span-2 max-sm:row-start-2 sm:flex"
        >
          {DIRECTIONS.map(({ id, label }) => {
            const active = id === chosen;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => choose(id)}
                className={`relative h-full whitespace-pre px-4 font-mono text-[13px] max-sm:px-0 max-sm:text-[11px] transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  active ? 'text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:bg-accent' : 'text-muted'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <ThemeToggle className="mr-4 justify-self-end max-sm:col-start-2 max-sm:row-start-1 sm:mr-6" />
      </header>

      <main className="grid pt-[var(--bar)]">
        <AnimatePresence initial={false}>
          <motion.div
            key={chosen}
            data-direction={chosen}
            className="bg-bg text-ink [grid-area:1/1]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: still ? 0 : 0.25, ease: 'easeInOut' }}
          >
            <Hero />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
