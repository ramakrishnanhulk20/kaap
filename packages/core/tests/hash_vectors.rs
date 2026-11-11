// The NEP-413 and NEP-461 hashes against published vectors and the planted records. A NEP-413
// vector is proven by its own published ed25519 signature checking over the hash we compute: a
// signature that verifies means the hash is the one the wallet signed. Not covered here: what a
// text says (hash_attacks.rs), and whether `check` picks the right text for a sign call
// (hash_eval.rs).

mod common;

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use kaap_core::hash::{nep413_hash, nep461_hash, NEP413_TAG, NEP461_TAG};
use serde_json::Value;

struct Nep413Vector {
    source: &'static str,
    message: &'static str,
    nonce: &'static str,
    recipient: &'static str,
    public_key: &'static str,
    signature: &'static str,
}

/// Two NEP-413 messages published with a real signature.
const NEP413_VECTORS: [Nep413Vector; 2] = [
    // defuse-protocol/sdk-monorepo, packages/contract-types/src/validate.test.ts, test
    // "validates nep413 (near) example"; file last changed in aabbd1a (13 Apr 2026), unchanged at
    // HEAD c476ed9 (29 Oct 2026), read 2 Nov 2026.
    Nep413Vector {
        source: "contract-types validate.test.ts",
        message: r#"{"deadline":"2036-04-07T11:14:46.933Z","intents":[],"signer_id":"226a0eceead177138b56937a05f8bdb19b4091a5cdc4419bdea07b3ea0bd9195","external_app_data":{"configs":[{"type":"auth","expires_in":604800}]}}"#,
        nonce: "irwGIo4t0zkK68X8BD+3KmiZuWl6CQlyU0uHmYPh+UI=",
        recipient: "staging-intents.near",
        public_key: "ed25519:3KLfGdhUSYpdYtLvjRXDryT6Za5wEQHvhiJcBN398yjS",
        signature: "ed25519:4i9oAekwJP2JU1eCHF133CVyiAyysJXvFNGjcgaKvPv5Sd8ELPf3NicKny9wXRAupLQ9Us4ZZk2umjJLJjepzVYK",
    },
    // https://docs.near-intents.org/integration/verifier-contract/signing-intents, the NEP-413
    // example, as the page read on 20 Oct 2026.
    Nep413Vector {
        source: "NEAR Intents docs, signing intents",
        message: r#"{"deadline":"2025-05-21T10:34:04.254392Z","intents":[{"intent":"transfer","receiver_id":"bob.near","tokens":{"nep141:usdc.near":"10"}}],"signer_id":"alice.near"}"#,
        nonce: "Vij2xgAlKBKzgNPJFViEQRgYyS7p2NEiYTTY4XmT8go=",
        recipient: "intents.near",
        public_key: "ed25519:C3jXhkGhEx88Gj7XKtUziJKXEBMRaJ67bWFkxJikVxZ2",
        signature: "ed25519:2ns3eCikZFxFA6e9ApunuDG4XwJUPrB8q82fYViBKjheqiDYcCmLN9RnB9NhoEvCdNoS3L3qYD9FAnKd7UkTnuij",
    },
];

