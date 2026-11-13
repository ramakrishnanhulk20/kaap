'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import proof from '@/data/proof.json';
import { STOPPED_THEFT, transactionLink } from '@/lib/links';
import './tryit.css';

interface Status {
  found: boolean;
  status: string | null;
  submittedMs: number | null;
  rejectedByGuard: boolean;
  verdict: { risk: string; floor: string; findings: string[]; aiStatus: string | null } | null;
  recorded: boolean;
  txs: { run: string | null; veto: string | null; record: string | null };
  vetoWait: string | null;
  watcher: 'answered' | 'silent' | 'none';
  runs: number;
  judging: string | null;
}

type Phase =
  | { name: 'idle' }
  | { name: 'filing' }
  | { name: 'watching'; id: number; filedTx: string | null; already: boolean; pressedAt: number }
  | { name: 'refused'; message: string };

const POLL_MS = 3_000;
/** After this long with no reject the page stops asking and says so. */
const GIVE_UP_MS = 180_000;
/** The same, once the watcher is known to be asking the sealed reader again: its host can take
 *  minutes to answer when it is busy, and the watcher asks for as long as the request is open. */
const SLOW_GIVE_UP_MS = 12 * 60_000;

const dao = proof.treasury.account;
const said = proof.tryIt?.description ?? '';
const paid = proof.tryIt?.kind.Transfer.receiver_id ?? '';

