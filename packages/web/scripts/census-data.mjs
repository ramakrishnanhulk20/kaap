// Runs the DAO census the command line runs (`kaap census`) and saves its report as
// data/census.json, so the numbers the site shows about NEAR's treasuries are a saved answer from
// mainnet and none is typed by hand.
//
//   npm run data:census              every DAO the Sputnik factory made (a long run)
//   npm run data:census -- 500       a fixed sample of 500, the same DAOs on every run
//
// Needs the command line built (npm run build -w packages/cli). Read-only calls to NEAR mainnet,
// at most five a second, no key.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = (file) => import(pathToFileURL(fileURLToPath(new URL(`../../cli/dist/src/${file}`, import.meta.url))).href);
const [{ census, render }, { Core }, { fetchTransport }, { RateLimiter, realClock }, { REQUESTS_PER_SECOND }] = await Promise.all(
  ['census.js', 'core.js', 'net.js', 'limiter.js', 'caps.js'].map(cli),
);

const asked = process.argv[2];
const sample = asked === undefined ? null : Number(asked);
if (sample !== null && (!Number.isSafeInteger(sample) || sample < 1)) throw new Error('the sample size is a whole number of DAOs');

const report = await census(
  { core: await Core.load(), transport: fetchTransport, limiter: new RateLimiter(REQUESTS_PER_SECOND, realClock), clock: realClock },
  sample,
);

const out = new URL('../data/census.json', import.meta.url);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      source: 'Written by packages/web/scripts/census-data.mjs from a live read of NEAR mainnet. Do not edit by hand.',
      rerun: `node packages/cli/dist/src/bin.js census${sample === null ? '' : ` --sample ${sample}`}`,
      report,
    },
    null,
    2,
  )}\n`,
);
console.log(render(report));
console.log(`\nwrote ${fileURLToPath(out)}`);
