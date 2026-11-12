// One keyless check of one proposal, as JSON.
//   GET  /api/check?dao=<account>&network=mainnet|testnet[&id=<n>]
//   POST /api/check  {dao, network, id?, text: {message, nonce, recipient, standard}}
// The POST form also hands Kaap a text said to be behind the proposal's signed hash.
//
// Anyone can call this, so it is bounded: a few calls a minute per caller, two at a time in all,
// and the same plain question within 20 seconds is answered from memory. Those bounds live in
// this process; on a host that runs several, each has its own.

import { NextResponse } from 'next/server';
import { type CheckAnswer, type CheckAsk, CheckRefused, type SuppliedText, runCheck } from '@/lib/kaapCheck';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// A NEAR account id: 2 to 64 of lowercase letters, digits and single separators.
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([._-][a-z0-9]+)*$/;
// Base64 of exactly 32 bytes.
const NONCE = /^[A-Za-z0-9+/]{43}=$/;
const MAX_PROPOSAL_ID = 2 ** 53 - 1;
const MAX_TEXT_CHARS = 20_000;
const MAX_BODY_CHARS = 30_000;

const CALLS_PER_MINUTE = 8;
const AT_ONCE = 2;
const KEEP_MS = 20_000;
const MAX_KEPT = 200;

const recent = new Map<string, number[]>();
const kept = new Map<string, { at: number; answer: CheckAnswer }>();
let running = 0;

const refuse = (status: number, reason: string, message: string) => NextResponse.json({ ok: false, reason, message }, { status });

function allowed(caller: string, now: number): boolean {
  const calls = (recent.get(caller) ?? []).filter((at) => now - at < 60_000);
  if (calls.length >= CALLS_PER_MINUTE) {
    recent.set(caller, calls);
    return false;
  }
  calls.push(now);
  recent.set(caller, calls);
  if (recent.size > 5_000) for (const [key, times] of recent) if (times.every((at) => now - at >= 60_000)) recent.delete(key);
  return true;
}

/** The question, checked, or the answer that refuses it. */
function asked(dao: unknown, network: unknown, id: unknown): CheckAsk | NextResponse {
  const account = typeof dao === 'string' ? dao.trim().toLowerCase() : '';
  if (!ACCOUNT.test(account)) return refuse(400, 'bad_account', 'That is not a NEAR account name.');
  if (network !== 'mainnet' && network !== 'testnet') return refuse(400, 'bad_network', 'The network is mainnet or testnet.');
  if (id === null || id === undefined || id === '') return { dao: account, network, id: null };
  const digits = typeof id === 'number' ? String(id) : id;
  if (typeof digits !== 'string' || !/^\d{1,16}$/.test(digits) || Number(digits) > MAX_PROPOSAL_ID) {
    return refuse(400, 'bad_id', 'A request number is a whole number.');
  }
  return { dao: account, network, id: Number(digits) };
}

function suppliedText(text: unknown): SuppliedText | NextResponse {
  const t = (typeof text === 'object' && text !== null ? text : {}) as Record<string, unknown>;
  if (typeof t.message !== 'string' || t.message.length === 0 || t.message.length > MAX_TEXT_CHARS) {
    return refuse(400, 'bad_text', `The text must be between 1 and ${MAX_TEXT_CHARS} characters.`);
  }
  if (typeof t.nonce !== 'string' || !NONCE.test(t.nonce)) return refuse(400, 'bad_nonce', 'The nonce is 32 bytes written in base64.');
  if (typeof t.recipient !== 'string' || !ACCOUNT.test(t.recipient)) return refuse(400, 'bad_recipient', 'The recipient is not a NEAR account name.');
  if (t.standard !== 'nep413' && t.standard !== 'nep461') return refuse(400, 'bad_standard', 'The standard is nep413 or nep461.');
  return { message: t.message, nonce: t.nonce, recipient: t.recipient, standard: t.standard };
}

async function answer(request: Request, ask: CheckAsk): Promise<NextResponse> {
  const now = Date.now();
  // A reading with a supplied text is never kept: the text is the caller's own.
  const key = ask.text ? null : `${ask.network}/${ask.dao}/${ask.id ?? 'latest'}`;
  const hit = key === null ? undefined : kept.get(key);
  if (hit && now - hit.at < KEEP_MS) return NextResponse.json({ ok: true, ...hit.answer });

  const caller = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!allowed(caller, now)) return refuse(429, 'slow_down', 'That is a lot of checks. Try again in a minute.');
  if (running >= AT_ONCE) return refuse(503, 'busy', 'Kaap is reading for someone else. Try again in a few seconds.');

  running += 1;
  try {
    const result = await runCheck(ask);
    if (key !== null) {
      if (kept.size >= MAX_KEPT) kept.clear();
      kept.set(key, { at: Date.now(), answer: result });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CheckRefused) {
      const status = error.reason === 'not_a_dao' || error.reason === 'no_proposal' ? 404 : 502;
      return refuse(status, error.reason, error.message);
    }
    console.error('check failed', error);
    return refuse(500, 'failed', 'The check could not run. Nothing was decided.');
  } finally {
    running -= 1;
  }
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const ask = asked(query.get('dao'), query.get('network'), query.get('id'));
  return ask instanceof NextResponse ? ask : answer(request, ask);
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return refuse(413, 'too_large', 'That is too much text for one check.');
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, 'bad_body', 'The request was not JSON.');
  }
  const ask = asked(body.dao, body.network, body.id);
  if (ask instanceof NextResponse) return ask;
  const text = suppliedText(body.text);
  if (text instanceof NextResponse) return text;
  return answer(request, { ...ask, text });
}
