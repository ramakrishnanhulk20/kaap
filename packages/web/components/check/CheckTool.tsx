'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { CheckAnswer, CheckReport, Network, SuppliedText } from '@/lib/kaapCheck';
import { plainEffect } from '@/lib/plainEffect';
import proof from '@/data/proof.json';
import './check.css';

type State =
  | { phase: 'idle' }
  | { phase: 'reading'; dao: string }
  | { phase: 'answer'; answer: CheckAnswer }
  | { phase: 'refused'; message: string };

const tone = (severity: string): CSSProperties =>
  ({ '--tone': `var(--${['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'unknown'})` }) as CSSProperties;

// A block time arrives as nanoseconds in a decimal string, too large for a JavaScript number.
const blockTime = (nanoseconds: string) =>
  `${new Date(Number(BigInt(nanoseconds) / 1_000_000n)).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const shownValue = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

function verdictWords(report: CheckReport): string {
  const { must_veto: mustVeto, veto_allowed: vetoAllowed } = report.analysis;
  if (mustVeto && vetoAllowed) return "Kaap's guard must veto this.";
  if (mustVeto) return 'Kaap would veto this, but the guard role cannot reject this kind of request.';
  if (vetoAllowed) return 'The guard may veto this, if the sealed reader finds it is a theft.';
  return 'The guard will not veto this. Members decide.';
}

function Lantern() {
  return (
    <svg viewBox="0 0 64 96" aria-hidden="true">
      <circle cx="32" cy="9" r="6" fill="none" stroke="#c9942e" strokeWidth="3.4" />
      <path d="M22 26 L27 16 H37 L42 26 Z" fill="#c9942e" />
      <path d="M21 26 Q11 48 22 70 H42 Q53 48 43 26 Z" fill="#ffd45e" />
      <path d="M26 30 Q19 48 27 66 H37 Q45 48 38 30 Z" fill="#fff3c2" />
      <path d="M19 70 H45 L48 82 H16 Z" fill="#c9942e" />
      <rect x="14" y="82" width="36" height="6" rx="3" fill="#a77a22" />
    </svg>
  );
}

/** The four transactions of the saved proof run, shown under the request they belong to. */
function Trail() {
  const { stopped } = proof;
  const steps = [
    { name: 'Filed by a member', tx: stopped.filedTx },
    { name: 'Read in sealed hardware', tx: stopped.sealedTx },
    { name: 'Verdict recorded', tx: stopped.recordedTx },
    { name: 'Guard voted to reject', tx: stopped.vetoTx },
  ];
  return (
    <div className="kc-trail">
      <p className="kc-part">What happened to it</p>
      <p className="kc-trail-words">
        It said one thing and paid the lookalike account {stopped.paid} Kaap&apos;s guard rejected it{' '}
        <b>{stopped.seconds} seconds</b> after it was filed.
      </p>
      <ol>
        {steps.map((step) => (
          <li key={step.tx}>
            <a className="kc-link" href={`https://testnet.nearblocks.io/txns/${step.tx}`} target="_blank" rel="noreferrer">
              {step.name}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Offered under a request that shows only a hash: hand Kaap the words said to be behind it. */
function TextPanel({ report, onText }: { report: CheckReport; onText: (text: SuppliedText) => void }) {
  const [message, setMessage] = useState('');
  const [nonce, setNonce] = useState('');
  const [recipient, setRecipient] = useState('intents.near');
  const saved = proof.demoText.dao === report.dao && proof.demoText.proposalId === report.proposal_id ? proof.demoText : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onText({ message, nonce: nonce.trim(), recipient: recipient.trim().toLowerCase(), standard: 'nep413' });
  };

  return (
    <form className="kc-text" onSubmit={submit}>
      <p className="kc-part">Have the words behind this hash?</p>
      <p className="kc-fine">
        Give Kaap the message the treasury is being asked to sign. It first checks that the message hashes to the value
        above, and only then reads it.
      </p>
      <label className="kc-field">
        <span className="kc-field-name">Message</span>
        <textarea className="kc-input kc-area" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={20000} spellCheck={false} required />
      </label>
      <div className="kc-text-pair">
        <label className="kc-field">
          <span className="kc-field-name">Nonce, in base64</span>
          <input className="kc-input" value={nonce} onChange={(event) => setNonce(event.target.value)} spellCheck={false} required />
        </label>
        <label className="kc-field">
          <span className="kc-field-name">Recipient</span>
          <input className="kc-input" value={recipient} onChange={(event) => setRecipient(event.target.value)} spellCheck={false} required />
        </label>
      </div>
      <div className="kc-text-go">
        <button type="submit" className="toy-btn toy-btn--side">
          Read these words
        </button>
        {saved ? (
          <button
            type="button"
            className="toy-btn toy-btn--main"
            onClick={() => onText({ message: saved.message, nonce: saved.nonce, recipient: saved.recipient, standard: saved.standard as SuppliedText['standard'] })}
          >
            Use the words saved for this demo request
          </button>
        ) : null}
      </div>
    </form>
  );
}

