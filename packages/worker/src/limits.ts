// Bounds on what one enrolled account can make the worker take up (C21, C29). Anyone can enrol
// an account in the guard, so none of these may rest on the account behaving like a treasury.

/** The most new proposal ids of one DAO the worker takes up in one pass, its first backfill and
 *  every counter pass alike. When more are new, the newest are taken and the rest are said. */
export const MAX_IDS_PER_PASS = 50;

/** A proposal counter this far past the last id taken up is no treasury's: a real one would need
 *  ten thousand proposals filed between two looks a second apart. */
export const MAX_COUNTER_JUMP = 10_000;

/** Treasuries watched at once unless KAAP_MAX_WATCHED_DAOS says otherwise. */
export const DEFAULT_MAX_WATCHED_DAOS = 200;
/** The longest expiry the sealed program signs (its MAX_EXPIRES_IN_MS). A run that asks for more
 *  is refused there, so a larger setting stops the worker at start. */
export const MAX_VERDICT_TTL_MS = 900_000;

/** Sputnik's own default for how long a proposal stays open, used for a DAO whose policy states
 *  no period the worker could read: seven days. */
export const DEFAULT_PROPOSAL_PERIOD_MS = 7 * 24 * 3_600_000;
