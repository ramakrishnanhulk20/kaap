// One JSON object per line on stdout. Every line passes through `redact` before it is written, so
// no code path, error message or stack trace can print the worker's key, whatever object it hands
// the logger.

export type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// A NEAR secret key is "ed25519:" or "secp256k1:" followed by the base58 of 64 bytes (about 88
// characters). Public keys are 32 bytes (43 or 44 characters), so 60 or more cannot be one.
const SECRET_KEY = /\b(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{60,}/g;
const SECRET_FIELD = /^(private_?key|secret_?key|seed_?phrase|secret|password|token|api_?key)$/i;
const REDACTED = '[redacted]';
const MAX_STRING = 2_000;

const known = new Set<string>();

/** Registers an exact secret, such as the loaded private key and its bare base58 body, so it is
 *  cut from every later line however it got there. Very short strings are refused, since they
 *  would erase ordinary text. */
export function addSecret(secret: string): void {
  if (secret.length < 16) throw new Error('refusing to register a secret shorter than 16 characters');
  known.add(secret);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of known) out = out.split(secret).join(REDACTED);
  return out.replace(SECRET_KEY, REDACTED);
}

function plain(value: unknown, depth: number): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}[cut]` : value;
  if (value instanceof Error) return { error: value.name, message: plain(value.message, depth + 1), stack: plain(value.stack ?? '', depth + 1) };
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => plain(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELD.test(k) ? REDACTED : plain(v, depth + 1);
    return out;
  }
  return value;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: Level, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const at = (lvl: Level) => (event: string, fields: Record<string, unknown> = {}) => {
    if (RANK[lvl] < RANK[level]) return;
    let line: string;
    try {
      // A field may never overwrite the line's own time, level or event name.
      const own = Object.fromEntries(Object.entries(plain(fields, 0) as object).map(([k, v]) => [k === 't' || k === 'level' || k === 'event' ? `${k}_field` : k, v]));
      line = JSON.stringify({ t: new Date().toISOString(), level: lvl, event, ...own });
    } catch {
      line = JSON.stringify({ t: new Date().toISOString(), level: lvl, event, note: 'fields could not be written' });
    }
    write(redact(line));
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
