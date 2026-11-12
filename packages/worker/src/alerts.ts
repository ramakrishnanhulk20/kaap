// Member alerts by Telegram (C24, C27).
//
// Text: every message is built only from fields Kaap has validated (an account id, a proposal
// number, a risk level, finding codes, a health signal) and from Kaap's own fixed sentences. No
// description, memo or other free text a proposer wrote is ever put in a message. Account ids are
// checked against NEAR's rule and shown with their dots as "[.]", so none can read as a web
// address (a NEAR name such as "claim.tg" ends in a real country domain); the only link is the
// one Kaap builds to its own site. A last pass removes control, format, private-use and
// unassigned characters, which covers zero-width and text-direction tricks.
//
// Sending: a critical verdict, a veto cast, a veto that did not land, a lost veto and "guard
// offline" go at once, each cause once. Everything else waits in a batch per DAO and per proposer
// (health changes batch per DAO), so a flood of proposals from one account becomes one message.
// Batched messages are capped per chat per hour; urgent ones are never capped or delayed. The queue lives in the store, so a restart loses no
// verdict, veto or notice. Health changes an earlier process left queued are dropped at boot, save
// the raising of a signal the store still keeps as raised: the new process takes those signals up
// again without a new alert, and raises again whatever else is still wrong.

import { ACCOUNT_ID } from './config.ts';
import { ALL, SAYS, levelOf, type HealthEvent, type Notice, type Signal } from './health.ts';
import type { Logger } from './log.ts';
import type { AlertRow, Store, SubscriptionRow } from './store.ts';
import { maskChat, type SendResult, type TelegramApi } from './telegram.ts';

const FINDING = /^[A-Z][A-Z_]{0,47}$/;
const RISKS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
type Risk = (typeof RISKS)[number];
/** Risks members hear about. Low is not news; unknown alerts every member (C8). */
const ALERTED: ReadonlySet<string> = new Set(['medium', 'high', 'critical', 'unknown']);
/** Telegram takes 4,096 characters; this leaves room for the closing line. */
const MAX_TEXT = 3_800;
const MAX_LINES = 10;
const HOUR = 3_600_000;
const SEND_TRIES = 5;
const RETRY_MS = 30_000;
/** Telegram allows about 30 messages a second in all; this keeps well under it. */
const SEND_GAP_MS = 50;

const STOP_LINE = 'Send /stop to stop Kaap alerts in this chat.';

/** What a lost veto's message says happened to the vote, by the veto state it was lost from. */
const LOST_AS = {
  sent: "Kaap's reject vote got no result and the proposal has now passed.",
  no_outcome: "Kaap's reject vote got no result and the proposal has now passed.",
  held: 'Kaap held its veto and the proposal has now passed.',
  capped: "A daily spending limit stopped Kaap's veto and the proposal has now passed.",
  refused: "Kaap's veto was refused and the proposal has now passed.",
  none: "The proposal passed before Kaap's veto went out.",
} as const;
type LostAs = keyof typeof LOST_AS;
const lostAs = (was: unknown): LostAs | null => (typeof was === 'string' && Object.hasOwn(LOST_AS, was) ? (was as LostAs) : null);

/** Why a veto did not land, by the veto state it ended in, as members read it. */
const FAILED_AS = {
  held: 'Kaap could not confirm the proposal on both RPC providers, or could not send its vote. It keeps trying.',
  capped: 'Kaap reached a daily spending limit. It sends the vote once the limit has room.',
  no_outcome: 'Its vote was sent but no result came back. Kaap keeps sending the same vote.',
  refused: 'The guard or the DAO refused its vote.',
} as const;
export type VetoFailure = keyof typeof FAILED_AS;

/** Removes every character of Unicode category C except the newline (controls, format characters
 *  such as zero-width spaces and joiners, text-direction overrides, the byte-order mark and soft
 *  hyphens, private-use, lone surrogates, unassigned code points) and the line and paragraph
 *  separators. Then caps the length by code point. Not covered: visible look-alike letters, which
 *  only the validated ASCII fields could carry into a message. */
export function plainText(text: string): string {
  return Array.from(text.replace(/\r\n?/g, '\n').replace(/[^\P{C}\n]|\p{Zl}|\p{Zp}/gu, ''))
    .slice(0, MAX_TEXT)
    .join('');
}

