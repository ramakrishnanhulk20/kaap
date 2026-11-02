// Records the live answers the CLI tests replay: runs each command below against the real
// providers and writes every exchange to test/fixtures/<name>.json. Read only, like the CLI. Run it
// after `npm run build -w packages/cli` with `node packages/cli/dist/tools/record-fixtures.js
// [name ...]`; with no names it records them all.

import { mkdirSync, writeFileSync } from 'node:fs';

import { main, realEnv } from '../src/main.js';
import { fetchTransport, type Transport } from '../src/net.js';
import { compact, type Exchange, FIXTURES, type Fixture } from '../test/replay.js';

export const CASES: Record<string, string[]> = {
  'check-survival-132': ['check', 'survival-is-near.sputnik-dao.near', '132', '--network', 'mainnet'],
  'check-kmxv7-13': ['check', 'kmxv7.sputnik-dao.near', '13', '--network', 'mainnet'],
  'check-testnet-7': ['check', 'kaap-dao-1029064008.testnet', '7', '--network', 'testnet'],
  'check-wrap-near': ['check', 'wrap.near', '1'],
  'census-sample-5': ['census', '--sample', '5'],
};

const wanted = process.argv.slice(2);
mkdirSync(FIXTURES, { recursive: true });
for (const [name, argv] of Object.entries(CASES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const exchanges: Exchange[] = [];
  const recording: Transport = async (request) => {
    const response = await fetchTransport(request);
    exchanges.push({ url: request.url, method: request.method, body: request.body ?? null, status: response.status, text: compact(response.text) });
    return response;
  };
  const out: string[] = [];
  const exit = await main(argv, { ...realEnv(), transport: recording }, { out: (t) => out.push(t), err: (t) => out.push(t) });
  const fixture: Fixture = { argv, recorded_at: new Date().toISOString(), exit, exchanges };
  // Every character outside ASCII is written as a JSON \u escape: the same text once parsed, and the
  // file stays plain ASCII whatever a DAO or a provider wrote.
  const ascii = JSON.stringify(fixture, null, 1).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  writeFileSync(`${FIXTURES}${name}.json`, `${ascii}\n`);
  process.stdout.write(`${name}: exit ${exit}, ${exchanges.length} exchanges\n${out.join('\n')}\n\n`);
}
