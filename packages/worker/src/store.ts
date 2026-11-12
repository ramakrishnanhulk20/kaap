// The worker's memory, one SQLite file. Everything that must survive a restart lives here: where
// each DAO's counter was taken up to, each proposal's latest verdict and what was done with it,
// every sealed run, and every transaction with its signed bytes, written before it is sent so a
// retry re-sends the same bytes instead of signing a second payment (6e).
//
// It also holds who gets alerts: Telegram chat ids live only in the subscriptions table, and
// every other table and every log line refers to a subscription by its row id (C26). One-time
// subscription tokens are kept only as their SHA-256, so a copy of the file cannot redeem one.
//
// Never stored: hash texts, descriptions, keys, the bot token, alert texts, and a member's sealed
// text or reply key in any form: a run that carries one keeps no signed bytes (C26). A raised
// health signal is kept as its name, DAO, proposal and time only, never its fields.

import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daos (
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  next_id INTEGER NOT NULL,
  policy_hash TEXT,
  first_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (network, dao)
) STRICT;
CREATE TABLE IF NOT EXISTS code_hashes (
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  account TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (network, dao, account)
) STRICT;
CREATE TABLE IF NOT EXISTS judged (
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL,
  reason TEXT NOT NULL,
  proposal_status TEXT,
  verdict_b64 TEXT,
  signature_b64 TEXT,
  verdict_hash TEXT,
  risk TEXT,
  floor TEXT,
  findings TEXT,
  ai_status TEXT,
  kind_hash TEXT,
  policy_hash TEXT,
  receivers_hash TEXT,
  block_height INTEGER,
  expires_at_ms INTEGER,
  vetoable INTEGER,
  veto_state TEXT NOT NULL DEFAULT 'none',
  record_state TEXT NOT NULL DEFAULT 'none',
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (network, dao, proposal_id)
) STRICT;
CREATE TABLE IF NOT EXISTS runs (
  idempotency_key TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  day TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  finished_ms INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS runs_by_day ON runs (network, dao, day);
CREATE TABLE IF NOT EXISTS spend (
  idempotency_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  signed_b64 TEXT NOT NULL,
  nonce TEXT NOT NULL,
  include_height INTEGER,
  reserved_yocto TEXT NOT NULL,
  actual_yocto TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  refusal TEXT,
  day TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  finished_ms INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS spend_by_day ON spend (day, kind, dao);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  UNIQUE (network, dao, chat_id)
) STRICT;
CREATE TABLE IF NOT EXISTS subscribe_tokens (
  token_sha256 TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  used_ms INTEGER,
  subscription_id INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network TEXT NOT NULL,
  dao TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe TEXT UNIQUE,
  urgent INTEGER NOT NULL,
  batch TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  due_ms INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  done_ms INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS alerts_due ON alerts (state, due_ms);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  alert_ids TEXT NOT NULL,
  urgent INTEGER NOT NULL,
  state TEXT NOT NULL,
  message_id INTEGER,
  error TEXT,
  created_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_by_subscription ON deliveries (subscription_id, created_ms);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS signals (
  network TEXT NOT NULL,
  signal TEXT NOT NULL,
  dao TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  since_ms INTEGER NOT NULL,
  PRIMARY KEY (network, signal, dao, proposal_id)
) STRICT;
`;

/** The proposal_id a signal about a whole DAO is kept under: no proposal has a negative id, and a
 *  key column cannot hold NULL as one value. */
const NO_PROPOSAL = -1;

export type JudgedState = 'queued' | 'judging' | 'judged' | 'failed' | 'capped' | 'skipped';
export type VetoState = 'none' | 'not_needed' | 'sent' | 'no_outcome' | 'cast' | 'refused' | 'held' | 'not_open' | 'capped';
export type RecordState = 'none' | 'sent' | 'no_outcome' | 'recorded' | 'refused' | 'capped';
export type RunState = 'pending' | 'answered' | 'held' | 'refused' | 'failed' | 'no_answer';
export type SpendKind = 'run' | 'record' | 'veto';
export type SpendState = 'signed' | 'sent' | 'final' | 'rejected';

export interface DaoRow {
  network: string;
  dao: string;
  next_id: number;
  policy_hash: string | null;
  first_seen_ms: number;
}

export interface JudgedRow {
  network: string;
  dao: string;
  proposal_id: number;
  state: JudgedState;
  generation: number;
  reason: string;
  proposal_status: string | null;
  verdict_b64: string | null;
  signature_b64: string | null;
  verdict_hash: string | null;
  risk: string | null;
  floor: string | null;
  findings: string | null;
  ai_status: string | null;
  kind_hash: string | null;
  policy_hash: string | null;
  receivers_hash: string | null;
  block_height: number | null;
  expires_at_ms: number | null;
  vetoable: number | null;
  veto_state: VetoState;
  record_state: RecordState;
  updated_ms: number;
}

export interface RunRow {
  idempotency_key: string;
  network: string;
  dao: string;
  proposal_id: number;
  generation: number;
  attempt: number;
  state: RunState;
  detail: string | null;
  day: string;
  created_ms: number;
  finished_ms: number | null;
}

export interface SpendRow {
  idempotency_key: string;
  kind: SpendKind;
  network: string;
  dao: string;
  proposal_id: number;
  tx_hash: string;
  signed_b64: string;
  nonce: string;
  include_height: number | null;
  reserved_yocto: string;
  actual_yocto: string | null;
  state: SpendState;
  outcome: 'ok' | 'failed' | null;
  refusal: string | null;
  day: string;
  created_ms: number;
  finished_ms: number | null;
}

export interface SubscriptionRow {
  id: number;
  network: string;
  dao: string;
  chat_id: string;
  active: number;
  created_ms: number;
  ended_ms: number | null;
}

export type AlertState = 'queued' | 'sent' | 'no_subscribers' | 'failed' | 'stale';
export type DeliveryState = 'sent' | 'failed' | 'capped';

export interface AlertRow {
  id: number;
  network: string;
  dao: string;
  kind: string;
  dedupe: string | null;
  urgent: number;
  batch: string;
  body: string;
  state: AlertState;
  tries: number;
  due_ms: number;
  created_ms: number;
  done_ms: number | null;
}

export interface VerdictColumns {
  verdict_b64: string;
  signature_b64: string;
  verdict_hash: string;
  risk: string;
  floor: string;
  findings: string;
  ai_status: string;
  kind_hash: string;
  policy_hash: string;
  receivers_hash: string;
  block_height: number;
  expires_at_ms: number;
  vetoable: number;
}

/** UTC calendar day, the unit every daily cap counts in. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** How the idempotency key of every run that carries a member's text starts, and nothing else's. */
export const TEXT_RUN_PREFIX = 'text:';

export class Store {
  readonly db: Database.Database;
  readonly #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#now = now;
  }

  close(): void {
    this.db.close();
  }

  now(): number {
    return this.#now();
  }

  dao(network: string, dao: string): DaoRow | undefined {
    return this.db.prepare('SELECT * FROM daos WHERE network = ? AND dao = ?').get(network, dao) as DaoRow | undefined;
  }

  addDao(network: string, dao: string, nextId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO daos (network, dao, next_id, policy_hash, first_seen_ms) VALUES (?, ?, ?, NULL, ?)').run(network, dao, nextId, this.#now());
  }

  /** Moves the counter forward only, so a lagging read can never make the worker re-take ids. */
  advance(network: string, dao: string, nextId: number): void {
    this.db.prepare('UPDATE daos SET next_id = ? WHERE network = ? AND dao = ? AND next_id < ?').run(nextId, network, dao, nextId);
  }

  setPolicyHash(network: string, dao: string, hash: string): void {
    this.db.prepare('UPDATE daos SET policy_hash = ? WHERE network = ? AND dao = ?').run(hash, network, dao);
  }

  codeHashes(network: string, dao: string): Map<string, string> {
    const rows = this.db.prepare('SELECT account, code_hash FROM code_hashes WHERE network = ? AND dao = ?').all(network, dao) as Array<{ account: string; code_hash: string }>;
    return new Map(rows.map((r) => [r.account, r.code_hash]));
  }

  setCodeHash(network: string, dao: string, account: string, codeHash: string): void {
    this.db.prepare('INSERT INTO code_hashes (network, dao, account, code_hash) VALUES (?, ?, ?, ?) ON CONFLICT (network, dao, account) DO UPDATE SET code_hash = excluded.code_hash').run(network, dao, account, codeHash);
  }

  judged(network: string, dao: string, id: number): JudgedRow | undefined {
    return this.db.prepare('SELECT * FROM judged WHERE network = ? AND dao = ? AND proposal_id = ?').get(network, dao, id) as JudgedRow | undefined;
  }

  /** Queues a proposal for its first judgement. A proposal already known is left as it is, so an
   *  id seen twice is judged once. Returns whether it was new. */
  queueNew(network: string, dao: string, id: number, reason: string, status: string | null = null): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO judged (network, dao, proposal_id, state, generation, reason, proposal_status, updated_ms) VALUES (?, ?, ?, 'queued', 1, ?, ?, ?)")
      .run(network, dao, id, reason, status, this.#now());
    return r.changes === 1;
  }

  /** Queues a known proposal again under a new generation, so its old verdict can never be acted
   *  on as if it were current (C4). */
  queueAgain(network: string, dao: string, id: number, reason: string): number {
    this.db
      .prepare("UPDATE judged SET state = 'queued', generation = generation + 1, reason = ?, veto_state = CASE WHEN veto_state = 'cast' THEN 'cast' ELSE 'none' END, record_state = 'none', updated_ms = ? WHERE network = ? AND dao = ? AND proposal_id = ?")
      .run(reason, this.#now(), network, dao, id);
    return this.judged(network, dao, id)?.generation ?? 0;
  }

  setJudgedState(network: string, dao: string, id: number, state: JudgedState): void {
    this.db.prepare('UPDATE judged SET state = ?, updated_ms = ? WHERE network = ? AND dao = ? AND proposal_id = ?').run(state, this.#now(), network, dao, id);
  }

  setProposalStatus(network: string, dao: string, id: number, status: string): void {
    this.db.prepare('UPDATE judged SET proposal_status = ?, updated_ms = ? WHERE network = ? AND dao = ? AND proposal_id = ?').run(status, this.#now(), network, dao, id);
  }

  setVerdict(network: string, dao: string, id: number, v: VerdictColumns): void {
    this.db
      .prepare(
        "UPDATE judged SET state = 'judged', verdict_b64 = @verdict_b64, signature_b64 = @signature_b64, verdict_hash = @verdict_hash, risk = @risk, floor = @floor, findings = @findings, ai_status = @ai_status, kind_hash = @kind_hash, policy_hash = @policy_hash, receivers_hash = @receivers_hash, block_height = @block_height, expires_at_ms = @expires_at_ms, vetoable = @vetoable, updated_ms = @now WHERE network = @network AND dao = @dao AND proposal_id = @id",
      )
      .run({ ...v, now: this.#now(), network, dao, id });
  }

  setVetoState(network: string, dao: string, id: number, state: VetoState): void {
    this.db.prepare('UPDATE judged SET veto_state = ?, updated_ms = ? WHERE network = ? AND dao = ? AND proposal_id = ?').run(state, this.#now(), network, dao, id);
  }

  setRecordState(network: string, dao: string, id: number, state: RecordState): void {
    this.db.prepare('UPDATE judged SET record_state = ?, updated_ms = ? WHERE network = ? AND dao = ? AND proposal_id = ?').run(state, this.#now(), network, dao, id);
  }

  /** Proposals of `dao` the worker last saw open for votes, and new ones whose status it has not
   *  read yet, which the re-judge watch reads next. */
  open(network: string, dao: string): JudgedRow[] {
    return this.db.prepare("SELECT * FROM judged WHERE network = ? AND dao = ? AND (proposal_status = 'InProgress' OR proposal_status IS NULL) ORDER BY proposal_id").all(network, dao) as JudgedRow[];
  }

  /** Proposals a restart must pick up again: queued, or cut off mid-judgement. */
  unfinished(network: string): JudgedRow[] {
    return this.db.prepare("SELECT * FROM judged WHERE network = ? AND state IN ('queued', 'judging') ORDER BY proposal_id").all(network) as JudgedRow[];
  }

  /** Verdicts whose veto or record has no final outcome yet: the chain gave none in time, or the
   *  worker stopped while it was being sent. Each is re-sent by its idempotency key until it is
   *  final or, for a veto, no longer needed. */
  pendingActions(network: string): JudgedRow[] {
    return this.db
      .prepare("SELECT * FROM judged WHERE network = ? AND verdict_b64 IS NOT NULL AND signature_b64 IS NOT NULL AND (veto_state IN ('sent', 'no_outcome') OR record_state IN ('sent', 'no_outcome')) ORDER BY proposal_id")
      .all(network) as JudgedRow[];
  }

  /** Proposals still open, by the rule of `open`, with a step that a cap, a failed run or a hold
   *  stopped: a judgement that ended failed or capped, a veto held or capped, a record capped.
   *  The worker takes each up again while its proposal stays open. */
  stopped(network: string): JudgedRow[] {
    return this.db
      .prepare("SELECT * FROM judged WHERE network = ? AND (proposal_status = 'InProgress' OR proposal_status IS NULL) AND (state IN ('failed', 'capped') OR veto_state IN ('held', 'capped') OR record_state = 'capped') ORDER BY dao, proposal_id")
      .all(network) as JudgedRow[];
  }

  /** Whether any proposal of `dao` still open, by the rule of `open`, has a step a cap stopped. */
  stillCapped(network: string, dao: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM judged WHERE network = ? AND dao = ? AND (proposal_status = 'InProgress' OR proposal_status IS NULL) AND (state = 'capped' OR veto_state = 'capped' OR record_state = 'capped') LIMIT 1")
        .get(network, dao) !== undefined
    );
  }

  /** Every health signal kept as raised, with when it was first raised. */
  keptSignals(network: string): Array<{ signal: string; dao: string; proposal: number | null; since_ms: number }> {
    const rows = this.db.prepare('SELECT signal, dao, proposal_id, since_ms FROM signals WHERE network = ? ORDER BY since_ms').all(network) as Array<{ signal: string; dao: string; proposal_id: number; since_ms: number }>;
    return rows.map((r) => ({ signal: r.signal, dao: r.dao, proposal: r.proposal_id === NO_PROPOSAL ? null : r.proposal_id, since_ms: r.since_ms }));
  }

  keepSignal(network: string, signal: string, dao: string, proposal: number | null, sinceMs: number): void {
    this.db.prepare('INSERT OR IGNORE INTO signals (network, signal, dao, proposal_id, since_ms) VALUES (?, ?, ?, ?, ?)').run(network, signal, dao, proposal ?? NO_PROPOSAL, sinceMs);
  }

  dropSignal(network: string, signal: string, dao: string, proposal: number | null): void {
    this.db.prepare('DELETE FROM signals WHERE network = ? AND signal = ? AND dao = ? AND proposal_id = ?').run(network, signal, dao, proposal ?? NO_PROPOSAL);
  }

  run(key: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE idempotency_key = ?').get(key) as RunRow | undefined;
  }

  addRun(r: Pick<RunRow, 'idempotency_key' | 'network' | 'dao' | 'proposal_id' | 'generation' | 'attempt'>): void {
    const now = this.#now();
    this.db
      .prepare("INSERT OR IGNORE INTO runs (idempotency_key, network, dao, proposal_id, generation, attempt, state, day, created_ms) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(r.idempotency_key, r.network, r.dao, r.proposal_id, r.generation, r.attempt, dayOf(now), now);
  }

  finishRun(key: string, state: RunState, detail: string | null): void {
    this.db.prepare('UPDATE runs SET state = ?, detail = ?, finished_ms = ? WHERE idempotency_key = ?').run(state, detail, this.#now(), key);
  }

  /** Every run attempt of `dao` on `day`, texts included. */
  runsOn(network: string, dao: string, day: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE network = ? AND dao = ? AND day = ?').get(network, dao, day) as { n: number }).n;
  }

  /** The run attempts of `dao` on `day` that carried a member's text. The key is compared byte for
   *  byte, since LIKE would ignore case. */
  textRunsOn(network: string, dao: string, day: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE network = ? AND dao = ? AND day = ? AND substr(idempotency_key, 1, ?) = ?').get(network, dao, day, TEXT_RUN_PREFIX.length, TEXT_RUN_PREFIX) as { n: number }).n;
  }

  spend(key: string): SpendRow | undefined {
    return this.db.prepare('SELECT * FROM spend WHERE idempotency_key = ?').get(key) as SpendRow | undefined;
  }

  addSpend(r: Pick<SpendRow, 'idempotency_key' | 'kind' | 'network' | 'dao' | 'proposal_id' | 'tx_hash' | 'signed_b64' | 'nonce' | 'reserved_yocto'>): void {
    const now = this.#now();
    this.db
      .prepare(
        "INSERT INTO spend (idempotency_key, kind, network, dao, proposal_id, tx_hash, signed_b64, nonce, reserved_yocto, state, day, created_ms) VALUES (@idempotency_key, @kind, @network, @dao, @proposal_id, @tx_hash, @signed_b64, @nonce, @reserved_yocto, 'signed', @day, @now)",
      )
      .run({ ...r, day: dayOf(now), now });
  }

  /** Swaps in a new signing of the same transaction. Only for one the chain refused outright
   *  (a nonce or expiry refusal), which can therefore never land. The row goes back to the shape
   *  `addSpend` writes, so one marked rejected before is counted at its worst case again while in
   *  flight, not at the zero the rejection set (C29). */
  resign(key: string, txHash: string, signedB64: string, nonce: string): void {
    this.db.prepare("UPDATE spend SET tx_hash = ?, signed_b64 = ?, nonce = ?, state = 'signed', refusal = NULL, include_height = NULL, actual_yocto = NULL, finished_ms = NULL WHERE idempotency_key = ?").run(txHash, signedB64, nonce, key);
  }

  markSent(key: string, includeHeight: number | null): void {
    this.db.prepare("UPDATE spend SET state = 'sent', include_height = COALESCE(include_height, ?) WHERE idempotency_key = ? AND state IN ('signed', 'sent')").run(includeHeight, key);
  }

  markFinal(key: string, outcome: 'ok' | 'failed', actualYocto: bigint, refusal: string | null): void {
    this.db.prepare("UPDATE spend SET state = 'final', outcome = ?, actual_yocto = ?, refusal = ?, finished_ms = ? WHERE idempotency_key = ?").run(outcome, actualYocto.toString(), refusal, this.#now(), key);
  }

  markRejected(key: string, refusal: string): void {
    this.db.prepare("UPDATE spend SET state = 'rejected', actual_yocto = '0', refusal = ?, finished_ms = ? WHERE idempotency_key = ?").run(refusal, this.#now(), key);
  }

  recordsOn(network: string, dao: string, day: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM spend WHERE kind = 'record' AND network = ? AND dao = ? AND day = ? AND state != 'rejected'").get(network, dao, day) as { n: number }).n;
  }

  /** NEAR committed on `day`: what final transactions cost, and the worst case of any still in
   *  flight, so a burst can never slip past the cap while its outcomes are pending (C29). */
  spentOn(day: string): bigint {
    const rows = this.db.prepare("SELECT reserved_yocto, actual_yocto, state FROM spend WHERE day = ? AND state != 'rejected'").all(day) as Array<{ reserved_yocto: string; actual_yocto: string | null; state: string }>;
    return rows.reduce((sum, r) => sum + BigInt(r.actual_yocto ?? r.reserved_yocto), 0n);
  }

  addToken(network: string, dao: string, tokenSha256: string, expiresMs: number): void {
    this.db.prepare('INSERT INTO subscribe_tokens (token_sha256, network, dao, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)').run(tokenSha256, network, dao, this.#now(), expiresMs);
  }

  /** Spends a token and subscribes `chatId` to its DAO in one transaction. The update that marks
   *  the token used matches only an unused, unexpired token, so of two redemptions racing for
   *  one token exactly one wins. Returns the subscription, or null when the token is not usable. */
  redeemToken(network: string, tokenSha256: string, chatId: string): SubscriptionRow | null {
    return this.db.transaction(() => {
      const now = this.#now();
      const token = this.db.prepare('SELECT dao FROM subscribe_tokens WHERE token_sha256 = ? AND network = ? AND used_ms IS NULL AND expires_ms > ?').get(tokenSha256, network, now) as { dao: string } | undefined;
      if (!token) return null;
      const spent = this.db.prepare('UPDATE subscribe_tokens SET used_ms = ? WHERE token_sha256 = ? AND used_ms IS NULL').run(now, tokenSha256);
      if (spent.changes !== 1) return null;
      this.db
        .prepare('INSERT INTO subscriptions (network, dao, chat_id, active, created_ms) VALUES (?, ?, ?, 1, ?) ON CONFLICT (network, dao, chat_id) DO UPDATE SET active = 1, ended_ms = NULL')
        .run(network, token.dao, chatId, now);
      const sub = this.db.prepare('SELECT * FROM subscriptions WHERE network = ? AND dao = ? AND chat_id = ?').get(network, token.dao, chatId) as SubscriptionRow;
      this.db.prepare('UPDATE subscribe_tokens SET subscription_id = ? WHERE token_sha256 = ?').run(sub.id, tokenSha256);
      return sub;
    })();
  }

  /** Ends every subscription of one chat on `network`. Returns how many were active. */
  endChat(network: string, chatId: string): number {
    return this.db.prepare('UPDATE subscriptions SET active = 0, ended_ms = ? WHERE network = ? AND chat_id = ? AND active = 1').run(this.#now(), network, chatId).changes;
  }

  subscribers(network: string, dao: string): SubscriptionRow[] {
    return this.db.prepare('SELECT * FROM subscriptions WHERE network = ? AND dao = ? AND active = 1 ORDER BY id').all(network, dao) as SubscriptionRow[];
  }

  /** One active subscription per chat, for alerts that concern every DAO. */
  everyChat(network: string): SubscriptionRow[] {
    return this.db.prepare('SELECT * FROM subscriptions WHERE id IN (SELECT MIN(id) FROM subscriptions WHERE network = ? AND active = 1 GROUP BY chat_id) ORDER BY id').all(network) as SubscriptionRow[];
  }

  chatSubscriptions(network: string, chatId: string): SubscriptionRow[] {
    return this.db.prepare('SELECT * FROM subscriptions WHERE network = ? AND chat_id = ? AND active = 1 ORDER BY id').all(network, chatId) as SubscriptionRow[];
  }

  /** Queues an alert. One with a `dedupe` key already queued or sent is not queued twice, so a
   *  verdict processed again after a restart alerts once. Returns whether it was queued. */
  addAlert(a: Pick<AlertRow, 'network' | 'dao' | 'kind' | 'dedupe' | 'urgent' | 'batch' | 'body' | 'due_ms'>): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO alerts (network, dao, kind, dedupe, urgent, batch, body, state, due_ms, created_ms) VALUES (@network, @dao, @kind, @dedupe, @urgent, @batch, @body, 'queued', @due_ms, @now)")
        .run({ ...a, now: this.#now() }).changes === 1
    );
  }

  /** When the open batch for (`dao`, `batch`) goes out, if one is waiting. */
  openBatchDue(network: string, dao: string, batch: string): number | null {
    const r = this.db.prepare("SELECT MIN(due_ms) AS due FROM alerts WHERE network = ? AND dao = ? AND batch = ? AND urgent = 0 AND state = 'queued'").get(network, dao, batch) as { due: number | null };
    return r.due;
  }

  dueAlerts(network: string, now: number, limit: number): AlertRow[] {
    return this.db.prepare("SELECT * FROM alerts WHERE network = ? AND state = 'queued' AND due_ms <= ? ORDER BY urgent DESC, id LIMIT ?").all(network, now, limit) as AlertRow[];
  }

  /** Every alert on `network` still waiting to go out, due or not. */
  queuedAlerts(network: string): AlertRow[] {
    return this.db.prepare("SELECT * FROM alerts WHERE network = ? AND state = 'queued' ORDER BY id").all(network) as AlertRow[];
  }

  finishAlerts(ids: number[], state: AlertState): void {
    const done = this.db.prepare('UPDATE alerts SET state = ?, done_ms = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) done.run(state, this.#now(), id);
    })();
  }

  retryAlerts(ids: number[], dueMs: number): void {
    const again = this.db.prepare('UPDATE alerts SET tries = tries + 1, due_ms = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) again.run(dueMs, id);
    })();
  }

  addDelivery(d: { subscription_id: number; alert_ids: number[]; urgent: boolean; state: DeliveryState; message_id: number | null; error: string | null }): void {
    this.db
      .prepare('INSERT INTO deliveries (subscription_id, alert_ids, urgent, state, message_id, error, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.subscription_id, d.alert_ids.join(','), d.urgent ? 1 : 0, d.state, d.message_id, d.error, this.#now());
  }

  /** Batched (not urgent) messages that reached `chatId` since `sinceMs`, across its DAOs. */
  batchedSentTo(chatId: string, sinceMs: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id WHERE s.chat_id = ? AND d.urgent = 0 AND d.state = 'sent' AND d.created_ms > ?")
        .get(chatId, sinceMs) as { n: number }
    ).n;
  }

  setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
