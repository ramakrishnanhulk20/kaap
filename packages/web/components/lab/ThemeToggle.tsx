'use client';

import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

// The button names the theme a press switches to. The page itself is set before paint by the
// inline script in app/layout.tsx; this reads that result once after mount.
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  }, []);

  const press = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('kaap-theme', next);
    } catch {}
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={press}
      aria-label={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className={`size-9 rounded-lg border border-line font-mono text-[12px] text-ink transition-colors duration-150 ease-out hover:border-ink focus-visible:outline-2 focus-visible:outline-accent max-sm:size-11 ${className}`}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
