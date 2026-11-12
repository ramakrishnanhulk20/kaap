import type { NextConfig } from 'next';

const config: NextConfig = {
  // A check build sets NEXT_DIST_DIR so it never writes into the folder the dev server is using.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
};

export default config;
