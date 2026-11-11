// Every limit the CLI works under, in one place. C31 asks the proof CLIs to apply the same caps as
// the services, so each value names the service it is taken from. A limit that is reached is a
// clear refusal or an "unknown", never a silent cut.

/** The largest view result read for one proposal, a policy or a factory list: the sealed job's
 *  `MAX_VIEW_BYTES`. */
export const MAX_VIEW_BYTES = 512 * 1024;

/** JSON-RPC writes each result byte as up to four characters, so the body cap is four times the
 *  result cap plus room for the envelope (the sealed job's `RPC_LIMITS`). */
export const MAX_VIEW_BODY_BYTES = 4 * MAX_VIEW_BYTES + 64 * 1024;

/** A page of `get_proposals` or the factory's DAO list: the worker's `MAX_ANSWER_BYTES`. A page
 *  over this is asked for again in smaller pieces. */
export const MAX_PAGE_BODY_BYTES = 4 * 1024 * 1024;

/** One RPC exchange, connect to last byte: the sealed job's `overall_ms`. */
export const RPC_TIMEOUT_MS = 15_000;

/** Tries per RPC call, counting the first. A provider that refuses (HTTP 429 or 503) or fails to
 *  answer is asked again after 1, 2 and 4 seconds, or after its Retry-After up to 10 seconds. */
export const RPC_TRIES = 4;
export const MAX_RETRY_WAIT_MS = 10_000;

/** Requests a second across every provider, the census scripts' `lib.mjs` limit, which both free
 *  providers held for 10,600 calls without refusing. */
export const REQUESTS_PER_SECOND = 5;

/** `get_proposals` page size. Sputnik returns at most what is stored in the range. */
export const PAGE_SIZE = 100;

/** Pages of history read for one check: 5,000 proposal ids. A DAO with more has no history and no
 *  rebuilt policy in the CLI, and says so. */
export const MAX_HISTORY_PAGES = 50;

/** The 1Click token list is about 50 KiB. */
export const MAX_PRICE_LIST_BYTES = 1024 * 1024;

/** How much of an attacker-written text the terminal output shows. */
export const MAX_SHOWN_TEXT = 2_000;

/** How far `kaap verify` looks for the sealed run of a verdict, in blocks before and after the
 *  block the verdict was read at. Every run measured so far landed 4 to 6 blocks before that
 *  block (packages/sealed/RUNS.md, PROOF-M1.md), and a run is given at most 180 seconds, about
 *  300 blocks, so 60 back covers a slow pickup without reading half an hour of chain. The verdict
 *  is read at the final block the job saw, which can trail the request by a block or two, hence
 *  the look ahead. A run outside the window is reported as not found, never guessed. */
export const RUN_SCAN_BACK = 60;
export const RUN_SCAN_AHEAD = 4;

/** An OutLayer attestation is about 7.5 KiB, most of it the 5 KB Intel quote. */
export const MAX_ATTESTATION_BYTES = 256 * 1024;

/** The worker's answer to POST /subscribe is a few hundred bytes (packages/worker/src/status.ts). */
export const MAX_WORKER_ANSWER_BYTES = 4 * 1024;

/** The text file `kaap seal-text` reads. A text bigger than this could not fit in a sealed run's
 *  input anyway (MAX_RUN_INPUT_BYTES), so a larger file is refused before it is read. */
export const MAX_TEXT_FILE_BYTES = 64 * 1024;

/** The most input the sealed job reads (packages/sealed/src/input.rs `MAX_INPUT_BYTES`, the
 *  worker's `MAX_RUN_INPUT_BYTES`): the run's JSON with the ciphertext in it as base64, which leaves
 *  about 24 KiB for the ciphertext itself. */
export const MAX_RUN_INPUT_BYTES = 32_768;

/** The longest verdict life the sealed job takes (input.rs `MAX_EXPIRES_IN_MS`) and the worker's
 *  KAAP_VERDICT_TTL_MS allows. The run input is counted with it, so never shorter than the worker
 *  counts it. */
export const MAX_EXPIRES_IN_MS = 3_600_000;

/** POST /texts answers once the sealed run has landed, about 10 to 30 seconds when it goes well.
 *  Node's fetch stops waiting for an answer's headers after 5 minutes whatever is asked, so that is
 *  the cap. The request is never sent twice: a second one would be a second paid run. */
export const TEXT_ANSWER_TIMEOUT_MS = 300_000;

/** The judged answer: a verdict summary and a sealed explanation from a sealed output of at most
 *  900 bytes (packages/sealed/src/output.rs). */
export const MAX_TEXT_ANSWER_BYTES = 16 * 1024;