function Answer({ answer, onStep, onText }: { answer: CheckAnswer; onStep: (id: number) => void; onText: (text: SuppliedText) => void }) {
  const { report, decimals } = answer;
  const { analysis } = report;
  const hashOnly = analysis.effects.some((effect) => effect.type === 'sign_request' && effect.text_supplied !== true);
  const stoppedHere = report.network === proof.network && report.dao === proof.treasury.account && report.proposal_id === proof.stopped.proposalId;
  const reasons = [
    ...report.description_reasons.contradictions.map((why) => ({ kind: 'Contradicts', why })),
    ...report.description_reasons.agreements.map((why) => ({ kind: 'Agrees', why })),
  ];

  return (
    <article className="kc-sheet" aria-live="polite">
      <div className="kc-sheet-body">
        <p className="kc-top">
          <span>
            Proposal #{report.proposal_id} &middot; {report.dao}
          </span>
          <span>
            {report.status} &middot; {report.network}
          </span>
        </p>

        <p className="kc-part">What it says</p>
        <p className="kc-says">{report.description ? <>&ldquo;{report.description}&rdquo;</> : 'Nothing. It has no description.'}</p>

        <p className="kc-part">What it will do</p>
        <div className="kc-effects">
          {analysis.effects.length === 0 ? <p className="kc-effect">Kaap could not name an effect for this request.</p> : null}
          {analysis.effects.map((effect, index) => {
            const sentence = plainEffect(effect, decimals);
            const fields = Object.entries(effect).filter(([name, value]) => name !== 'type' && value !== null);
            return (
              <div className="kc-effect" key={index}>
                {sentence ?? <span className="kc-effect-kind">{shownValue(effect.type).replaceAll('_', ' ')}</span>}
                {fields.length > 0 ? (
                  <details className="kc-effect-fields" open={sentence === null}>
                    <summary>The exact fields</summary>
                  <dl>
                    {fields.map(([name, value]) => (
                      <div key={name} style={{ display: 'contents' }}>
                        <dt>{name.replaceAll('_', ' ')}</dt>
                        <dd>{shownValue(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="kc-part">What Kaap found</p>
        <div className="kc-findings">
          {analysis.findings.length === 0 ? <span className="kc-fine">Nothing to flag.</span> : null}
          {analysis.findings.map((finding) => (
            <span className="kc-finding" key={finding.code} style={tone(finding.severity)}>
              {finding.code} &middot; {finding.severity}
            </span>
          ))}
        </div>

        <div className="kc-verdict">
          <span className="kc-risk" style={tone(analysis.risk_floor)}>
            {analysis.risk_floor}
          </span>
          <span className="kc-verdict-words">{verdictWords(report)}</span>
        </div>
        <p className="kc-fine">
          Does the description match what it does? <b>{analysis.description_check.replaceAll('_', ' ')}</b>.
          {reasons.map((reason) => (
            <span key={reason.kind + reason.why}>
              {' '}
              {reason.kind}: {reason.why}
            </span>
          ))}
        </p>
        <p className="kc-fine">This is the plain-code check only. The AI and the guard run in Kaap&apos;s sealed program.</p>

        {stoppedHere ? <Trail /> : null}
        {hashOnly ? <TextPanel report={report} onText={onText} /> : null}

        <details className="kc-details">
          <summary>How this was read</summary>
          <dl>
            <dt>Block</dt>
            <dd>
              {report.block.height}, final, {blockTime(report.block.timestamp_ns)}
            </dd>
            <dt>Agreed by</dt>
            <dd>{report.providers.join(' and ')}</dd>
            <dt>Treasury code</dt>
            <dd>
              Sputnik DAO {report.dao_version}, {report.code_hash}
            </dd>
            <dt>Request hash</dt>
            <dd>{report.kind_hash}</dd>
            <dt>Filed by</dt>
            <dd>{report.proposer}</dd>
            <dt>Rules before it</dt>
            <dd>{report.policy_before.source}</dd>
            <dt>Past payments</dt>
            <dd>{report.history_source}</dd>
            <dt>Prices</dt>
            <dd>{report.prices_source}</dd>
            <dt>Kaap&apos;s guard</dt>
            <dd>{report.guard_account ?? `none recorded on ${report.network}`}</dd>
          </dl>
        </details>

        <div className="kc-steps">
          <button type="button" className="kc-step" disabled={report.proposal_id === 0} onClick={() => onStep(report.proposal_id - 1)}>
            Earlier request
          </button>
          <button type="button" className="kc-step" onClick={() => onStep(report.proposal_id + 1)}>
            Later request
          </button>
        </div>
      </div>
    </article>
  );
}

/** Reads one request of any Sputnik DAO through /api/check and shows Kaap's reading of it. */
export default function CheckTool() {
  const router = useRouter();
  const asked = useSearchParams();
  const [dao, setDao] = useState(asked.get('dao') ?? '');
  const [network, setNetwork] = useState<Network>(asked.get('network') === 'testnet' ? 'testnet' : 'mainnet');
  const [id, setId] = useState(asked.get('id') ?? '');
  const [state, setState] = useState<State>({ phase: 'idle' });
  const latest = useRef(0);

  const read = useCallback(
    async (which: { dao: string; network: Network; id: string; text?: SuppliedText }) => {
      const account = which.dao.trim().toLowerCase();
      if (!account) return;
      const query = new URLSearchParams({ dao: account, network: which.network });
      if (which.id !== '') query.set('id', which.id);
      // The address bar carries the question, so an answer can be shared as a link.
      router.replace(`/check?${query}`, { scroll: false });
      const turn = ++latest.current;
      setState({ phase: 'reading', dao: account });
      try {
        const response = which.text
          ? await fetch('/api/check', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dao: account, network: which.network, id: which.id, text: which.text }),
            })
          : await fetch(`/api/check?${query}`);
        const body = await response.json();
        if (turn !== latest.current) return;
        if (body.ok) setState({ phase: 'answer', answer: { report: body.report, decimals: body.decimals ?? {} } });
        else setState({ phase: 'refused', message: String(body.message) });
      } catch {
        if (turn === latest.current) setState({ phase: 'refused', message: 'The check could not be reached. Nothing was decided.' });
      }
    },
    [router],
  );

  // A link that already names a treasury is read at once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (asked.get('dao')) void read({ dao: asked.get('dao') ?? '', network: asked.get('network') === 'testnet' ? 'testnet' : 'mainnet', id: asked.get('id') ?? '' });
  }, [asked, read]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void read({ dao, network, id });
  };

  const tryDemo = () => {
    const demo = { dao: proof.demoText.dao, network: proof.network as Network, id: String(proof.demoText.proposalId) };
    setDao(demo.dao);
    setNetwork(demo.network);
    setId(demo.id);
    void read(demo);
  };

  const step = (next: number) => {
    setId(String(next));
    void read({ dao, network, id: String(next) });
  };

  return (
    <section className="kc">
      <div className="kc-inner">
        <p className="toy-label">Check a treasury</p>
        <h1 className="kc-title">What is your treasury about to sign?</h1>
        <p className="kc-lede">
          Name any Sputnik DAO on NEAR. Kaap reads its latest request at the newest final block, from two providers, and
          tells you what it will really do. No wallet, no sign-in.
        </p>

        <form className="kc-form" onSubmit={submit}>
          <label className="kc-field kc-field--wide">
            <span className="kc-field-name">Treasury account</span>
            <input
              className="kc-input"
              value={dao}
              onChange={(event) => setDao(event.target.value)}
              placeholder="your-treasury.sputnik-dao.near"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              required
            />
          </label>
          <div className="kc-field">
            <span className="kc-field-name">Network</span>
            <div className="kc-net" role="group" aria-label="Network">
              {(['mainnet', 'testnet'] as const).map((name) => (
                <button key={name} type="button" aria-pressed={network === name} onClick={() => setNetwork(name)}>
                  {name === 'mainnet' ? 'Mainnet' : 'Testnet'}
                </button>
              ))}
            </div>
          </div>
          <label className="kc-field">
            <span className="kc-field-name">Request no.</span>
            <input
              className="kc-input"
              value={id}
              onChange={(event) => setId(event.target.value.replace(/\D/g, '').slice(0, 16))}
              placeholder="latest"
              inputMode="numeric"
            />
          </label>
          <button type="submit" className="toy-btn toy-btn--main kc-go" disabled={state.phase === 'reading'}>
            Read it
          </button>
        </form>

        <p className="kc-tries">
          <span>No treasury to hand?</span>
          <button type="button" className="kc-link" onClick={tryDemo}>
            Read the demo treasury&apos;s hash-only request
          </button>
        </p>

        {state.phase === 'reading' ? (
          <p className="kc-wait" role="status">
            <Lantern />
            <span>
              Reading {state.dao} at the newest final block, from two providers.
              <br />
              This takes about five seconds.
            </span>
          </p>
        ) : null}
        {state.phase === 'refused' ? (
          <p className="kc-note" role="alert">
            <b>No reading.</b>
            {state.message}
          </p>
        ) : null}
        {state.phase === 'answer' ? (
          <Answer
            answer={state.answer}
            onStep={step}
            onText={(text) => void read({ dao: state.answer.report.dao, network: state.answer.report.network, id: String(state.answer.report.proposal_id), text })}
          />
        ) : null}
      </div>
    </section>
  );
}
