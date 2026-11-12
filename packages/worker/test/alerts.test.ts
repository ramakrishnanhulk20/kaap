// Member alerts (C24, C27): attacker strings go out inert, the only link is Kaap's own, batches
// form per DAO and per proposer while a critical verdict goes at once, batched messages are capped
// per chat, a send Telegram refused is retried or ends the chat's subscriptions, and a restart
// drops the health changes an earlier process left queued. Not covered: how a Telegram client
// draws the text, which only a real chat shows (checked live on testnet, 2 Nov 2026).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Alerts, plainText, proposalLink, render, type AlertBody } from '../src/alerts.ts';
import { ALL, Health } from '../src/health.ts';
import { Store } from '../src/store.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { BotApi } from '../src/telegram.ts';
import { DAO, FakeTelegram, NETWORK, T0, clock, events, memoryLog, memoryStore, noSleep } from './helpers.ts';

const SITE = 'https://kaap.example';
const CHAT = '5550001234';
const OTHER_CHAT = '5550009876';

function setup(opts: { cap?: number } = {}) {
  const c = clock();
  const store = memoryStore(c.now);
  const { log, lines } = memoryLog();
  const health = new Health(log, c.now);
  const telegram = new FakeTelegram();
  const alerts = new Alerts(
    { store, telegram, log, now: c.now, sleep: noSleep, onDelivery: (ok) => (ok ? health.clear('alerts_failing', ALL) : health.raise('alerts_failing', ALL)) },
    { network: NETWORK, siteUrl: SITE, batchMs: 60_000, capPerHour: opts.cap ?? 30 },
  );
  const subs = new Subscriptions(store, NETWORK, log);
  subs.redeem(subs.issue(DAO).token, CHAT);
  return { c, store, health, telegram, alerts, subs, lines: () => lines };
}

const verdict = (risk: string, hash: string, findings = ['UNKNOWN_VALUE']) => ({ risk, findings, vetoable: risk === 'critical', verdict_hash: hash });
const critical = (proposer: unknown, findings: unknown[] = ['DESC_CONTRADICTS']): AlertBody[] => [{ t: 'verdict', id: 7, risk: 'critical', findings: findings as string[], vetoable: true, proposer: proposer as string }];

test('attacker strings with markup, links and zero-width characters go out inert (C24)', () => {
  assert.equal(plainText('a​b‍c‮d⁦e﻿f­g\u0007h ij'), 'abcdefghij', 'format, control, separator and private-use characters are removed');

  const attacker = ['<b>approve now</b>', '[claim](https://evil.example)', 'https://evil.example/x', '@kaap_admin', '/approve_all', '#airdrop', 'ali​ce.near', 'ev‮il.near', '*bold* _it_ `code`', 'A1ICE.near'];
  for (const proposer of attacker) {
    const text = render(NETWORK, SITE, DAO, critical(proposer));
    assert.ok(!text.includes(proposer), `${JSON.stringify(proposer)} is never put in the message`);
    assert.ok(text.includes('filed by an account Kaap could not read'));
  }

  // A valid NEAR name can still end in a real web domain; its dots are shown as [.].
  const tg = render(NETWORK, SITE, DAO, critical('claim-airdrop.tg'));
  assert.ok(tg.includes('filed by claim-airdrop[.]tg.'));
  assert.ok(!tg.includes('claim-airdrop.tg'));
  assert.ok(tg.includes('treasury[.]sputnik[.]testnet'), 'the DAO id is shown the same way');

  const odd = render(NETWORK, SITE, DAO, critical('a1ice.testnet', ['DESC_CONTRADICTS', 'https://evil.example', '<a href="x">', 'OK​', 42]));
  assert.ok(odd.includes('Findings: DESC_CONTRADICTS, 4 more Kaap could not read.'));
  assert.ok(!odd.includes('evil.example') && !odd.includes('<a'));

  // The only link is Kaap's own page for the proposal, built from the checked id and number.
  for (const text of [tg, odd]) {
    assert.deepEqual(text.match(/https?:\/\/\S+/g), [`${SITE}/testnet/${DAO}/7`]);
    assert.ok(!/[^\P{C}\n]/u.test(text), 'no control or format character survives');
  }
  assert.equal(proposalLink(null, NETWORK, DAO, 7), null, 'no site, no link');
  assert.equal(proposalLink(SITE, NETWORK, 'evil.example/../x', 7), null);
  assert.equal(proposalLink(SITE, NETWORK, DAO, -1), null);
  assert.equal(proposalLink(SITE, NETWORK, DAO, 1.5), null);
  assert.equal(proposalLink(SITE, 'devnet', DAO, 7), null);
  assert.ok(!render(NETWORK, null, DAO, critical('a1ice.testnet')).includes('http'), 'without a site the message has no link at all');
});

