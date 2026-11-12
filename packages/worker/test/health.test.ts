// Health (C18): watcher lag, a silent provider, failed runs, low balances, a change of the guard's
// accepted key and providers that disagree each raise "guard offline" or "guard degraded" for the
// DAO they concern, reach its members, and show on GET /status, which holds no secret; behind the
// HTTPS proxy on the same machine, POST /subscribe counts each client by the address the proxy
// saw, an IPv6 one by its /64 network, and a burst from one address gets no more tokens than the
// limit. Not covered: a worker
// process that is down altogether, which only an outside check of /status sees, and the proxy's
// own behaviour, which HOSTING.md checks on the VM.

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';

import { Actor } from '../src/act.ts';
import { Alerts } from '../src/alerts.ts';
import { CapGuard } from '../src/caps.ts';
import { ALL, Health } from '../src/health.ts';
import { Judge } from '../src/judge.ts';
import { formatNear } from '../src/near.ts';
import { Reads } from '../src/reads.ts';
import { RejudgeWatch } from '../src/rejudge.ts';
import { StatusServer, clientAddress, statusReport } from '../src/status.ts';
import { Submitter } from '../src/submit.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { GUARD_FLOOR, WORKER_FLOOR, Worker } from '../src/worker.ts';
import { DAO, FakeChain, FakeTelegram, GUARD, NETWORK, REGISTRY, bothSet, bridge, clock, events, memoryLog, memoryStore, noSleep, runOutcome, sealedOutput, testKey, twoProviders, verdictFields } from './helpers.ts';

const NEAR = 10n ** 24n;
const WORKER = 'worker.kaap.testnet';
const CHAT = '5550001234';
const OTHER_CHAT = '5550009876';
const LAG = 15_000;

async function started() {
  const [a, b] = twoProviders();
  const key = testKey();
  bothSet([a, b], (p) => {
    p.acceptedKey = key.getPublicKey().toString();
    p.balances.set(WORKER, 10n * NEAR);
  });
  const c = clock();
  const store = memoryStore(c.now);
  const { log, lines } = memoryLog();
  const health = new Health(log, c.now);
  const telegram = new FakeTelegram();
  const alerts = new Alerts({ store, telegram, log, now: c.now, sleep: noSleep }, { network: NETWORK, siteUrl: null, batchMs: 60_000, capPerHour: 30 });
  health.on((e) => alerts.health(e));
  const subs = new Subscriptions(store, NETWORK, log);
  subs.redeem(subs.issue(DAO).token, CHAT);
  subs.redeem(subs.issue('other.sputnik.testnet').token, OTHER_CHAT);
  const chain = new FakeChain();
  const caps = new CapGuard(store, { runsPerDaoDay: 50, textRunsPerDaoDay: 5, recordsPerDaoDay: 50, nearPerDay: 10n * NEAR }, NETWORK);
  const submitter = new Submitter(store, chain, NETWORK, log, { pollMs: 1, sendTries: 2, sleep: noSleep, explorer: (h) => h });
  const reads = new Reads(a, b, bridge, 0, noSleep);
  const accepted = { value: null as string | null };
  const judge = new Judge({ store, submitter, caps, bridge, health, log, acceptedKey: () => accepted.value, now: c.now }, { network: NETWORK, guard: GUARD, outlayer: 'outlayer.testnet', project: 'o.testnet/p', verdictTtlMs: 600_000, windowBlocks: 220 });
  const actor = new Actor({ store, submitter, caps, reads, health, log, now: c.now, sleep: noSleep }, { network: NETWORK, guard: GUARD, registry: REGISTRY, gateTries: 1, gateRetryMs: 0 });
  const rejudge = new RejudgeWatch({ reads, store, bridge, health, log, enqueue: () => {} }, NETWORK);
  const worker = new Worker(
    { store, reads, judge, actor, rejudge, health, log, now: c.now, acceptedKey: accepted, bridge, alerts },
    { network: NETWORK, guard: GUARD, pollMs: 60_000, watchMs: 60_000, enrolledMs: 60_000, holdAlertMs: 30_000, backfillWindow: 100, maxConcurrentRuns: 2, lagAlertMs: LAG, sweepMs: 60_000, workerAccount: WORKER },
  );
  await worker.start();
  const level = () => statusReport(health, worker.watching(), { network: NETWORK, guard: GUARD }, c.now()).daos[0]!.status;
  /** Lets the batch window pass and returns what each chat has received so far. */
  const delivered = async () => {
    c.advance(60_000);
    await alerts.flush();
    return { chat: telegram.to(CHAT), other: telegram.to(OTHER_CHAT) };
  };
  return { a, b, c, key, store, health, alerts, telegram, subs, chain, judge, worker, level, delivered, log, lines: () => lines };
}