/** An account id as a member sees it, or a fixed phrase when it is not one. */
export function shownAccount(id: unknown): string {
  return typeof id === 'string' && ACCOUNT_ID.test(id) ? id.replaceAll('.', '[.]') : 'an account Kaap could not read';
}

function shownFindings(findings: unknown): string {
  const all = Array.isArray(findings) ? findings : [];
  const good = all.filter((f): f is string => typeof f === 'string' && FINDING.test(f)).slice(0, 12);
  const bad = all.length - good.length;
  const parts = [...good, ...(bad > 0 ? [`${bad} more Kaap could not read`] : [])];
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** Kaap's own page for one proposal, built from a checked DAO id and a whole-number id only. */
export function proposalLink(site: string | null, network: string, dao: string, id: number): string | null {
  if (!site || !/^(testnet|mainnet)$/.test(network) || !ACCOUNT_ID.test(dao) || !Number.isSafeInteger(id) || id < 0) return null;
  return `${site}/${network}/${dao}/${id}`;
}

export type AlertBody =
  | { t: 'verdict'; id: number; risk: Risk; findings: string[]; vetoable: boolean; proposer: string | null }
  | { t: 'veto_cast'; id: number; seconds: number | null }
  | { t: 'veto_failed'; id: number; why: VetoFailure }
  | { t: 'health'; change: 'raised' | 'cleared'; signal: Signal }
  /** `was`: for a lost veto, the veto state it was lost from; null for any other notice. */
  | { t: 'notice'; notice: Notice; id: number | null; was: LostAs | null };

/** What the worker hands the alerts. */
export interface AlertSink {
  verdict(dao: string, id: number, v: { risk: string; findings: string[]; vetoable: boolean; verdict_hash: string }, proposer: string | null): void;
  vetoCast(dao: string, id: number, seconds: number | null): void;
  vetoFailed(dao: string, id: number, why: VetoFailure): void;
}

/** Bodies read back from the store are checked again before they reach a message (T8). */
function readBody(raw: string): AlertBody | null {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof b.id === 'number' && Number.isSafeInteger(b.id) && b.id >= 0 ? b.id : null;
  if (b.t === 'verdict' && id !== null && RISKS.includes(b.risk as Risk)) {
    return { t: 'verdict', id, risk: b.risk as Risk, findings: Array.isArray(b.findings) ? (b.findings as string[]) : [], vetoable: b.vetoable === true, proposer: typeof b.proposer === 'string' ? b.proposer : null };
  }
  if (b.t === 'veto_cast' && id !== null) return { t: 'veto_cast', id, seconds: typeof b.seconds === 'number' && Number.isFinite(b.seconds) ? b.seconds : null };
  if (b.t === 'veto_failed' && id !== null && typeof b.why === 'string' && Object.hasOwn(FAILED_AS, b.why)) return { t: 'veto_failed', id, why: b.why as VetoFailure };
  if (b.t === 'health' && (b.change === 'raised' || b.change === 'cleared') && typeof b.signal === 'string' && b.signal in SAYS) return { t: 'health', change: b.change, signal: b.signal as Signal };
  if (b.t === 'notice' && (b.notice === 'counter_gap' || b.notice === 'veto_lost')) return { t: 'notice', notice: b.notice, id, was: lostAs(b.was) };
  return null;
}

/** The message for one group of alerts: one urgent alert, or one batch for a DAO. */
export function render(network: string, site: string | null, dao: string, bodies: AlertBody[]): string {
  const where = dao === ALL ? 'every DAO Kaap watches' : shownAccount(dao);
  const link = (id: number) => proposalLink(site, network, dao, id);
  const lines: string[] = [];
  const first = bodies[0];
  if (!first) return '';

  if (bodies.length === 1 && first.t === 'verdict' && first.risk === 'critical') {
    lines.push(`Kaap: CRITICAL risk on proposal ${first.id} of ${where}, filed by ${shownAccount(first.proposer)}.`);
    lines.push(`Findings: ${shownFindings(first.findings)}.`);
    // Sent before the vote's result is known, so it says only what is true now.
    lines.push(first.vetoable ? 'Kaap is sending its veto now.' : 'The guard rule does not let Kaap veto this one. Review it before anyone approves it.');
    const l = link(first.id);
    if (l) lines.push(`Details: ${l}`);
  } else if (first.t === 'veto_failed') {
    lines.push(`Kaap: could not veto proposal ${first.id} of ${where}. ${FAILED_AS[first.why]}`);
    lines.push('If you agree it is an attack, vote to reject it yourself.');
    const l = link(first.id);
    if (l) lines.push(`Details: ${l}`);
  } else if (first.t === 'veto_cast') {
    const after = first.seconds !== null ? `, ${first.seconds} s after it was filed` : '';
    lines.push(`Kaap: the guard rejected proposal ${first.id} of ${where}${after}.`);
    const l = link(first.id);
    if (l) lines.push(`Details: ${l}`);
  } else if (first.t === 'notice' && first.notice === 'veto_lost') {
    lines.push(`Kaap: veto lost on proposal ${first.id ?? '(unknown)'} of ${where}. ${LOST_AS[first.was ?? 'no_outcome']} Check the treasury now.`);
    const l = first.id !== null ? link(first.id) : null;
    if (l) lines.push(`Details: ${l}`);
  } else if (first.t === 'health' && first.change === 'raised' && levelOf(first.signal) === 'offline') {
    lines.push(`Kaap guard OFFLINE for ${where}: ${SAYS[first.signal]}`);
    lines.push('Until this clears Kaap cannot stop an attack, so check every proposal yourself.');
  } else if (first.t === 'verdict') {
    const verdicts = bodies.filter((b): b is Extract<AlertBody, { t: 'verdict' }> => b.t === 'verdict');
    const n = verdicts.length;
    lines.push(`Kaap: ${n} proposal${n === 1 ? '' : 's'} on ${where} by ${shownAccount(first.proposer)} need${n === 1 ? 's' : ''} a look.`);
    for (const v of verdicts.slice(0, MAX_LINES)) {
      const l = link(v.id);
      lines.push(`Proposal ${v.id}: ${v.risk.toUpperCase()} risk. Findings: ${shownFindings(v.findings)}.${l ? ` ${l}` : ''}`);
    }
    if (n > MAX_LINES) lines.push(`And ${n - MAX_LINES} more.`);
  } else {
    lines.push(`Kaap guard update for ${where}:`);
    let shown = 0;
    for (const b of bodies) {
      if (shown === MAX_LINES) break;
      if (b.t === 'health') lines.push(`${b.change === 'raised' ? (levelOf(b.signal) === 'offline' ? 'Offline' : 'Degraded') : 'Recovered, no longer true'}: ${SAYS[b.signal]}`);
      else if (b.t === 'notice' && b.notice === 'counter_gap') lines.push('Kaap found proposals it had not checked yet and is checking them now.');
      else continue;
      shown++;
    }
    if (bodies.length > MAX_LINES) lines.push(`And ${bodies.length - MAX_LINES} more changes.`);
  }
  lines.push(STOP_LINE);
  return plainText(lines.join('\n'));
}

export interface AlertSettings {
  network: string;
  /** Kaap's own site, the only place a link may point; null for no links. */
  siteUrl: string | null;
  batchMs: number;
  capPerHour: number;
}

export interface AlertDeps {
  store: Store;
  telegram: TelegramApi;
  log: Logger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Told when sending fails or recovers; Telegram itself cannot carry that news. */
  onDelivery?: (working: boolean) => void;
}

export class Alerts implements AlertSink {
  readonly #d: AlertDeps;
  readonly #s: AlertSettings;
  #flushing: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: AlertDeps, settings: AlertSettings) {
    this.#d = deps;
    this.#s = settings;
  }

  start(everyMs = 1_000): void {
    this.#timer = setInterval(() => void this.flush(), everyMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#flushing;
  }

  #queue(dao: string, kind: string, dedupe: string | null, urgent: boolean, batch: string, body: AlertBody): void {
    const now = this.#d.now();
    const due = urgent ? now : (this.#d.store.openBatchDue(this.#s.network, dao, batch) ?? now + this.#s.batchMs);
    const added = this.#d.store.addAlert({ network: this.#s.network, dao, kind, dedupe, urgent: urgent ? 1 : 0, batch, body: JSON.stringify(body), due_ms: due });
    if (added) this.#d.log.info('alert_queued', { dao, kind, urgent, due_in_ms: due - now });
    if (added && urgent) void this.flush();
  }

  verdict(dao: string, id: number, v: { risk: string; findings: string[]; vetoable: boolean; verdict_hash: string }, proposer: string | null): void {
    if (!ALERTED.has(v.risk)) return;
    const urgent = v.risk === 'critical';
    const body: AlertBody = { t: 'verdict', id, risk: v.risk as Risk, findings: v.findings, vetoable: v.vetoable, proposer };
    this.#queue(dao, 'verdict', `verdict:${this.#s.network}:${v.verdict_hash}`, urgent, urgent ? `proposal:${id}` : `proposer:${proposer ?? '?'}`, body);
  }

  vetoCast(dao: string, id: number, seconds: number | null): void {
    this.#queue(dao, 'veto_cast', `veto_cast:${this.#s.network}:${dao}:${id}`, true, `proposal:${id}`, { t: 'veto_cast', id, seconds });
  }

  /** A veto on a critical proposal that did not land: urgent, so never batched or capped. One
   *  cause is one alert: the same proposal held again on the next pass, or refused again on a
   *  re-judge, sends nothing more, while a new way of failing does. */
  vetoFailed(dao: string, id: number, why: VetoFailure): void {
    this.#queue(dao, 'veto_failed', `veto_failed:${this.#s.network}:${dao}:${id}:${why}`, true, `proposal:${id}`, { t: 'veto_failed', id, why });
  }

  /** Turns a health change into an alert for the DAO it concerns, or every chat for ALL. */
  health(event: HealthEvent): void {
    if (event.kind === 'notice') {
      const id = typeof event.fields.proposal_id === 'number' ? event.fields.proposal_id : null;
      const lost = event.notice === 'veto_lost';
      this.#queue(event.dao, 'notice', lost ? `veto_lost:${this.#s.network}:${event.dao}:${id}` : null, lost, lost ? `proposal:${id}` : 'health', { t: 'notice', notice: event.notice, id, was: lost ? lostAs(event.fields.was) : null });
      return;
    }
    const { signal, dao } = event.raised;
    // News that Telegram is failing cannot travel by Telegram; GET /status carries it.
    if (signal === 'alerts_failing') return;
    const urgent = event.kind === 'raised' && levelOf(signal) === 'offline';
    this.#queue(dao, 'health', null, urgent, urgent ? `offline:${signal}` : 'health', { t: 'health', change: event.kind, signal });
  }

  /** Drops what an earlier process left queued that is no longer true. Run once at boot, before
   *  this process queues anything. A health change goes, unless it raised a signal the store
   *  still keeps as raised: this process takes that signal up again without raising it anew, so
   *  the queued alert is the one members get. Every other signal comes from live reads, which
   *  this process raises again if it is still wrong. A verdict, or a veto that did not land, on a
   *  proposal the worker last saw closed goes too, by the same rule as `Store.open`: nobody can
   *  reject it any more, and one that passed is told as a lost veto. A verdict on an open
   *  proposal, a veto cast and a notice are facts that still hold, and stay. Returns how many
   *  were dropped. */
  dropStale(): number {
    const { store, log } = this.#d;
    const kept = new Set(store.keptSignals(this.#s.network).map((k) => `${k.signal}|${k.dao}`));
    const health: number[] = [];
    const closed: number[] = [];
    for (const row of store.queuedAlerts(this.#s.network)) {
      if (row.kind === 'health') {
        const body = readBody(row.body);
        if (!(body?.t === 'health' && body.change === 'raised' && kept.has(`${body.signal}|${row.dao}`))) health.push(row.id);
        continue;
      }
      const body = row.kind === 'verdict' || row.kind === 'veto_failed' ? readBody(row.body) : null;
      if (body?.t !== 'verdict' && body?.t !== 'veto_failed') continue;
      const status = store.judged(this.#s.network, row.dao, body.id)?.proposal_status ?? null;
      if (status !== null && status !== 'InProgress') closed.push(row.id);
    }
    const stale = [...health, ...closed];
    if (stale.length === 0) return 0;
    store.finishAlerts(stale, 'stale');
    log.info('stale_alerts_dropped', { count: stale.length, health: health.length, closed_proposals: closed.length });
    return stale.length;
  }

  /** Sends every alert that is due. Calls made while a flush runs share it. */
  flush(): Promise<void> {
    this.#flushing ??= this.#flushAll().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async #flushAll(): Promise<void> {
    const due = this.#d.store.dueAlerts(this.#s.network, this.#d.now(), 200);
    const groups = new Map<string, AlertRow[]>();
    for (const row of due) {
      const key = row.urgent ? `u${row.id}` : `${row.dao}|${row.batch}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      try {
        await this.#deliver(rows);
      } catch (e) {
        this.#d.log.error('alert_failed', { alerts: rows.map((r) => r.id), error: e });
      }
    }
  }

  async #deliver(rows: AlertRow[]): Promise<void> {
    const { store, log } = this.#d;
    const first = rows[0]!;
    const bodies: AlertBody[] = [];
    const live: number[] = [];
    for (const r of rows) {
      const b = readBody(r.body);
      if (b) {
        bodies.push(b);
        live.push(r.id);
      } else {
        store.finishAlerts([r.id], 'failed');
        log.error('alert_unreadable', { alert: r.id });
      }
    }
    if (bodies.length === 0) return;
    const urgent = first.urgent === 1;
    const text = render(this.#s.network, this.#s.siteUrl, first.dao, bodies);
    const to: SubscriptionRow[] = first.dao === ALL ? store.everyChat(this.#s.network) : store.subscribers(this.#s.network, first.dao);
    if (to.length === 0) {
      store.finishAlerts(live, 'no_subscribers');
      log.info('alert_no_subscribers', { dao: first.dao, alerts: live });
      return;
    }

    let delivered = 0;
    let capped = 0;
    let retryable = 0;
    for (const sub of to) {
      if (!urgent && store.batchedSentTo(sub.chat_id, this.#d.now() - HOUR) >= this.#s.capPerHour) {
        capped++;
        store.addDelivery({ subscription_id: sub.id, alert_ids: live, urgent, state: 'capped', message_id: null, error: null });
        log.warn('alert_capped', { subscription: sub.id, alerts: live, cap_per_hour: this.#s.capPerHour });
        continue;
      }
      const r = await this.#send(sub.chat_id, text);
      await this.#d.sleep(SEND_GAP_MS);
      if (r.ok) {
        delivered++;
        store.addDelivery({ subscription_id: sub.id, alert_ids: live, urgent, state: 'sent', message_id: r.messageId, error: null });
        log.info('alert_sent', { subscription: sub.id, dao: first.dao, alerts: live, urgent, telegram: { ok: true, message_id: r.messageId, chat: r.chatId === null ? null : maskChat(r.chatId) } });
        continue;
      }
      store.addDelivery({ subscription_id: sub.id, alert_ids: live, urgent, state: 'failed', message_id: null, error: `${r.code ?? 'none'}: ${r.detail}` });
      log.error('alert_not_delivered', { subscription: sub.id, dao: first.dao, alerts: live, code: r.code, detail: r.detail, retryable: r.retryable });
      if (r.retryable) retryable++;
      if (r.gone) {
        const ended = store.endChat(this.#s.network, sub.chat_id);
        log.warn('unsubscribed', { subscription: sub.id, subscriptions: ended, why: 'Telegram says the bot was blocked or removed' });
      }
    }
    if (delivered > 0) this.#d.onDelivery?.(true);
    else if (retryable > 0) this.#d.onDelivery?.(false);

    // Sent again only when nobody got it and every failure may pass later, so no chat ever gets
    // the same message twice.
    if (delivered === 0 && capped === 0 && retryable === to.length && first.tries + 1 < SEND_TRIES) {
      store.retryAlerts(live, this.#d.now() + RETRY_MS);
      return;
    }
    store.finishAlerts(live, delivered > 0 || capped > 0 ? 'sent' : 'failed');
  }

  /** One message, waiting out a short 429 once. */
  async #send(chatId: string, text: string): Promise<SendResult> {
    const r = await this.#d.telegram.sendMessage(chatId, text);
    if (r.ok || r.code !== 429 || r.retryAfterMs === null || r.retryAfterMs > 30_000) return r;
    await this.#d.sleep(r.retryAfterMs);
    return this.#d.telegram.sendMessage(chatId, text);
  }
}