/// Two NEP-461 delegate actions on mainnet: the description of each carries the delegate action
/// and the `sign` call carries its hash. Read with `get_proposal` at final block 222701869
/// (hash 55EPfEy3H1qawyMdJj877TVP3cMhkJCXF49uW9YApv9N, 2 Nov 2026 09:41 UTC). Both are Approved.
const NEP461_VECTORS: [(&str, &str, &str); 2] = [
    (
        "templar.sputnik-dao.near #206",
        "HQAAAGlidGMtaWV0aHVzZGMtMS52MS50bXBsci5uZWFyHQAAAGlidGMtaWV0aHVzZGMtMS52MS50bXBsci5uZWFyAQAAAAYARXvRrgFsdsI2IEKN5XWgvKjLLNjaidVGtvbRMxthf06BZ+CO1scAAGz+Jw0AAAAAAF/XSQ1d5VpaO6mGXgGluxl+4u4yLoteIRvyAxEQz2sq",
        "425ecf7fd825ff12d4b326af1dc0ba4f9d27ee5f2f5aa1bafb5f65aff32ba834",
    ),
    (
        "templar.sputnik-dao.near #216",
        "IwAAAGl4bG1kZWphYWEtaXhsbXVzZGMtMS52MS50bXBsci5uZWFyIwAAAGl4bG1kZWphYWEtaXhsbXVzZGMtMS52MS50bXBsci5uZWFyAQAAAAYARXvRrgFsdsI2IEKN5XWgvKjLLNjaidVGtvbRMxthf07BOcCS1scAALX+Jw0AAAAAAM+9sDFjVTc6RyoSqEnZM4AfizilAY+Px4Zwb+ksvqzq",
        "162d113288576438d5cc89d698011f46f0aabd70e96fab796db1e4ac3b0ac485",
    ),
];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn b58(text: &str) -> Vec<u8> {
    bs58::decode(text.strip_prefix("ed25519:").unwrap_or(text)).into_vec().unwrap()
}

fn b64(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}

#[test]
fn the_tags_are_the_nep_461_prefixes() {
    assert_eq!(NEP413_TAG, 2u32.pow(31) + 413);
    assert_eq!(NEP461_TAG, 2u32.pow(30) + 366);
}

#[test]
fn nep413_published_signatures_verify_over_our_hash() {
    for v in &NEP413_VECTORS {
        let nonce: [u8; 32] = b64(v.nonce).try_into().unwrap();
        let hash = nep413_hash(v.message, &nonce, v.recipient, None);
        let key = VerifyingKey::from_bytes(&b58(v.public_key).try_into().unwrap()).unwrap();
        let signature = Signature::from_bytes(&b58(v.signature).try_into().unwrap());
        assert!(key.verify_strict(&hash, &signature).is_ok(), "{}: the published signature does not cover our hash", v.source);

        let mut other = nonce;
        other[0] ^= 1;
        let changed = nep413_hash(v.message, &other, v.recipient, None);
        assert!(key.verify_strict(&changed, &signature).is_err(), "{}: a changed nonce must change the hash", v.source);
        let with_callback = nep413_hash(v.message, &nonce, v.recipient, Some(""));
        assert!(key.verify_strict(&with_callback, &signature).is_err(), "{}: Some(\"\") is not None", v.source);
    }
}

#[test]
fn nep461_reproduces_the_mainnet_payloads() {
    for (source, bytes, payload) in NEP461_VECTORS {
        assert_eq!(hex(&nep461_hash(&b64(bytes))), payload, "{source}");
    }
}

/// Families j and k and the auth control: k and the control hash to their payload, j is built
/// not to (PLANTED.md, "Notes on the sharper cases").
#[test]
fn planted_texts_hash_as_labelled() {
    let matches = ["planted:32", "planted:33", "planted:34", "planted:62"];
    let differs = ["planted:29", "planted:30", "planted:31"];
    for id in matches.iter().chain(&differs) {
        let record = common::record(common::PLANTED, id);
        let text = &record["supplied_text"];
        let nonce: [u8; 32] = b64(text["nonce"].as_str().unwrap()).try_into().unwrap();
        let hash = nep413_hash(text["message"].as_str().unwrap(), &nonce, text["recipient"].as_str().unwrap(), None);
        let action = &record["kind"]["FunctionCall"]["actions"][0];
        let args: Value = serde_json::from_slice(&b64(action["args"].as_str().unwrap())).unwrap();
        let payload = args["request"]["payload_v2"]["Eddsa"].as_str().unwrap();
        assert_eq!(hex(&hash) == payload, matches.contains(id), "{id}");
    }
}