test('a silent provider raises guard degraded, watcher lag raises guard offline at once, and both clear', async () => {
  const s = await started();
  await s.worker.pollTick();
  s.worker.sweep();
  assert.equal(s.level(), 'healthy');

  s.b.down = true;
  s.c.advance(LAG);
  await s.worker.pollTick();
  s.worker.sweep();
  assert.equal(s.level(), 'degraded');
  assert.equal(s.health.has('provider_silent', DAO), true);

  s.a.down = true;
  s.c.advance(LAG);
  await s.worker.pollTick();
  s.worker.sweep();
  assert.equal(s.level(), 'offline');
  await s.alerts.flush();
  assert.match(s.telegram.to(CHAT)[0]!, /^Kaap guard OFFLINE for treasury\[\.\]sputnik\[\.\]testnet: Kaap cannot read this DAO's proposal counter/, 'offline goes out at once');
  assert.equal(s.telegram.to(OTHER_CHAT).length, 0, "another DAO's members are not told");

  bothSet([s.a, s.b], (p) => (p.down = false));
  s.c.advance(1_000);
  await s.worker.pollTick();
  s.worker.sweep();
  assert.equal(s.level(), 'healthy');
  const { chat } = await s.delivered();
  assert.match(chat[1]!, /^Kaap guard update for treasury\[\.\]sputnik\[\.\]testnet:\nDegraded: One of Kaap's two RPC providers is not answering/);
  assert.match(chat[1]!, /Recovered, no longer true: Kaap cannot read this DAO's proposal counter/);
  await s.worker.stop();
});

test('providers that disagree past the hold window raise guard degraded (C22)', async () => {
  const s = await started();
  bothSet([s.a, s.b], (p) => (p.optimistic = 1));
  s.a.final = 1;
  await s.worker.pollTick();
  s.c.advance(30_000);
  await s.worker.pollTick();
  assert.equal(s.level(), 'degraded');
  const { chat } = await s.delivered();
  assert.match(chat[0]!, /Degraded: Kaap's two RPC providers disagree about this DAO/);
  await s.worker.stop();
});

test('failed runs raise guard degraded, and the next verified verdict for that proposal clears them', async () => {
  const s = await started();
  s.chain.respond = () => null;
  assert.equal((await s.judge.judge(DAO, 4, 1)).kind, 'no_verdict');
  assert.deepEqual([s.health.has('run_no_answer', DAO), s.health.has('run_without_verdict', DAO), s.level()], [true, true, 'degraded']);
  const { chat } = await s.delivered();
  assert.match(chat[0]!, /Degraded: The sealed judge did not answer a run[\s\S]*Degraded: A proposal could not be judged/);

  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(4, { expires_at_ms: s.c.now() + 600_000 }), s.key));
  assert.equal((await s.judge.judge(DAO, 4, 2)).kind, 'verdict');
  assert.equal(s.level(), 'healthy');
  await s.worker.stop();
});

test('a signal for proposal 1 stays while proposal 2 gets a verdict', async () => {
  const s = await started();
  s.chain.respond = () => null;
  assert.equal((await s.judge.judge(DAO, 1, 1)).kind, 'no_verdict');
  // Signed with a key the guard does not accept, so the worker refuses the verdict.
  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(3, { expires_at_ms: s.c.now() + 600_000 }), testKey()));
  assert.equal((await s.judge.judge(DAO, 3, 1)).kind, 'no_verdict');
  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(2, { expires_at_ms: s.c.now() + 600_000 }), s.key));
  assert.equal((await s.judge.judge(DAO, 2, 1)).kind, 'verdict');

  const raised = () => s.health.current().map((r) => `${r.signal} ${r.proposal}`).sort();
  assert.deepEqual(raised(), ['run_no_answer 1', 'run_without_verdict 1', 'run_without_verdict 3', 'verdict_rejected 3'], "proposal 2's verdict clears nothing of 1 or 3");
  assert.equal(s.level(), 'degraded');
  // GET /status keeps its shape: one line per proposal that holds the signal.
  const signals = statusReport(s.health, s.worker.watching(), { network: NETWORK, guard: GUARD }, s.c.now()).daos[0]!.signals.map((x) => x.signal).sort();
  assert.deepEqual(signals, ['run_no_answer', 'run_without_verdict', 'run_without_verdict', 'verdict_rejected']);

  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(1, { expires_at_ms: s.c.now() + 600_000 }), s.key));
  assert.equal((await s.judge.judge(DAO, 1, 2)).kind, 'verdict');
  assert.deepEqual(raised(), ['run_without_verdict 3', 'verdict_rejected 3'], "1's own verdict clears 1's signals");
  await s.worker.stop();
});

