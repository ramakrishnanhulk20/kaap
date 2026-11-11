// The worker: every enrolled DAO watched, every new proposal judged once, every verdict recorded,
// and the veto sent when the rule says so, with no manual step. The guard can only veto what this
// hands it, so a quiet worker is a disarmed guard; everything that can stop it is logged loudly.
// A member's sealed text (POST /texts) is judged here too, one proposal at a time like the rest.

import type { Actor, Signed } from './act.ts';
import type { AlertSink } from './alerts.ts';
import { Bridge, type DecodedVerdict } from './bridge.ts';
import { PER_STOPPED_ATTACK } from './caps.ts';
import { ACCOUNT_ID } from './config.ts';
import { ALL, type Health, type Signal } from './health.ts';
import type { Judge, Judgement, SealedText } from './judge.ts';
import type { Logger } from './log.ts';
import { STORAGE_PRICE_PER_BYTE, formatNear } from './near.ts';
import type { Reads } from './reads.ts';
import type { RejudgeWatch } from './rejudge.ts';
import { dayOf, type Store } from './store.ts';
import { CounterWatch } from './watcher.ts';

/** The worker raises "balance low" below the cost of 20 stopped attacks (C18). */
export const WORKER_FLOOR = 20n * PER_STOPPED_ATTACK;
/** The guard pays the storage of every verdict it spends, 84 bytes at most (a refused vote,
 *  packages/contracts/GAS.md); callers pay all the gas. So 20 vetoes need 1,680 bytes. */
export const GUARD_FLOOR = 20n * 84n * STORAGE_PRICE_PER_BYTE;
export const DEFAULT_LAG_MS = 15_000;

/** What became of one member's sealed text (POST /texts). */
export type TextOutcome =
  | { kind: 'not_watched' }
  | { kind: 'not_open' }
  | { kind: 'capped' }
  /** `reason` is the sealed program's own fixed text when it refused or held the run, else a word. */
  | { kind: 'failed'; reason: string; runTx: string | null }
  | { kind: 'judged'; runTx: string; verdict: DecodedVerdict; explanation: string; veto: 'started' | 'not_needed' };

export interface WorkerSettings {
  network: string;
  guard: string;
  pollMs: number;
  watchMs: number;
  enrolledMs: number;
  holdAlertMs: number;
  backfillWindow: number;
  maxConcurrentRuns: number;
  /** How long a provider may go without answering a DAO's counter before it is raised. */
  lagAlertMs?: number;
  /** How often lag is checked, on its own timer so a poll that hangs is still seen; 1 s. */
  sweepMs?: number;
  /** The worker's own account, whose balance is watched; unset in tests that do not check it. */
  workerAccount?: string;
}

export interface WorkerDeps {
  store: Store;
  reads: Reads;
  judge: Judge;
  actor: Actor;
  rejudge: RejudgeWatch;
  health: Health;
  log: Logger;
  now: () => number;
  /** Shared with the judge, which checks every sealed output against it. */
  acceptedKey: { value: string | null };
  /** Decodes stored verdicts for a resumed send; loaded from the built bridge when not given. */
  bridge?: Pick<Bridge, 'decodeVerdict'>;
  /** Member alerts; tests that do not look at alerts leave it out. */
  alerts?: AlertSink;
}

export class Worker {
  readonly #d: WorkerDeps;
  readonly #s: WorkerSettings;
  readonly #bridge: Pick<Bridge, 'decodeVerdict'>;
  readonly #watchers = new Map<string, CounterWatch>();
  readonly #queue: Array<[string, number]> = [];
  readonly #queued = new Set<string>();
  readonly #inFlight = new Set<string>();
  readonly #again = new Set<string>();
  /** Texts waiting for a proposal another judgement holds, in arrival order. */
  readonly #waiting = new Map<string, Array<() => void>>();
  /** Every text being judged or acted on, so stop() can wait for them. */
  readonly #texts = new Set<Promise<void>>();
  readonly #timers: NodeJS.Timeout[] = [];
  #running = 0;
  #idle: Array<() => void> = [];
  #stopped = false;
  #lane: Promise<void> = Promise.resolve();

