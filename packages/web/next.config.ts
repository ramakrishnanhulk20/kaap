import type { NextConfig } from 'next';

const config: NextConfig = {
  // A check build sets NEXT_DIST_DIR so it never writes into the folder the dev server is using.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  // The check route loads the engine folder by path at run time, so the build cannot see that it
  // is needed. This puts it beside the route on a host that ships each route by itself.
  outputFileTracingIncludes: { '/api/check': ['./engine/**/*'] },
};

export default config;
