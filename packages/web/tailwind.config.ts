import type { Config } from 'tailwindcss';

// The values live in app/globals.css. Restart the dev server after editing this file: it does
// not hot reload.
const config: Config = {
  content: ['./app/**/*.{ts,tsx,mdx}', './components/**/*.{ts,tsx}', './content/**/*.mdx'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        line: 'var(--line)',
        accent: 'var(--accent)',
      },
      fontFamily: {
        serif: ['var(--font-serif)', 'serif'],
        grotesk: ['var(--font-grotesk)', 'sans-serif'],
        tamil: ['var(--font-tamil)', 'serif'],
        body: ['var(--font-body)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
    },
  },
};

export default config;