test('Telegram gets plain text with no parse mode, no entities and no preview, and errors never carry the token', async () => {
  const token = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-Ms';
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const answers = [{ ok: true, result: { message_id: 42, chat: { id: Number(CHAT), type: 'private' } } },{ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answers.shift()));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = new BotApi(token, { base, timeoutMs: 2_000 });
  const text = render(NETWORK, SITE, DAO, critical('<b>x</b>'));

  assert.deepEqual(await api.sendMessage(CHAT, text), { ok: true, messageId: 42, chatId: CHAT });
  assert.deepEqual(Object.keys(seen[0]!.body).sort(), ['chat_id', 'link_preview_options', 'text']);
  assert.deepEqual(seen[0]!.body.link_preview_options, { is_disabled: true });
  assert.equal(seen[0]!.body.chat_id, Number(CHAT));
  assert.equal(seen[0]!.body.text, text);

  const blocked = await api.sendMessage(CHAT, text);
  assert.deepEqual([blocked.ok, !blocked.ok && blocked.gone, !blocked.ok && blocked.code], [false, true, 403]);
  const slow = await api.sendMessage(CHAT, text);
  assert.deepEqual([!slow.ok && slow.retryable, !slow.ok && slow.retryAfterMs], [true, 3_000]);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  const down = await api.sendMessage(CHAT, text);
  assert.deepEqual([down.ok, !down.ok && down.retryable], [false, true]);
  await assert.rejects(api.getMe(), (e: unknown) => e instanceof Error && !e.message.includes(token) && !e.message.includes(token.split(':')[1]!));
  for (const r of [blocked, slow, down]) assert.ok(!JSON.stringify(r).includes(token.split(':')[1]!));
});

test('alerts batch per DAO and per proposer, a critical verdict goes at once, and low risk is not news (C27)', async () => {
  const s = setup();
  s.alerts.verdict(DAO, 7, verdict('high', 'h7'), 'alice.testnet');
  s.alerts.verdict(DAO, 8, verdict('medium', 'h8', ['NEW_RECIPIENT']), 'alice.testnet');
  s.alerts.verdict(DAO, 9, verdict('unknown', 'h9', ['HASH_UNVERIFIED']), 'bob.testnet');
  s.alerts.verdict(DAO, 10, verdict('low', 'h10'), 'bob.testnet');
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 0, 'nothing batched goes before its window ends');

  s.c.advance(10_000);
  s.alerts.verdict(DAO, 11, verdict('critical', 'h11', ['DESC_CONTRADICTS', 'UNKNOWN_VALUE']), 'alice.testnet');
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 1, 'the critical verdict did not wait for the batch');
  assert.match(s.telegram.sent[0]!.text, /^Kaap: CRITICAL risk on proposal 11 of treasury\[\.\]sputnik\[\.\]testnet, filed by alice\[\.\]testnet\.\nFindings: DESC_CONTRADICTS, UNKNOWN_VALUE\.\nKaap is sending its veto now\./);
  assert.match(s.telegram.sent[0]!.text, /\nSend \/stop to stop Kaap alerts in this chat\.$/, 'every message says how to stop them');

  s.c.advance(49_999);
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 1);
  s.c.advance(1);
  await s.alerts.flush();
  const texts = s.telegram.to(CHAT);
  assert.equal(texts.length, 3, 'one message for alice, one for bob');
  const alice = texts.find((t) => t.includes('need a look') && t.includes('by alice[.]testnet'))!;
  assert.match(alice, /^Kaap: 2 proposals on treasury\[\.\]sputnik\[\.\]testnet by alice\[\.\]testnet need a look\./);
  assert.match(alice, /Proposal 7: HIGH risk\. Findings: UNKNOWN_VALUE\. https:\/\/kaap\.example\/testnet\/treasury\.sputnik\.testnet\/7/);
  assert.match(alice, /Proposal 8: MEDIUM risk\. Findings: NEW_RECIPIENT\./);
  assert.match(texts.find((t) => t.includes('by bob[.]testnet'))!, /1 proposal on .* needs a look\.\nProposal 9: UNKNOWN risk/);
  assert.ok(!texts.some((t) => t.includes('Proposal 10')), 'a low verdict is not alerted');

  // The same verdict handed over again, as after a restart, is not sent twice.
  s.alerts.verdict(DAO, 11, verdict('critical', 'h11'), 'alice.testnet');
  s.c.advance(120_000);
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 3);
  assert.equal(events(s.lines(), 'alert_sent').length, 3);
});

