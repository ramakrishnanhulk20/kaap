// NEAR amounts are yoctoNEAR bigints everywhere in the worker. Text is turned into one only here,
// and never through a float (threat model standard 2).

export const YOCTO_PER_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
/** The protocol's minimum gas price, 100,000,000 yoctoNEAR a unit (packages/contracts/GAS.md). */
export const MIN_GAS_PRICE = 100_000_000n;
/** What one byte of account storage locks: 10^19 yoctoNEAR, so 100 KB is 1 NEAR. */
export const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

/** Whole NEAR or a decimal with at most 24 fraction digits, such as "1" or "0.02". Anything else,
 *  signs, exponents and spaces included, gives null. */
export function parseNear(text: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,24}))?$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1] ?? '0');
  const fraction = BigInt((m[2] ?? '').padEnd(24, '0') || '0');
  return whole * YOCTO_PER_NEAR + fraction;
}

export function formatNear(yocto: bigint): string {
  const sign = yocto < 0n ? '-' : '';
  const abs = yocto < 0n ? -yocto : yocto;
  const whole = abs / YOCTO_PER_NEAR;
  const fraction = (abs % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, 6);
  return `${sign}${whole}.${fraction}`;
}

/** The most a transaction can cost its signer before it runs: all attached gas at `gasPrice` plus
 *  the deposit. What is not burnt comes back, so this is the figure a cap must reserve. */
export function worstCase(gas: bigint, deposit: bigint, gasPrice = MIN_GAS_PRICE): bigint {
  return gas * gasPrice + deposit;
}
