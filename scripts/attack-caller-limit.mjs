#!/usr/bin/env node
// Attacks the per-caller limit of a hosted watcher from outside (rule C35 in
// docs/security/threat-model.md): can a caller get past the limit by saying it is someone else?
//
//   node scripts/attack-caller-limit.mjs [https://the-watcher's-address]
//   With no address it uses the watcher named in deployments/testnet.json.
//
// It asks POST /subscribe twelve times for a treasury nobody watches. No token is made and nothing
// is spent: the answer is 404, and a well-formed ask still counts against its caller. Every ask
// carries a different made-up X-Forwarded-For and X-Real-IP. A watcher that believes either one
// gives each ask its own count and never refuses. The limit is ten an hour, so the right answers
// are 404 until the count is used up and 429 from then on, by the eleventh ask at the latest.
//
// Run it after every deploy: which header a host's proxy overwrites is the host's behaviour, and
// no test inside this repository can see it. It uses up this machine's asks on that host for an
// hour, so a second run inside the hour is refused from its first ask, which is also a pass.
//
// Not covered: that two real callers get two separate counts. On each refusal the watcher's own
// log names the address it counted (event rate_limited), and that is where to look.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASKS = 12;
const LIMIT = 10;

let host = process.argv[2];
if (!host) {
  const record = fileURLToPath(new URL('../deployments/testnet.json', import.meta.url));
  host = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')).watcher?.url : undefined;
}
if (!host || !/^https:\/\/[a-z0-9.-]+$/i.test(host)) {
  console.error('give the watcher\'s address, such as https://watcher.example.org');
  process.exit(2);
}

const answers = [];
for (let i = 1; i <= ASKS; i++) {
  // 203.0.113.0/24 and 198.51.100.0/24 are set aside for examples (RFC 5737): nobody's address.
  const res = await fetch(`${host}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i}`, 'x-real-ip': `198.51.100.${i}` },
    body: JSON.stringify({ dao: 'nobody-watches-this.testnet' }),
    signal: AbortSignal.timeout(20_000),
  });
  await res.arrayBuffer();
  answers.push(res.status);
}
console.log(`watcher: ${host}`);
console.log(`answers to ${ASKS} asks, each under another made-up address: ${answers.join(' ')}`);

const firstRefusal = answers.indexOf(429);
const counted = firstRefusal === -1 ? answers.length : firstRefusal;
const clean = answers.every((a, i) => a === (i < counted ? 404 : 429));
if (!clean) {
  console.log('RESULT: unclear, an answer was neither 404 nor 429, or a 404 followed a refusal');
  process.exit(1);
}
if (firstRefusal === -1 || counted > LIMIT) {
  console.log(`RESULT: FAIL, ${counted} asks were counted separately: the watcher believed a made-up address`);
  process.exit(1);
}
console.log(`RESULT: pass, the limit bit after ${counted} asks: the made-up addresses changed nothing`);