test('the first critical alert no longer claims the guard is voting', () => {
  const text = render(NETWORK, SITE, DAO, critical('alice.testnet'));
  assert.match(text, /\nKaap is sending its veto now\.\n/, 'what is true before the vote is known');
  assert.doesNotMatch(text, /voting|rejected|reject it now/);
});

test('each way a veto can fail to land has its own fixed sentence, and asks members to reject the proposal themselves', () => {
  const said: Record<string, RegExp> = {
    held: /Kaap could not confirm the proposal on both RPC providers, or could not send its vote\. It keeps trying\./,
    capped: /Kaap reached a daily spending limit\. It sends the vote once the limit has room\./,
    no_outcome: /Its vote was sent but no result came back\. Kaap keeps sending the same vote\./,
    refused: /The guard or the DAO refused its vote\./,
  };
  for (const [why, reason] of Object.entries(said)) {
    const text = render(NETWORK, SITE, DAO, [{ t: 'veto_failed', id: 7, why } as AlertBody]);
    assert.match(text, /^Kaap: could not veto proposal 7 of treasury\[\.\]sputnik\[\.\]testnet\. /, why);
    assert.match(text, reason, why);
    assert.match(text, /\nIf you agree it is an attack, vote to reject it yourself\.\nDetails: https:\/\/kaap\.example\/testnet\/treasury\.sputnik\.testnet\/7\n/, why);
  }
});

test('batched messages are capped per chat per hour; urgent ones never are', async () => {
  const s = setup({ cap: 2 });
  for (const n of [1, 2, 3]) s.alerts.verdict(DAO, 20 + n, verdict('high', `c${n}`), `proposer-${n}.testnet`);
  s.c.advance(60_000);
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 2);
  assert.equal(events(s.lines(), 'alert_capped').length, 1);

  s.alerts.verdict(DAO, 30, verdict('critical', 'c30'), 'proposer-1.testnet');
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 3, 'a critical verdict is sent past the cap');

  s.c.advance(3_600_000);
  s.alerts.verdict(DAO, 31, verdict('high', 'c31'), 'proposer-1.testnet');
  s.c.advance(60_000);
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 4, 'a new hour has room again');
});

