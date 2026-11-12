import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // A check build sets NEXT_DIST_DIR so it never writes into the folder the dev server is using.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  // The check route loads the engine folder by path at run time, so the build cannot see that it
  // is needed. This puts it beside the route on a host that ships each route by itself.
  outputFileTracingIncludes: { '/api/check': ['./engine/**/*'] },
};

// Fumadocs reads content/docs and writes the .source folder the docs route imports. It keeps
// every setting above and only adds the loaders for .mdx files.
const withMDX = createMDX();

export default withMDX(config);