function Knot({ state }: { state: 'done' | 'now' | 'wait' }) {
  return (
    <span className="kc-try-knot" data-state={state} aria-hidden="true">
      {state === 'done' ? (
        <svg viewBox="0 0 16 16">
          <path d="M3.5 8.5 L6.6 11.5 L12.5 4.8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * One press files a real, prepared fake theft on the demo treasury, and the page then shows each
 * step as it lands on chain. Every line comes from /api/demo/status, which reads the treasury,
 * the registry and Kaap's watcher.
 */
export default function TryIt() {
  const [on, setOn] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [status, setStatus] = useState<Status | null>(null);
  const [now, setNow] = useState(0);
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const slow = useRef(false);

  useEffect(() => {
    fetch('/api/demo/attack')
      .then((res) => res.json())
      .then((body) => setOn(body.on === true))
      .catch(() => setOn(false));
  }, []);

  const watchingId = phase.name === 'watching' ? phase.id : null;
  const pressedAt = phase.name === 'watching' ? phase.pressedAt : 0;
  const finished = status !== null && status.rejectedByGuard && status.recorded;

  useEffect(() => {
    if (watchingId === null || finished || gaveUp) return;
    let live = true;
    const ask = async () => {
      try {
        const body = await (await fetch(`/api/demo/status?id=${watchingId}`)).json();
        if (!live || !body.ok) return;
        setStatus(body as Status);
        // No verdict yet, and the watcher has asked more than once or says a run failed.
        slow.current = body.verdict == null && (body.runs >= 2 || body.judging === 'failed');
        if (body.rejectedByGuard) setStoppedAt((at) => at ?? Date.now());
      } catch {
        // The next ask may get through. The clock below keeps running either way.
      }
    };
    void ask();
    const poll = setInterval(() => {
      if (Date.now() - pressedAt > (slow.current ? SLOW_GIVE_UP_MS : GIVE_UP_MS)) setGaveUp(true);
      else void ask();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [watchingId, pressedAt, finished, gaveUp]);

  useEffect(() => {
    if (watchingId === null || stoppedAt !== null || gaveUp) return;
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, [watchingId, stoppedAt, gaveUp]);

  const press = async () => {
    setPhase({ name: 'filing' });
    setStatus(null);
    setStoppedAt(null);
    setGaveUp(false);
    slow.current = false;
    try {
      const res = await fetch('/api/demo/attack', { method: 'POST', headers: { 'x-kaap-demo': '1' } });
      const body = await res.json();
      if (body.ok) {
        setNow(Date.now());
        setPhase({ name: 'watching', id: body.id, filedTx: body.tx ?? null, already: body.already === true, pressedAt: Date.now() });
        requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      } else {
        setPhase({ name: 'refused', message: String(body.message) });
      }
    } catch {
      setPhase({ name: 'refused', message: 'The button could not reach the site. Nothing was filed.' });
    }
  };

  // The chain's own time for the filing once it is known, else the moment of the press.
  const filedAt = status?.submittedMs ?? pressedAt;
  const seconds = (until: number) => Math.max(0, Math.round((until - filedAt) / 1000));
  const read = status?.verdict != null;
  const rejected = status?.rejectedByGuard === true;
  const recorded = status?.recorded === true;
  const askingAgain = !read && status != null && (status.runs >= 2 || status.judging === 'failed');
  const stateOf = (done: boolean, before: boolean): 'done' | 'now' | 'wait' => (done ? 'done' : before && !gaveUp ? 'now' : 'wait');

  return (
    <section className="kc-try" id="try">
      <div className="kc-try-inner">
        <span className="kc-try-thread" aria-hidden="true" />
        <p className="toy-label">Try it yourself</p>
        <h2 className="kc-try-title">File a fake theft. Watch Kaap stop it.</h2>
        <p className="kc-try-lede">
          One press files a real request on the demo treasury, on NEAR testnet. It says <q>{said}</q> and it pays{' '}
          <code>{paid}</code>. Nobody tells Kaap. Its watcher has to notice the request, have it read inside sealed
          hardware, and get the guard to reject it.
        </p>

        {on === false ? (
          <p className="kc-try-note">
            The live demo is not switched on here. <Link href={STOPPED_THEFT}>The recorded one</Link> works at any time.
          </p>
        ) : (
          <div className="kc-try-go">
            <button type="button" className="toy-btn toy-btn--main" onClick={press} disabled={on === null || phase.name === 'filing' || (phase.name === 'watching' && !finished && !gaveUp)}>
              {phase.name === 'filing' ? 'Filing it on testnet' : phase.name === 'watching' && (finished || gaveUp) ? 'File another' : 'File the fake theft'}
            </button>
            <p className="kc-try-small">
              Testnet only, no wallet. The key this page files with can do one thing: file a request on this one treasury.
            </p>
          </div>
        )}

        {phase.name === 'refused' ? (
          <p className="kc-try-note" role="alert">
            <b>Not filed.</b> {phase.message}
          </p>
        ) : null}

        {phase.name === 'watching' ? (
          <div className="kc-try-sheet" ref={panel} aria-live="polite">
            <p className="kc-try-top">
              <span>
                Request #{phase.id} &middot; {dao}
              </span>
              <span className="kc-try-clock">
                {rejected && stoppedAt !== null ? `stopped after about ${seconds(stoppedAt)} s` : gaveUp ? 'no answer yet' : `${seconds(now)} s since it was filed`}
              </span>
            </p>
            {phase.already ? <p className="kc-try-small">Someone filed one a moment ago, so you are watching theirs.</p> : null}

            <ol className="kc-try-steps">
              <li data-state="done">
                <Knot state="done" />
                <div>
                  <p className="kc-try-step">Filed on the demo treasury</p>
                  <p className="kc-try-detail">
                    {phase.filedTx ? (
                      <a className="kc-link" href={transactionLink(phase.filedTx)} target="_blank" rel="noreferrer">
                        The filing, on the explorer
                      </a>
                    ) : (
                      'By the demo member, with a key that can only file.'
                    )}
                  </p>
                </div>
              </li>
              <li data-state={stateOf(read, true)}>
                <Knot state={stateOf(read, true)} />
                <div>
                  <p className="kc-try-step">Read inside sealed hardware</p>
                  <p className="kc-try-detail">
                    {read && status?.txs.run ? (
                      <a className="kc-link" href={transactionLink(status.txs.run)} target="_blank" rel="noreferrer">
                        The sealed run, on the explorer
                      </a>
                    ) : read ? (
                      'Done.'
                    ) : askingAgain ? (
                      "The sealed reader's host did not answer in time. Kaap's watcher is asking again, which can take a few minutes when that host is busy."
                    ) : (
                      'The watcher has to notice it first. The read usually takes 20 to 60 seconds.'
                    )}
                  </p>
                </div>
              </li>
              <li data-state={stateOf(read, false)}>
                <Knot state={stateOf(read, false)} />
                <div>
                  <p className="kc-try-step">Verdict</p>
                  {status?.verdict ? (
                    <p className="kc-try-detail">
                      <span className="kc-try-risk" data-risk={status.verdict.risk}>
                        {status.verdict.risk}
                      </span>{' '}
                      {status.verdict.findings.join(', ')}.{' '}
                      {status.verdict.aiStatus === 'verified'
                        ? 'The AI answered and its answer was verified.'
                        : status.verdict.aiStatus === 'unverified'
                          ? 'The AI answered, but its answer could not be verified, so it was not relied on.'
                          : 'The AI did not answer in time. Plain code decided.'}
                    </p>
                  ) : (
                    <p className="kc-try-detail">Signed by the sealed reader, or not given at all.</p>
                  )}
                </div>
              </li>
              <li data-state={stateOf(rejected, read)}>
                <Knot state={stateOf(rejected, read)} />
                <div>
                  <p className="kc-try-step">Guard votes to reject</p>
                  <p className="kc-try-detail">
                    {rejected && status?.txs.veto ? (
                      <a className="kc-link" href={transactionLink(status.txs.veto)} target="_blank" rel="noreferrer">
                        The guard&apos;s vote, on the explorer
                      </a>
                    ) : rejected ? (
                      'Rejected by the guard alone.'
                    ) : status?.vetoWait === 'held' ? (
                      'The watcher is holding the vote: one of its two data providers did not answer, and it will not act on one alone. It keeps trying until the verdict expires.'
                    ) : (
                      'One vote, from a contract that can cast no other.'
                    )}
                  </p>
                </div>
              </li>
              <li data-state={stateOf(recorded, rejected)}>
                <Knot state={stateOf(recorded, rejected)} />
                <div>
                  <p className="kc-try-step">Verdict recorded for anyone to check</p>
                  <p className="kc-try-detail">
                    {recorded && status?.txs.record ? (
                      <a className="kc-link" href={transactionLink(status.txs.record)} target="_blank" rel="noreferrer">
                        The record, on the explorer
                      </a>
                    ) : recorded ? (
                      'In the registry contract.'
                    ) : (
                      'In the registry contract, append-only.'
                    )}
                  </p>
                </div>
              </li>
            </ol>

            {rejected ? (
              <p className="kc-try-end">
                <b>Rejected.</b> The request is closed and nothing was paid.{' '}
                <Link href={`/check?dao=${dao}&network=${proof.network}&id=${phase.id}`}>Read request #{phase.id} yourself</Link>, or check
                the verdict with no keys: <code>kaap verify {dao} {phase.id}</code>
              </p>
            ) : null}
            {gaveUp && !rejected ? (
              <p className="kc-try-end" role="alert">
                <b>No reject after {askingAgain ? 'twelve' : 'three'} minutes.</b> The request is still open and nothing was approved: only the
                treasury&apos;s own approvers could do that.{' '}
                {askingAgain ? "The sealed reader's host has not answered Kaap's watcher, which keeps asking while the request is open. " : ''}
                {status?.watcher === 'silent' ? "Kaap's watcher did not answer when asked. " : ''}
                <Link href={STOPPED_THEFT}>The recorded run</Link> shows the same steps.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