test('a send nobody received is tried again later, Telegram failing is raised, and a blocked bot ends the subscriptions', async () => {
  const s = setup();
  s.telegram.plan = [{ ok: false, code: null, retryable: true, gone: false, retryAfterMs: null, detail: 'Telegram could not be reached' }];
  s.alerts.verdict(DAO, 40, verdict('critical', 'r40'), 'alice.testnet');
  await s.alerts.flush();
  assert.equal(s.health.has('alerts_failing', ALL), true);
  assert.equal(events(s.lines(), 'alert_not_delivered').length, 1);
  s.c.advance(30_000);
  await s.alerts.flush();
  assert.equal(s.telegram.sent.length, 2);
  assert.equal(events(s.lines(), 'alert_sent').length, 1, 'delivered once, on the second try');
  assert.equal(s.health.has('alerts_failing', ALL), false);

  s.subs.redeem(s.subs.issue(DAO).token, OTHER_CHAT);
  s.telegram.plan = [{ ok: false, code: 403, retryable: false, gone: true, retryAfterMs: null, detail: 'Forbidden: bot was blocked by the user' }];
  s.alerts.verdict(DAO, 41, verdict('critical', 'r41'), 'alice.testnet');
  await s.alerts.flush();
  assert.deepEqual(s.store.subscribers(NETWORK, DAO).map((r) => r.chat_id), [OTHER_CHAT], 'the chat that blocked the bot is unsubscribed');
  assert.equal(s.telegram.to(OTHER_CHAT).length, 1, 'the other chat still got it');
});

/** What an earlier worker process leaves queued in its SQLite file when it stops: a "guard
 *  degraded" change, and high verdicts on proposal 7 (still open) and 8 (approved since). */
function leftQueued(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'kaap-worker-alerts-')), 'worker.sqlite');
  const store = new Store(path, () => T0);
  const { log } = memoryLog();
  const health = new Health(log, () => T0);
  const alerts = new Alerts({ store, telegram: new FakeTelegram(), log, now: () => T0, sleep: noSleep }, { network: NETWORK, siteUrl: SITE, batchMs: 60_000, capPerHour: 30 });
  health.on((e) => alerts.health(e));
  const subs = new Subscriptions(store, NETWORK, log);
  subs.redeem(subs.issue(DAO).token, CHAT);
  for (const id of [7, 8]) store.queueNew(NETWORK, DAO, id, 'new', 'InProgress');
  health.raise('provider_silent', DAO);
  alerts.verdict(DAO, 7, verdict('high', 'h7'), 'alice.testnet');
  alerts.verdict(DAO, 8, verdict('high', 'h8'), 'alice.testnet');
  store.setProposalStatus(NETWORK, DAO, 8, 'Approved');
  store.close();
  return path;
}

function restarted(path: string) {
  const c = clock(T0 + 5_000);
  const store = new Store(path, c.now);
  const { log, lines } = memoryLog();
  const telegram = new FakeTelegram();
  const alerts = new Alerts({ store, telegram, log, now: c.now, sleep: noSleep }, { network: NETWORK, siteUrl: SITE, batchMs: 60_000, capPerHour: 30 });
  return { c, store, telegram, alerts, lines };
}

test('on boot, the health changes an earlier process left queued are dropped and logged once', async () => {
  const s = restarted(leftQueued());
  assert.equal(s.alerts.dropStale(), 2);
  assert.equal(s.alerts.dropStale(), 0, 'nothing is left to drop a second time');
  const dropped = events(s.lines, 'stale_alerts_dropped');
  assert.equal(dropped.length, 1);
  assert.deepEqual([dropped[0]?.count, dropped[0]?.health, dropped[0]?.closed_proposals], [2, 1, 1]);
  s.c.advance(60_000);
  await s.alerts.flush();
  assert.ok(!s.telegram.sent.some((m) => /guard update|Degraded/.test(m.text)), 'the old "degraded" never goes out');
  assert.ok(!s.telegram.sent.some((m) => m.text.includes('Proposal 8')), 'nor the verdict on a proposal approved since');
  s.store.close();
});

test('on boot, a verdict an earlier process queued for a proposal still open is kept and sent', async () => {
  const s = restarted(leftQueued());
  s.alerts.dropStale();
  s.c.advance(60_000);
  await s.alerts.flush();
  const texts = s.telegram.to(CHAT);
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /^Kaap: 1 proposal on treasury\[\.\]sputnik\[\.\]testnet by alice\[\.\]testnet needs a look\.\nProposal 7: HIGH risk/);
  assert.equal(events(s.lines, 'alert_sent').length, 1);
  s.store.close();
});