  constructor(deps: WorkerDeps, settings: WorkerSettings) {
    this.#d = deps;
    this.#s = settings;
    this.#bridge = deps.bridge ?? Bridge.load();
  }

  /** Reads the guard, takes up every enrolled DAO (backfilling each one's open proposals the first
   *  time), resumes anything a restart cut off, then starts the loops. */
  async start(): Promise<void> {
    await this.refreshGuard();
    if (!this.#d.acceptedKey.value) throw new Error('the guard key could not be read on both providers; the worker cannot check any verdict');
    await this.refreshEnrolled();
    for (const row of this.#d.store.unfinished(this.#s.network)) this.enqueue(row.dao, row.proposal_id);
    await this.#exclusive(() => this.#resumeAll());
    await this.checkBalances();
    this.#every(this.#s.pollMs, () => this.pollTick());
    this.#every(this.#s.watchMs, () => this.watchTick());
    this.#every(this.#s.enrolledMs, async () => {
      await this.refreshGuard();
      await this.refreshEnrolled();
      await this.checkBalances();
    });
    this.#every(this.#s.sweepMs ?? 1_000, async () => this.sweep());
  }

  /** Runs `work` once every resume pass and watch tick before it has finished, so a resume pass
   *  and a re-judge pass never run at the same time, whoever started them. */
  #exclusive(work: () => Promise<void>): Promise<void> {
    const run = this.#lane.then(work);
    this.#lane = run.catch(() => undefined);
    return run;
  }

  /** One poll of every watched DAO's counter. */
  async pollTick(): Promise<void> {
    await Promise.all([...this.#watchers.values()].map((w) => w.tick()));
  }

  /** One watch tick: re-sends what has no outcome yet, and only after that pass has finished,
   *  re-judges what moved. A hung send can therefore delay that tick's re-judge, by at most the
   *  send's window; the order is kept so a resumed veto always acts before a re-judge replaces
   *  its verdict. */
  watchTick(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#resumeAll();
      if (this.#stopped) return;
      await Promise.all([...this.#watchers.keys()].map((dao) => this.#d.rejudge.pass(dao)));
    });
  }

  /** The DAOs being watched now. */
  watching(): string[] {
    return [...this.#watchers.keys()];
  }

  /** Raises "watcher lag" (guard offline) when neither provider has answered a DAO's counter
   *  for the lag window, and "provider silent" (guard degraded) when one of them has not; each
   *  clears once the reads come back. A cap reached on an earlier UTC day is cleared too, since
   *  every cap counts per day (C18, C29). */
  sweep(): void {
    const { health, reads } = this.#d;
    const now = this.#d.now();
    const lag = this.#s.lagAlertMs ?? DEFAULT_LAG_MS;
    for (const [dao, watch] of this.#watchers) {
      const at = watch.lastRead();
      const late = { primary: now - at.primary >= lag, secondary: now - at.secondary >= lag };
      if (late.primary && late.secondary) {
        health.raise('watcher_lag', dao, { seconds: Math.round((now - Math.max(at.primary, at.secondary)) / 1_000) });
        continue;
      }
      health.clear('watcher_lag', dao);
      if (late.primary || late.secondary) {
        const which = late.primary ? 'primary' : 'secondary';
        health.raise('provider_silent', dao, { provider: reads[which].name, seconds: Math.round((now - at[which]) / 1_000) });
      } else {
        health.clear('provider_silent', dao);
      }
    }
    for (const r of health.current()) if (r.signal === 'cap_reached' && dayOf(r.since) !== dayOf(now)) health.clear('cap_reached', r.dao);
  }

  /** Raises "balance low" for the worker below 20 stopped attacks and for the guard below the
   *  storage of 20 vetoes, read on both providers and taking the lower answer (C18). */
  async checkBalances(): Promise<void> {
    const checks: Array<[Signal, string | undefined, bigint]> = [
      ['worker_balance_low', this.#s.workerAccount, WORKER_FLOOR],
      ['guard_balance_low', this.#s.guard, GUARD_FLOOR],
    ];
    for (const [signal, account, floor] of checks) {
      if (!account) continue;
      const free = await this.#d.reads.spendable(account);
      if (free === null) {
        this.#d.log.warn('balance_unread', { account });
        continue;
      }
      if (free < floor) this.#d.health.raise(signal, ALL, { account, spendable_near: formatNear(free), needs_near: formatNear(floor) });
      else this.#d.health.clear(signal, ALL);
    }
  }

  #every(ms: number, work: () => Promise<unknown>): void {
    let busy = false;
    this.#timers.push(
      setInterval(() => {
        if (busy || this.#stopped) return;
        busy = true;
        work()
          .catch((e) => this.#d.log.error('loop_failed', { error: e }))
          .finally(() => {
            busy = false;
          });
      }, ms),
    );
  }

  /** Stops the loops and waits for every judgement, text and resumed send in flight to finish. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    await this.#lane;
    // Texts first: one that finishes can hand its proposal back to the queue.
    await Promise.all(this.#texts);
    await this.idle();
  }

  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    if (this.#running === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  /** The guard's accepted key, read on both providers; used only when they agree (C22). */
  async refreshGuard(): Promise<void> {
    const read = async (p: Reads['primary']) => JSON.parse((await p.callFunction(this.#s.guard, 'accepted_key', {}, { finality: 'final' })).text) as unknown;
    const [a, b] = await Promise.allSettled([read(this.#d.reads.primary), read(this.#d.reads.secondary)]);
    if (a.status !== 'fulfilled' || b.status !== 'fulfilled' || typeof a.value !== 'string' || a.value !== b.value) {
      this.#d.log.warn('guard_key_unread', { primary: a.status, secondary: b.status });
      return;
    }
    const before = this.#d.acceptedKey.value;
    if (before !== null && before !== a.value) {
      // The guard's key_changed event, seen through the view both providers agree on. A change
      // and a change back within one refresh are not seen; only the guard's owner can make one.
      this.#d.log.error('accepted_key_changed', { guard: this.#s.guard, old_key: before, new_key: a.value });
      this.#d.health.raise('accepted_key_changed', ALL, { guard: this.#s.guard, old_key: before, new_key: a.value });
    }
    if (before === null) this.#d.log.info('guard_key', { guard: this.#s.guard, accepted_key: a.value });
    this.#d.acceptedKey.value = a.value;
  }

  /** Starts watching every DAO the guard lists, and stops watching any it no longer lists. */
  async refreshEnrolled(): Promise<void> {
    const { daos, problems } = await this.#d.reads.enrolled(this.#s.guard);
    for (const p of problems) this.#d.log.warn('enrolled_unread', { problem: p });
    for (const dao of daos) {
      if (!ACCOUNT_ID.test(dao)) {
        this.#d.log.warn('enrolled_invalid_id', { length: dao.length });
        continue;
      }
      if (!this.#watchers.has(dao)) await this.#addDao(dao);
    }
    if (problems.length === 0) {
      for (const dao of [...this.#watchers.keys()]) {
        if (!daos.includes(dao)) {
          this.#watchers.delete(dao);
          this.#d.health.clear('watcher_lag', dao);
          this.#d.health.clear('provider_silent', dao);
          this.#d.log.warn('dao_unenrolled', { dao });
        }
      }
    }
  }

  async #addDao(dao: string): Promise<void> {
    const { store, reads, log } = this.#d;
    if (!store.dao(this.#s.network, dao)) {
      const { a, b } = await reads.finalCounters(dao);
      if (a === null || b === null) {
        log.warn('dao_not_added_yet', { dao, why: 'its counter could not be read on both providers' });
        return;
      }
      const last = Math.min(a, b);
      const from = Math.max(0, last - this.#s.backfillWindow);
      const ids = Array.from({ length: last - from }, (_, i) => from + i);
      const state = await reads.watchState(dao, ids);
      if (state.kind !== 'live') {
        log.warn('dao_not_added_yet', { dao, why: 'its proposals could not be read on both providers', problem: state });
        return;
      }
      // Only a proposal still open can be protected; the ones closed before Kaap first saw the
      // DAO are counted and left alone.
      const open = state.proposals.filter((p) => p.status === 'InProgress');
      for (const p of open) store.queueNew(this.#s.network, dao, p.id, 'backfill', 'InProgress');
      store.addDao(this.#s.network, dao, last);
      log.info('dao_added', { dao, next_id: last, backfill_from: from, open_backfilled: open.map((p) => p.id), closed_skipped: state.proposals.length - open.length, older_than_window: from });
      for (const p of open) this.enqueue(dao, p.id);
    }
    const watch = new CounterWatch(dao, reads, store, this.#d.health, log, { network: this.#s.network, holdAlertMs: this.#s.holdAlertMs, now: this.#d.now }, (id) => this.enqueue(dao, id));
    this.#watchers.set(dao, watch);
    log.info('watching', { dao });
  }

  /** Asks for (`dao`, `id`) to be judged. One judgement per proposal runs at a time; a request
   *  made while one runs is kept and run straight after it. */
  enqueue(dao: string, id: number): void {
    const key = `${dao}#${id}`;
    if (this.#inFlight.has(key)) {
      this.#again.add(key);
      return;
    }
    if (this.#queued.has(key)) return;
    this.#queued.add(key);
    this.#queue.push([dao, id]);
    this.#pump();
  }

  #pump(): void {
    while (this.#running < this.#s.maxConcurrentRuns && this.#queue.length > 0) {
      const [dao, id] = this.#queue.shift()!;
      const key = `${dao}#${id}`;
      this.#queued.delete(key);
      // A text took this proposal while it waited in the queue; it runs once the text is done.
      if (this.#inFlight.has(key)) {
        this.#again.add(key);
        continue;
      }
      this.#inFlight.add(key);
      this.#running++;
      this.process(dao, id)
        .catch((e) => this.#d.log.error('judgement_failed', { dao, proposal_id: id, error: e }))
        .finally(() => {
          this.#running--;
          this.#free(key, dao, id);
          this.#pump();
          if (this.#running === 0 && this.#queue.length === 0) for (const done of this.#idle.splice(0)) done();
        });
    }
  }

  /** Lets go of (`dao`, `id`): hands it straight to the first text waiting for it, or else runs
   *  any judgement asked for meanwhile. */
  #free(key: string, dao: string, id: number): void {
    const next = this.#waiting.get(key)?.shift();
    if (next) {
      next();
      return;
    }
    this.#waiting.delete(key);
    this.#inFlight.delete(key);
    if (this.#again.delete(key)) this.enqueue(dao, id);
  }

  /** Resolves once this caller holds (`dao`, `id`): no judgement, resumed send or other text of
   *  it runs until `#free`. */
  #hold(key: string): Promise<void> {
    if (!this.#inFlight.has(key)) {
      this.#inFlight.add(key);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiting = this.#waiting.get(key) ?? [];
      waiting.push(resolve);
      this.#waiting.set(key, waiting);
    });
  }

  /** Judges one queued proposal, then vetoes (first, since it races the approvers) and records. */
  async process(dao: string, id: number): Promise<void> {
    const { store, judge, log } = this.#d;
    const net = this.#s.network;
    const row = store.judged(net, dao, id);
    if (!row || (row.state !== 'queued' && row.state !== 'judging')) return;
    const generation = row.generation;
    store.setJudgedState(net, dao, id, 'judging');
    const j = await judge.judge(dao, id, generation);
    if (j.kind !== 'verdict') {
      store.setJudgedState(net, dao, id, j.kind === 'capped' ? 'capped' : 'failed');
      return;
    }
    if (store.judged(net, dao, id)?.generation !== generation) {
      log.info('verdict_superseded', { dao, proposal_id: id, generation, why: 'a re-judge was asked for while this run was out' });
      return;
    }
    await this.#act(dao, id, row.reason, j);
  }

  /** Keeps a verdict as the proposal's current one, then vetoes (first, since it races the
   *  approvers) and records. The verdict is stored before the first wait, so a caller that does
   *  not wait for the veto still finds it kept. */
  async #act(dao: string, id: number, reason: string, j: Extract<Judgement, { kind: 'verdict' }>): Promise<void> {
    const { store, actor } = this.#d;
    const net = this.#s.network;
    const v = j.verdict;
    store.setVerdict(net, dao, id, {
      verdict_b64: j.verdictB64,
      signature_b64: j.signatureB64,
      verdict_hash: v.verdict_hash,
      risk: v.risk,
      floor: v.floor,
      findings: v.findings.join(','),
      ai_status: v.ai_status,
      kind_hash: v.kind_hash,
      policy_hash: v.policy_hash,
      receivers_hash: v.receivers_hash,
      block_height: v.block_height,
      expires_at_ms: v.expires_at_ms,
      vetoable: v.vetoable ? 1 : 0,
    });
    const signed = { verdict: v, verdictB64: j.verdictB64, signatureB64: j.signatureB64 };
    const alerted = this.#alertVerdict(dao, id, v);
    const vetoed = await actor.veto(dao, id, signed);
    if (vetoed.kind === 'cast') {
      await alerted;
      this.#d.alerts?.vetoCast(dao, id, vetoed.seconds);
    }
    await actor.record(dao, id, signed);
    if (vetoed.kind === 'rejudge') this.#rejudge(dao, id, reason, vetoed.why);
  }

  /** Whether the sealed run's input for this text stays inside what the sealed program reads. */
  textFits(dao: string, id: number, text: SealedText): boolean {
    return this.#d.judge.fits(dao, id, text);
  }

  /** Judges (`dao`, `id`) with a member's sealed text, for POST /texts. The proposal must be one
   *  of a watched DAO that both providers agree is open at one final block (C22). The run waits
   *  for any other judgement of the proposal to finish, and holds it until its own veto and record
   *  are done, so the two never act on one proposal at once. Its verdict, once it checks out like
   *  every verdict, becomes the proposal's current one under a new generation and goes down the
   *  same veto path; the answer comes back before the veto lands. A refused or failed run leaves
   *  the proposal's earlier verdict and its actions as they were.
   *
   *  The text itself is never here: only its ciphertext, held for this call. Not covered: a re-judge
   *  of a text's verdict after the state moves runs without the text, which the worker no longer
   *  has; the member sends it again. */
  async judgeText(dao: string, id: number, text: SealedText): Promise<TextOutcome> {
    if (this.#stopped) return { kind: 'failed', reason: 'stopping', runTx: null };
    if (!this.#watchers.has(dao)) return { kind: 'not_watched' };
    const live = await this.#d.reads.liveProposal(dao, id);
    if (live.kind !== 'live' || live.status !== 'InProgress') return { kind: 'not_open' };
    let answer!: (outcome: TextOutcome) => void;
    const answered = new Promise<TextOutcome>((resolve) => (answer = resolve));
    const work = this.#withText(dao, id, text, answer);
    this.#texts.add(work);
    void work.finally(() => this.#texts.delete(work));
    return answered;
  }

  async #withText(dao: string, id: number, text: SealedText, answer: (outcome: TextOutcome) => void): Promise<void> {
    const { store, judge, log } = this.#d;
    const net = this.#s.network;
    const key = `${dao}#${id}`;
    await this.#hold(key);
    let answered = false;
    const reply = (outcome: TextOutcome) => {
      answered = true;
      answer(outcome);
    };
    try {
      if (this.#stopped) return reply({ kind: 'failed', reason: 'stopping', runTx: null });
      const j = await judge.judge(dao, id, store.judged(net, dao, id)?.generation ?? 0, text);
      if (j.kind === 'capped') return reply({ kind: 'capped' });
      if (j.kind === 'no_verdict') return reply({ kind: 'failed', reason: j.last === 'refused' || j.last === 'held' ? j.detail : j.last, runTx: j.tx });
      // A new generation, so nothing judged before this text can act on its older verdict (C4).
      if (store.judged(net, dao, id)) store.queueAgain(net, dao, id, 'text');
      else store.queueNew(net, dao, id, 'text', 'InProgress');
      const acting = this.#act(dao, id, 'text', j);
      reply({ kind: 'judged', runTx: j.runTx, verdict: j.verdict, explanation: j.explanation, veto: j.verdict.vetoable ? 'started' : 'not_needed' });
      await acting;
    } catch (e) {
      // Only the error's name: a message could quote what it was handed.
      log.error('text_failed', { dao, proposal_id: id, error: e instanceof Error ? e.name : 'unknown' });
      if (!answered) reply({ kind: 'failed', reason: 'failed', runTx: null });
    } finally {
      this.#free(key, dao, id);
    }
  }

  /** Queues the members' alert for a verdict. The proposer is read beside the veto, never before
   *  it, since the veto races the approvers. */
  #alertVerdict(dao: string, id: number, v: DecodedVerdict): Promise<void> {
    const alerts = this.#d.alerts;
    if (!alerts) return Promise.resolve();
    return this.#d.reads
      .proposer(dao, id)
      .then((proposer) => alerts.verdict(dao, id, v, proposer))
      .catch((e: unknown) => this.#d.log.error('alert_failed', { dao, proposal_id: id, error: e }));
  }

  /** Judges a proposal again after its verdict no longer matched the live state, unless that
   *  verdict was itself the fresh one from such a re-judge: then the worker and the sealed job read
   *  the state differently, judging again would only repeat that, and the veto is held. */
  #rejudge(dao: string, id: number, reason: string, why: string): void {
    const net = this.#s.network;
    if (reason.startsWith('rejudge:stale')) {
      this.#d.store.setVetoState(net, dao, id, 'held');
      this.#d.log.error('refused', { what: 'veto', dao, proposal_id: id, reason: 'fresh verdict still does not match the live state', why });
      this.#d.health.raise('veto_held', dao, { proposal_id: id, why });
      return;
    }
    this.#d.store.queueAgain(net, dao, id, `rejudge:stale:${why}`);
    this.enqueue(dao, id);
  }

  /** Sends again every veto and record that has no final outcome, by its idempotency key, so the
   *  same signed bytes go out and nothing is paid twice. A veto still goes through `decide` on
   *  fresh live state, so one for a proposal now closed sends nothing, and one whose verdict went
   *  stale while it waited asks for a new verdict. A proposal being judged right now is left to
   *  that judgement, and one asked for during a resume is judged straight after it. Always run
   *  through `#exclusive`. */
  async #resumeAll(): Promise<void> {
    const { store, actor, log } = this.#d;
    for (const row of store.pendingActions(this.#s.network)) {
      if (this.#stopped) return;
      const { dao, proposal_id: id } = row;
      const key = `${dao}#${id}`;
      if (this.#inFlight.has(key) || this.#queued.has(key)) continue;
      let signed: Signed;
      try {
        signed = { verdict: this.#bridge.decodeVerdict(Buffer.from(row.verdict_b64!, 'base64')), verdictB64: row.verdict_b64!, signatureB64: row.signature_b64! };
      } catch (e) {
        log.error('resume_failed', { dao, proposal_id: id, why: 'the stored verdict does not decode', error: e });
        continue;
      }
      this.#inFlight.add(key);
      try {
        log.info('action_resumed', { dao, proposal_id: id, veto_state: row.veto_state, record_state: row.record_state, verdict_hash: row.verdict_hash });
        const vetoed = row.veto_state === 'sent' || row.veto_state === 'no_outcome' ? await actor.veto(dao, id, signed) : null;
        if (vetoed?.kind === 'cast') this.#d.alerts?.vetoCast(dao, id, vetoed.seconds);
        if (row.record_state === 'sent' || row.record_state === 'no_outcome') await actor.record(dao, id, signed);
        if (vetoed?.kind === 'rejudge') this.#rejudge(dao, id, 'resumed', vetoed.why);
      } catch (e) {
        // The row is still pending, so the next pass sends it again.
        log.error('resume_failed', { dao, proposal_id: id, error: e });
      } finally {
        this.#free(key, dao, id);
      }
    }
  }
}
