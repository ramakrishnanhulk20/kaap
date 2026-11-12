// Where one of the demo's filings stands, read fresh from the treasury, the registry and Kaap's
// watcher:  GET /api/demo/status?id=<n>
//
// The page asks every three seconds while a filing is in flight. Each answer is kept for a second
// and a half, so many viewers of one filing cost one read, and a caller gets 90 asks a minute.
import { NextResponse } from 'next/server';
import { callerOf } from '@/lib/caller';
import { DemoRefused, type DemoStatus, demoStatus } from '@/lib/demo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ASKS_PER_MINUTE = 90;
const KEEP_MS = 1_500;
const MAX_KEPT = 100;

const recent = new Map<string, number[]>();
const kept = new Map<number, { at: number; status: DemoStatus }>();

const refuse = (status: number, reason: string, message: string) => NextResponse.json({ ok: false, reason, message }, { status });

function allowed(caller: string, now: number): boolean {
  const asks = (recent.get(caller) ?? []).filter((at) => now - at < 60_000);
  if (asks.length >= ASKS_PER_MINUTE) {
    recent.set(caller, asks);
    return false;
  }
  asks.push(now);
  recent.set(caller, asks);
  if (recent.size > 5_000) for (const [key, times] of recent) if (times.every((at) => now - at >= 60_000)) recent.delete(key);
  return true;
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) return refuse(400, 'bad_id', 'A request number is a whole number.');
  const id = Number(raw);
  const now = Date.now();
  const hit = kept.get(id);
  if (hit && now - hit.at < KEEP_MS) return NextResponse.json({ ok: true, ...hit.status });
  const caller = callerOf(request);
  if (!allowed(caller, now)) return refuse(429, 'slow_down', 'That is a lot of asks. Try again in a minute.');
  try {
    const status = await demoStatus(id);
    if (kept.size >= MAX_KEPT) kept.clear();
    kept.set(id, { at: Date.now(), status });
    return NextResponse.json({ ok: true, ...status });
  } catch (error) {
    if (error instanceof DemoRefused) return refuse(503, error.reason, error.message);
    console.error('demo status failed', error instanceof Error ? error.name : 'unknown');
    return refuse(500, 'failed', 'The status could not be read.');
  }
}
