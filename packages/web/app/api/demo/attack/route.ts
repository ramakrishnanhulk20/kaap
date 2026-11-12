// The "try it yourself" button.
//   GET  /api/demo/attack   whether this host can file: {on}
//   POST /api/demo/attack   files the prepared fake theft on the demo treasury: {ok, id, tx, already}
//
// A press costs Kaap a sealed run, so it is bounded: two presses in ten minutes and six in a day
// per caller (lib/presses.ts), and in lib/demo.ts one filing in flight at a time and a daily
// count read from the chain. The
// POST must carry the header x-kaap-demo, which a page on another site cannot send without this
// route's leave, so no other site can press the button through its visitors' browsers.
import { NextResponse } from 'next/server';
import { callerOf } from '@/lib/caller';
import { DemoRefused, demoIsOn, fileFakeTheft } from '@/lib/demo';
import { press } from '@/lib/presses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const recent = new Map<string, number[]>();

const refuse = (status: number, reason: string, message: string) => NextResponse.json({ ok: false, reason, message }, { status });

export function GET() {
  return NextResponse.json({ on: demoIsOn() });
}

export async function POST(request: Request) {
  if (request.headers.get('x-kaap-demo') !== '1') return refuse(400, 'bad_request', 'This button is pressed from the check page.');
  if (!demoIsOn()) return refuse(503, 'off', 'The live demo is not switched on here.');
  const caller = callerOf(request);
  const may = press(recent, caller, Date.now());
  if (may === 'slow_down') return refuse(429, 'slow_down', 'That is two already. Try again in ten minutes, or read the recorded one.');
  if (may === 'day_used') return refuse(429, 'day_used', 'That is six today from this address, which is its share. The recorded one works at any time.');
  try {
    return NextResponse.json({ ok: true, ...(await fileFakeTheft()) });
  } catch (error) {
    if (error instanceof DemoRefused) return refuse(error.reason === 'daily_cap' ? 429 : 503, error.reason, error.message);
    console.error('demo attack failed', error instanceof Error ? error.name : 'unknown');
    return refuse(500, 'failed', 'The request could not be filed. Nothing was decided.');
  }
}
