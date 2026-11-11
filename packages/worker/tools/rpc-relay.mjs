#!/usr/bin/env node
// A local stand-in for one RPC provider. It passes each JSON-RPC request through to a real
// provider and returns that provider's answer, until it is stopped. Stopping it is how the live
// run shows what the worker does when one of its two providers goes quiet: "guard degraded" on
// GET /status within 30 seconds.
//
// It speaks HTTPS because the worker accepts only https providers, so it needs a certificate for
// the name the worker is given, and the worker must trust it (NODE_EXTRA_CA_CERTS). Testnet only.
//   node packages/worker/tools/rpc-relay.mjs --upstream https://near-testnet.drpc.org \
//     --port 8443 --cert relay-cert.pem --key relay-key.pem
// The worker's second provider is then https://<name in the certificate>:8443.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { upstream: { type: 'string' }, port: { type: 'string' }, cert: { type: 'string' }, key: { type: 'string' }, host: { type: 'string', default: '::' } } });
for (const name of ['upstream', 'port', 'cert', 'key']) {
  if (!values[name]) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
}
const upstream = new URL(values.upstream);
if (upstream.protocol !== 'https:') {
  console.error('--upstream must be an https URL');
  process.exit(2);
}

const MAX_BODY = 1024 * 1024;
let relayed = 0;

const server = createServer({ cert: readFileSync(values.cert), key: readFileSync(values.key) }, (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  });
  req.on('end', async () => {
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      return;
    }
    try {
      const answer = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(15_000), redirect: 'error' });
      const body = Buffer.from(await answer.arrayBuffer());
      relayed++;
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' }).end(body);
    } catch {
      res.writeHead(502).end();
    }
  });
});

server.listen(Number(values.port), values.host, () => console.log(`${new Date().toISOString()} relay listening on ${values.host} port ${values.port}, passing through to ${upstream.host}`));
const stop = () => {
  console.log(`${new Date().toISOString()} relay stopping after ${relayed} requests`);
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
