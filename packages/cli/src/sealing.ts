// The member's side of Kaap's sealed text channel, in the same bytes as packages/sealed/src/texts.rs
// and scripts/WO-05b-text-roundtrip.mjs, with Node's own crypto: an ephemeral X25519 exchange,
// HKDF-SHA256 with no salt, ChaCha20-Poly1305, written `0x01 | ephemeral public key (32) | nonce
// (12) | ciphertext | tag (16)`, and bound through the associated data to the network, the DAO, the
// proposal and the member's reply key. Rust cannot check these constants from here; a change on
// either side fails the round-trip test in test/seal-text.test.ts.
//
// Every secret here is a KeyObject in memory. Nothing in this file writes, prints or exports one.

import * as crypto from 'node:crypto';

import type { Network } from './rpc.js';
import { ed25519Valid } from './verdict.js';

/** In front of the program's X25519 key in what its verdict key signs (texts.rs `TEXT_KEY_DOMAIN`). */
const TEXT_KEY_DOMAIN = Buffer.from('kaap-text-key-v1\n', 'utf8');
const HKDF_INFO = 'kaap-texts-v1';
const TEXT_DOMAIN = 'kaap-text-v1';
const EXPLANATION_DOMAIN = 'kaap-explanation-v1';

/** In front of the base64 of a sealed explanation (texts.rs `SEALED_PREFIX`). */
export const SEALED_PREFIX = 'sealed:';

const FORMAT = 0x01;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** How much longer a sealed blob is than what it seals (texts.rs `ECIES_OVERHEAD`). */
export const OVERHEAD = 1 + KEY_BYTES + NONCE_BYTES + TAG_BYTES;

/** The fixed DER header of an X25519 SubjectPublicKeyInfo (RFC 8410), then the 32 key bytes. */
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export interface X25519Pair {
  privateKey: crypto.KeyObject;
  /** The 32 public key bytes. */
  publicKey: Buffer;
}

/** Where key pairs and nonces come from: the system's random source, a fixed one in tests. */
export interface Fresh {
  pair(): X25519Pair;
  bytes(n: number): Buffer;
}

export const cryptoFresh: Fresh = {
  pair: () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return { privateKey, publicKey: rawPublicKey(publicKey) };
  },
  bytes: (n) => crypto.randomBytes(n),
};

export class SealingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealingError';
  }
}

/** The 32 bytes of an X25519 public KeyObject. */
export function rawPublicKey(key: crypto.KeyObject): Buffer {
  const { x } = key.export({ format: 'jwk' });
  if (typeof x !== 'string') throw new SealingError('the key has no public part');
  return Buffer.from(x, 'base64url');
}

/** True when `signature` is `verdictKey`'s ed25519 signature over the text key domain and `textKey`:
 *  the sealed program vouching, with the key the guard accepts, that `textKey` is its own. */
export function textKeySigned(verdictKey: Uint8Array, textKey: Uint8Array, signature: Uint8Array): boolean {
  return textKey.length === KEY_BYTES && ed25519Valid(verdictKey, Buffer.concat([TEXT_KEY_DOMAIN, textKey]), signature);
}

function bound(domain: string, network: Network, dao: string, proposalId: number, replyKey: Uint8Array): Buffer {
  // The reply key is written from its bytes, so the two sides cannot differ in letter case.
  return Buffer.from(`${domain}\n${network}\n${dao}\n${proposalId}\n${Buffer.from(replyKey).toString('hex')}`, 'utf8');
}

/** The associated data of a text sent to the sealed program (texts.rs `text_context`). */
export function textContext(network: Network, dao: string, proposalId: number, replyKey: Uint8Array): Buffer {
  return bound(TEXT_DOMAIN, network, dao, proposalId, replyKey);
}

/** The associated data of an explanation sent back (texts.rs `explanation_context`). */
export function explanationContext(network: Network, dao: string, proposalId: number, replyKey: Uint8Array): Buffer {
  return bound(EXPLANATION_DOMAIN, network, dao, proposalId, replyKey);
}

/** HKDF with no salt, as OutLayer's `eciesEncrypt` and the Rust `Hkdf::new(None, ..)`: an empty
 *  salt and RFC 5869's zeros give one key. OpenSSL refuses a low-order peer key, whose shared
 *  secret is zero, which is the Rust side's `was_contributory` check. */
function aeadKey(privateKey: crypto.KeyObject, peer: Uint8Array): Buffer {
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, peer]), format: 'der', type: 'spki' });
  return Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey, publicKey }), Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

/** Seals `plaintext` to the X25519 key `recipient`, bound to `aad`, with a fresh ephemeral key and
 *  nonce from `fresh`. Throws `SealingError` when `recipient` is not a key an exchange can use. */
export function sealTo(recipient: Uint8Array, plaintext: Uint8Array, aad: Uint8Array, fresh: Fresh): Buffer {
  if (recipient.length !== KEY_BYTES) throw new SealingError('the key is not 32 bytes');
  const ephemeral = fresh.pair();
  const nonce = fresh.bytes(NONCE_BYTES);
  let key: Buffer;
  try {
    key = aeadKey(ephemeral.privateKey, recipient);
  } catch {
    throw new SealingError('the key is not one an X25519 exchange can use');
  }
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), ephemeral.publicKey, nonce, body, cipher.getAuthTag()]);
}

/** Opens what `sealTo`, or the sealed program's `ecies_encrypt`, made for `privateKey`'s public key
 *  under the same `aad`. Null for every failure alike: another format, a short blob, a low-order
 *  ephemeral key, a changed byte, another key, another `aad`. */
export function openSealed(privateKey: crypto.KeyObject, blob: Uint8Array, aad: Uint8Array): Buffer | null {
  if (blob.length < OVERHEAD || blob[0] !== FORMAT) return null;
  const b = Buffer.from(blob);
  try {
    const nonce = b.subarray(1 + KEY_BYTES, 1 + KEY_BYTES + NONCE_BYTES);
    const decipher = crypto.createDecipheriv('chacha20-poly1305', aeadKey(privateKey, b.subarray(1, 1 + KEY_BYTES)), nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: b.length - OVERHEAD });
    decipher.setAuthTag(b.subarray(b.length - TAG_BYTES));
    return Buffer.concat([decipher.update(b.subarray(1 + KEY_BYTES + NONCE_BYTES, b.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}
