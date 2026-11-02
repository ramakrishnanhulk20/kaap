// `kaap subscribe` against a worker that answers the way packages/worker/src/status.ts does, and
// every refusal: a DAO the worker does not watch, a rate limit, an answer that is not a token or
// whose parts disagree, an account id that is not one. Then the `kaap seal-text` stub. It does not
// run a real worker (WO-06b's live test did) or Telegram, and seal-text's encryption does not exist
// yet.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Core } from '../src/core.js';
import { main, SEAL_TEXT_NOT_YET } from '../src/main.js';
import type { HttpRequest, HttpResponse } from '../src/net.js';
import { fakeClock, REPO_ROOT } from './replay.js';

const DAO = 'kaap-dao-1029064008.testnet';
const TOKEN = 'Wq3vB1r9Yx0fZk2LmN4pQs6tUv8wXy-AbCdEfGh_Ij4';

function workerAnswer(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    dao: DAO,
    token: TOKEN,
    expires_at: '2026-11-02T14:30:00.000Z',
    start_command: `/start ${TOKEN}`,
    telegram_link: `https://t.me/kaap_alerts_bot?start=${TOKEN}`,
    ...over,
  });
}

async function run(argv: string[], answer: HttpResponse) {
  const asked: HttpRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const transport = async (r: HttpRequest) => {
    asked.push(r);
    return answer;
  };
  const code = await main(argv, { transport, clock: fakeClock(), loadCore: () => Core.load(), repoRoot: REPO_ROOT }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n'), asked };
}

test('subscribe asks the named worker for a token and prints it with the bot steps', async () => {
  const { code, out, asked } = await run(['subscribe', DAO, '--worker', 'https://kaap.example.com/'], { status: 200, text: workerAnswer() });
  assert.equal(code, 0);
  assert.deepEqual(asked.map((r) => [r.method, r.url, r.body]), [['POST', 'https://kaap.example.com/subscribe', JSON.stringify({ dao: DAO })]]);
  assert.match(out, new RegExp(`^one-time token, valid until 2026-11-02T14:30:00.000Z: ${TOKEN}$`, 'm'));
  assert.match(out, new RegExp(`Open https://t\\.me/kaap_alerts_bot\\?start=${TOKEN}`));
  assert.match(out, new RegExp(`Send: /start ${TOKEN}$`, 'm'));
});

test('a DAO the worker does not watch exits 3, and a rate limit exits 1 with the wait', async () => {
  const notWatched = await run(['subscribe', DAO, '--worker', 'https://kaap.example.com'], { status: 404, text: '{"error":"not_enrolled"}' });
  assert.equal(notWatched.code, 3);
  assert.match(notWatched.err, /does not watch kaap-dao-1029064008\.testnet: only an enrolled DAO has alerts/);
  const limited = await run(['subscribe', DAO, '--worker', 'https://kaap.example.com'], { status: 429, text: '{"error":"too_many_requests"}', retryAfterMs: 1_800_000 });
  assert.equal(limited.code, 1);
  assert.match(limited.err, /too many token requests from this address, again in about 30 minutes/);
});

test('a worker answer that is not a token, or whose parts disagree, is refused and not shown', async () => {
  for (const over of [
    { token: 'short' },
    { telegram_link: `https://evil.example/kaap_alerts_bot?start=${TOKEN}` },
    { start_command: '/start someone-elses-token' },
    { dao: 'other.sputnik-dao.near' },
    { extra: 'field' },
  ]) {
    const { code, out, err } = await run(['subscribe', DAO, '--worker', 'https://kaap.example.com'], { status: 200, text: workerAnswer(over) });
    assert.equal(code, 1, JSON.stringify(over));
    assert.equal(out, '');
    assert.match(err, /^the worker's answer (is not a subscription token|does not hold together)/);
  }
});

test('an invalid account id is refused before the worker is asked', async () => {
  const { code, asked } = await run(['subscribe', 'Not An Account', '--worker', 'https://kaap.example.com'], { status: 200, text: workerAnswer() });
  assert.equal(code, 3);
  assert.equal(asked.length, 0);
});

test('seal-text is a stub: it says it is not available, reads nothing and sends nothing', async () => {
  const { code, out, err, asked } = await run(['seal-text', '--dao', DAO, '--id', '7', '--file', '/no/such/file.json'], { status: 200, text: '' });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.equal(err, SEAL_TEXT_NOT_YET);
  assert.equal(asked.length, 0);
});