test('balances below 20 stopped attacks or the storage of 20 vetoes raise guard degraded for every DAO', async () => {
  const s = await started();
  assert.deepEqual([formatNear(WORKER_FLOOR), formatNear(GUARD_FLOOR)], ['2.060000', '0.016800'], 'run 0.05 + record 0.023 + veto 0.03, times 20; and 20 times 84 bytes');
  bothSet([s.a, s.b], (p) => p.balances.set(WORKER, WORKER_FLOOR - 1n + 100n * 10n ** 19n));
  s.b.balances.set(GUARD, GUARD_FLOOR - 1n + 100n * 10n ** 19n);
  await s.worker.checkBalances();
  assert.deepEqual([s.health.has('worker_balance_low', ALL), s.health.has('guard_balance_low', ALL), s.level()], [true, true, 'degraded']);
  const report = statusReport(s.health, s.worker.watching(), { network: NETWORK, guard: GUARD }, s.c.now());
  assert.deepEqual(report.everywhere.map((e) => e.signal).sort(), ['guard_balance_low', 'worker_balance_low']);
  const { chat, other } = await s.delivered();
  for (const texts of [chat, other]) assert.match(texts[0]!, /^Kaap guard update for every DAO Kaap watches:\nDegraded: Kaap's worker account holds less NEAR/, 'every chat hears it once');

  bothSet([s.a, s.b], (p) => {
    p.balances.set(WORKER, 3n * NEAR);
    p.balances.set(GUARD, NEAR);
  });
  await s.worker.checkBalances();
  assert.equal(s.level(), 'healthy');
  await s.worker.stop();
});

test("a change of the guard's accepted key raises guard degraded until a verdict signed with the new key checks out", async () => {
  const s = await started();
  const next = testKey();
  bothSet([s.a, s.b], (p) => (p.acceptedKey = next.getPublicKey().toString()));
  await s.worker.refreshGuard();
  assert.deepEqual([s.health.has('accepted_key_changed', ALL), s.level()], [true, 'degraded']);
  const { other } = await s.delivered();
  assert.match(other[0]!, /The guard's accepted signing key changed/);

  s.chain.respond = () => runOutcome(sealedOutput(verdictFields(6, { expires_at_ms: s.c.now() + 600_000 }), next));
  assert.equal((await s.judge.judge(DAO, 6, 1)).kind, 'verdict');
  assert.equal(s.level(), 'healthy');
  await s.worker.stop();
});

test('GET /status shows each level with no secret in it, and POST /subscribe hands out one-time tokens', async () => {
  const s = await started();
  const privateKey = testKey().toString();
  const botToken = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-Ms';
  s.health.raise('veto_refused', DAO, { proposal_id: 3, code: 'ERR_SECRET_CODE', private_key: privateKey, chat: CHAT, token: botToken, detail: 'provider said <script>' });
  s.health.raise('worker_balance_low', ALL, { account: WORKER, spendable_near: '0.123456' });
  const http = new StatusServer({ health: s.health, subs: s.subs, log: s.log, now: s.c.now, watching: () => s.worker.watching(), texts: s.worker }, { host: '127.0.0.1', port: 0, network: NETWORK, guard: GUARD, botUsername: 'kaap_test_bot', tokensPerAddressHour: 3, textsPerAddressHour: 3, textKey: null });
  const base = `http://127.0.0.1:${await http.start()}`;

  const res = await fetch(`${base}/status`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
  const body = JSON.parse(text) as { status: string; daos: Array<{ dao: string; status: string; signals: Array<Record<string, string>> }>; everywhere: Array<Record<string, string>> };
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.daos.map((d) => [d.dao, d.status, d.signals.map((x) => x.signal)]), [[DAO, 'degraded', ['veto_refused']]]);
  assert.deepEqual(Object.keys(body.daos[0]!.signals[0]!).sort(), ['level', 'says', 'signal', 'since']);
  assert.equal(body.everywhere[0]?.signal, 'worker_balance_low');
  for (const secret of [privateKey, botToken, botToken.split(':')[1]!, CHAT, 'ERR_SECRET_CODE', '<script>', '0.123456']) assert.ok(!text.includes(secret), `${secret.slice(0, 12)} is not on /status`);

  const ask = (body: string) => fetch(`${base}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const ok = await ask(JSON.stringify({ dao: DAO }));
  const issued = (await ok.json()) as { token: string; start_command: string; telegram_link: string };
  assert.equal(ok.status, 200);
  assert.equal(issued.start_command, `/start ${issued.token}`);
  assert.equal(issued.telegram_link, `https://t.me/kaap_test_bot?start=${issued.token}`);
  assert.equal(s.subs.redeem(issued.token, '5550007777')?.dao, DAO);
  assert.equal((await ask(JSON.stringify({ dao: 'nobody.testnet' }))).status, 404, 'only a DAO Kaap watches');
  assert.equal((await ask(JSON.stringify({ dao: DAO, chat_id: 1 }))).status, 400);
  assert.equal((await ask('not json')).status, 400);
  assert.equal((await ask(JSON.stringify({ dao: 'x'.repeat(2_000) }))).status, 413);
  assert.equal((await ask(JSON.stringify({ dao: DAO }))).status, 200);
  assert.equal((await ask(JSON.stringify({ dao: DAO }))).status, 429, 'three tokens an hour from one address');
  assert.equal((await fetch(`${base}/subscribe`)).status, 405);
  assert.equal((await fetch(`${base}/anything`)).status, 404);
  await http.stop();
  await s.worker.stop();
});

test('behind the HTTPS proxy on the same machine, POST /subscribe counts each client by the address the proxy saw', async () => {
  assert.equal(clientAddress('198.51.100.20', '203.0.113.7'), '198.51.100.20', 'a peer that is not loopback cannot name another address');
  assert.equal(clientAddress('127.0.0.1', '10.0.0.1, 203.0.113.7'), '203.0.113.7', 'only the entry the proxy added counts');
  assert.equal(clientAddress('::ffff:127.0.0.1', ['10.0.0.1', '203.0.113.7']), '203.0.113.7');
  assert.equal(clientAddress('::1', '::FFFF:203.0.113.7'), '203.0.113.7', 'one client, one written form');
  assert.equal(clientAddress('127.0.0.1', undefined), '127.0.0.1', 'no header counts against the proxy itself');
  assert.equal(clientAddress('127.0.0.1', '203.0.113.7, not-an-address'), '127.0.0.1');
  assert.equal(clientAddress(undefined, '203.0.113.7'), 'unknown');

  const s = await started();
  const http = new StatusServer({ health: s.health, subs: s.subs, log: s.log, now: s.c.now, watching: () => s.worker.watching(), texts: s.worker }, { host: '127.0.0.1', port: 0, network: NETWORK, guard: GUARD, botUsername: 'kaap_test_bot', tokensPerAddressHour: 2, textsPerAddressHour: 3, textKey: null });
  const base = `http://127.0.0.1:${await http.start()}`;
  const ask = async (forwarded: string) => (await fetch(`${base}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded }, body: JSON.stringify({ dao: DAO }) })).status;
  assert.deepEqual([await ask('203.0.113.7'), await ask('203.0.113.7'), await ask('203.0.113.7')], [200, 200, 429]);
  assert.equal(await ask('198.51.100.9'), 200, 'another client behind the same proxy is not blocked by the first');
  assert.equal(await ask('198.51.100.1, 203.0.113.7'), 429, 'an address a client writes before the proxy entry changes nothing');
  assert.equal(events(s.lines(), 'rate_limited').at(-1)?.address, '203.0.113.7');
  await http.stop();
  await s.worker.stop();
});

test('an IPv6 client is counted by its /64 network, and every written form of an IPv4 address as that address', () => {
  assert.equal(clientAddress('2001:db8:1:2:3:4:5:6', undefined), '2001:db8:1:2::/64');
  assert.equal(clientAddress('2001:db8:1:2::9', undefined), '2001:db8:1:2::/64', 'one /64, one count');
  assert.equal(clientAddress('2001:0DB8:0001:0002::1', undefined), '2001:db8:1:2::/64', 'lower case, no leading zeros');
  assert.equal(clientAddress('2001:db8:1:3::1', undefined), '2001:db8:1:3::/64', 'the next /64 is another client');
  for (const mapped of ['::ffff:1.2.3.4', '::ffff:102:304', '0:0:0:0:0:ffff:102:304']) assert.equal(clientAddress(mapped, undefined), '1.2.3.4', mapped);
  assert.equal(clientAddress('fe80::1%eth0', undefined), 'fe80:0:0:0::/64', 'read without its zone');
  assert.equal(clientAddress('fe80::1%eth0', undefined), clientAddress('fe80::1', undefined));
  assert.equal(clientAddress('not-an-address', undefined), 'unknown');
  assert.equal(clientAddress('1.2.3.4%eth0', undefined), 'unknown', 'a zone makes no IPv4 address');
  assert.equal(clientAddress('::1', '10.0.0.1, 2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64', 'the proxy entry is counted by its /64');
  assert.equal(clientAddress('::1', undefined), '0:0:0:0::/64', 'no header counts against the proxy itself');
});

test('requests from two addresses of one IPv6 /64 share one POST /subscribe limit', async () => {
  const s = await started();
  const http = new StatusServer({ health: s.health, subs: s.subs, log: s.log, now: s.c.now, watching: () => s.worker.watching(), texts: s.worker }, { host: '127.0.0.1', port: 0, network: NETWORK, guard: GUARD, botUsername: 'kaap_test_bot', tokensPerAddressHour: 2, textsPerAddressHour: 3, textKey: null });
  const base = `http://127.0.0.1:${await http.start()}`;
  const ask = async (forwarded: string) => (await fetch(`${base}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded }, body: JSON.stringify({ dao: DAO }) })).status;
  assert.deepEqual([await ask('2001:db8:1:2::1'), await ask('2001:db8:1:2:ffff::2'), await ask('2001:db8:1:2::3')], [200, 200, 429]);
  assert.equal(await ask('2001:db8:1:3::1'), 200, 'another /64 behind the same proxy is not blocked by the first');
  assert.equal(events(s.lines(), 'rate_limited').at(-1)?.address, '2001:db8:1:2::/64');
  await http.stop();
  await s.worker.stop();
});

test('six POST /subscribe requests read at once from one address get exactly the two tokens its limit allows', async () => {
  const s = await started();
  const http = new StatusServer({ health: s.health, subs: s.subs, log: s.log, now: s.c.now, watching: () => s.worker.watching(), texts: s.worker }, { host: '127.0.0.1', port: 0, network: NETWORK, guard: GUARD, botUsername: 'kaap_test_bot', tokensPerAddressHour: 2, textsPerAddressHour: 3, textKey: null });
  const port = await http.start();
  // Every header arrives before any body, so each request passes the first look at the count
  // before one of them is counted.
  const pending = Array.from({ length: 6 }, () => {
    const req = request({ host: '127.0.0.1', port, path: '/subscribe', method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.44' } });
    const status = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    req.flushHeaders();
    return { req, status };
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const { req } of pending) req.end(JSON.stringify({ dao: DAO }));
  const burst = await Promise.all(pending.map((p) => p.status));
  assert.deepEqual([...burst].sort((a, b) => a - b), [200, 200, 429, 429, 429, 429]);
  assert.equal(events(s.lines(), 'rate_limited').filter((l) => l.route === '/subscribe').length, 4);
  await http.stop();
  await s.worker.stop();
});
