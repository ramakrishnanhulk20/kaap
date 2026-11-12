// The "try it yourself" button.
//   GET  /api/demo/attack   whether this host can file: {on}
//   POST /api/demo/attack   files the prepared fake theft on the demo treasury: {ok, id, tx, already}
//
// A press costs Kaap a sealed run, so it is bounded: two presses in ten minutes per caller here,
// and in lib/demo.ts one filing in flight at a time and a daily count read from the chain. The
// POST must carry the header x-kaap-demo, which a page on another site cannot send without this
// route's leave, so no other site can press the button through its visitors' browsers.
import { NextResponse } from 'next/server';
import { callerOf } from '@/lib/caller';
import { DemoRefused, demoIsOn, fileFakeTheft } from '@/lib/demo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PRESSES = 2;
const WINDOW_MS = 10 * 60_000;
const recent = new Map<string, number[]>();

const refuse = (status: number, reason: string, message: string) => NextResponse.json({ ok: false, reason, message }, { status });

function allowed(caller: string, now: number): boolean {
  const presses = (recent.get(caller) ?? []).filter((at) => now - at < WINDOW_MS);
  if (presses.length >= PRESSES) {
    recent.set(caller, presses);
    return false;
  }
  presses.push(now);
  recent.set(caller, presses);
  if (recent.size > 5_000) for (const [key, times] of recent) if (times.every((at) => now - at >= WINDOW_MS)) recent.delete(key);
  return true;
}

export function GET() {
  return NextResponse.json({ on: demoIsOn() });
}

export async function POST(request: Request) {
  if (request.headers.get('x-kaap-demo') !== '1') return refuse(400, 'bad_request', 'This button is pressed from the check page.');
  if (!demoIsOn()) return refuse(503, 'off', 'The live demo is not switched on here.');
  const caller = callerOf(request);
  if (!allowed(caller, Date.now())) return refuse(429, 'slow_down', 'That is two already. Try again in ten minutes, or read the recorded one.');
  try {
    return NextResponse.json({ ok: true, ...(await fileFakeTheft()) });
  } catch (error) {
    if (error instanceof DemoRefused) return refuse(error.reason === 'daily_cap' ? 429 : 503, error.reason, error.message);
    console.error('demo attack failed', error instanceof Error ? error.name : 'unknown');
    return refuse(500, 'failed', 'The request could not be filed. Nothing was decided.');
  }
}
