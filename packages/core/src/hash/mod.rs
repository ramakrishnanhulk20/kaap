//! The `sign_request` effect of a FunctionCall to `v1.signer` method `sign`, and the hash
//! checks on any text behind its payload (guide sections 3 and 4, rulings 11 and 12; C6 to C8).
//!
//! A text comes from one of two places: the record's `supplied_text`, which a member hands in, or
//! a Templar delegate action printed in the description. It counts only when its NEP-413 or
//! NEP-461 hash, recomputed from the exact bytes received, equals the payload; those same bytes
//! are then read by one strict reader (standard 2). Without such a text a `sign` call is
//! HASH_UNVERIFIED: unknown, counted as high, never low, and never enough for a veto on its own
//! (C8).

pub mod delegate;
pub mod intents;
pub mod nep;
pub mod quote;
pub mod sign;
pub mod text;

pub use nep::{nep413_hash, nep461_hash, NEP413_TAG, NEP461_TAG};

use num_bigint::BigUint;

use crate::types::{Effect, FindingCode, ProposalInput, TextSource, TextStandard};
use sign::{Request, Unread};

/// Returns the effects and findings of every `sign` action in `input`'s FunctionCall, and nothing
/// for any other kind.
///
/// For each `sign` action: a `sign_request` effect; a `transfer` with ATTACHED_DEPOSIT when it
/// attaches more than 1 yoctoNEAR; and one of these, in this order of precedence:
/// - a supplied text that hashes to no `sign` payload: `text_supplied` true and HASH_MISMATCH;
/// - a text that hashes to the payload but has no single reading: HASH_TEXT_DANGEROUS;
/// - a NEP-413 text whose deadline is not after `block_timestamp_ns`: it can never execute, so it
///   is not counted: `text_supplied` false, HASH_UNVERIFIED, with `text_source` and
///   `text_standard` kept to say that a text came and why it was not counted;
/// - a NEP-413 text read one way: what its intents authorise (`intents::judge`);
/// - a NEP-461 delegate action: one `unknown_call` per action with UNKNOWN_CALL (ruling 11);
/// - no text: HASH_UNVERIFIED.
///
/// One supplied text verifies at most one `sign` action; the others stay HASH_UNVERIFIED unless
/// the description carries their text. Arguments that are not one sign request make the action
/// an `unknown_call` with UNKNOWN_CALL. Never panics on any input (standard 4).
pub fn check(input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let Some(call) = sign::read_call(&input.kind_json) else {
        return (Vec::new(), Vec::new());
    };
    let mut sheet = Sheet::default();
    let mut requests = Vec::new();
    for action in call.signs() {
        sheet.attached_deposit(&call.receiver, &action.deposit, input);
        match sign::read_request(&action.args) {
            Ok(request) => requests.push(request),
            Err(unread) => sheet.unknown_sign(&call.receiver, unread, &action.deposit),
        }
    }
    let texts = Texts::read(input);
    let supplied_for = requests.iter().position(|r| texts.supplied_hash.is_some_and(|h| h[..] == r.payload[..]));
    let mismatch = input.supplied_text.as_ref().filter(|_| supplied_for.is_none()).map(|t| t.standard);
    for (i, request) in requests.iter().enumerate() {
        let described = texts.described.iter().find(|(_, hash)| hash[..] == request.payload[..]);
        if supplied_for == Some(i) {
            sheet.supplied(&call.receiver, request, input);
        } else if let Some((bytes, _)) = described {
            sheet.delegate(&call.receiver, request, bytes, TextSource::Description);
        } else if let Some(standard) = mismatch {
            sheet.push(sign_request(&call.receiver, request, true, Some(TextSource::Planted), Some(standard)));
            sheet.codes.push(FindingCode::HashMismatch);
        } else {
            sheet.unverified(&call.receiver, request);
        }
    }
    (sheet.effects, sheet.codes)
}

/// The texts a proposal comes with, each with the hash it would sign.
struct Texts {
    /// `None` when there is no supplied text, or when it cannot be hashed at all (a NEP-461
    /// text whose message is not base64), which then matches no payload.
    supplied_hash: Option<[u8; 32]>,
    described: Vec<(Vec<u8>, [u8; 32])>,
}

impl Texts {
    fn read(input: &ProposalInput) -> Self {
        let supplied_hash = input.supplied_text.as_ref().and_then(|t| match t.standard {
            TextStandard::Nep413 => Some(nep413_hash(&t.message, &t.nonce, &t.recipient, None)),
            TextStandard::Nep461 => base64_bytes(&t.message).map(|bytes| nep461_hash(&bytes)),
        });
        let described = delegate::in_description(&input.description)
            .into_iter()
            .map(|bytes| {
                let hash = nep461_hash(&bytes);
                (bytes, hash)
            })
            .collect();
        Texts { supplied_hash, described }
    }
}

/// Runs `decode::value` on `input` with `kind` in place of its own kind. This is how a text's
/// intents and a sign call's extra NEAR are read by the one value reader, with the DAO,
/// history and prices of the real proposal.
fn decode_as(kind: &serde_json::Value, input: &ProposalInput) -> (Vec<Effect>, Vec<FindingCode>) {
    let mut built = input.clone();
    built.kind_json = serde_json::to_vec(kind).unwrap_or_default();
    crate::decode::value::decode(&built)
}

fn base64_bytes(text: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

fn sign_request(
    mpc: &str,
    request: &Request,
    text_supplied: bool,
    text_source: Option<TextSource>,
    text_standard: Option<TextStandard>,
) -> Effect {
    Effect::SignRequest {
        mpc: mpc.to_string(),
        path: request.path.clone(),
        domain_id: request.domain_id,
        payload_hash: sign::to_hex(&request.payload),
        text_supplied,
        text_source,
        text_standard,
    }
}

#[derive(Default)]
struct Sheet {
    effects: Vec<Effect>,
    codes: Vec<FindingCode>,
}

impl Sheet {
    fn push(&mut self, effect: Effect) {
        self.effects.push(effect);
    }

    fn unverified(&mut self, mpc: &str, request: &Request) {
        self.push(sign_request(mpc, request, false, None, None));
        self.codes.push(FindingCode::HashUnverified);
    }

    /// NEAR attached beyond the 1 yoctoNEAR security deposit counts as sent to the MPC contract,
    /// as `decode::value` counts it for every other call (C2), and is read by `decode::value` as
    /// that transfer so its value findings come from the same place.
    fn attached_deposit(&mut self, mpc: &str, deposit: &BigUint, input: &ProposalInput) {
        if *deposit > BigUint::from(1u8) {
            let kind = serde_json::json!({"Transfer": {"token_id": "", "receiver_id": mpc, "amount": deposit.to_string(), "msg": null}});
            let (effects, codes) = decode_as(&kind, input);
            self.effects.extend(effects);
            self.codes.extend(codes);
            self.codes.push(FindingCode::AttachedDeposit);
        }
    }

    fn unknown_sign(&mut self, mpc: &str, unread: Unread, deposit: &BigUint) {
        let args = match unread {
            Unread::Shape(value) => value,
            Unread::NotJson => {
                self.codes.push(FindingCode::ArgsNotJson);
                serde_json::Value::String("not_json".into())
            }
        };
        self.push(Effect::UnknownCall { receiver: mpc.to_string(), method: "sign".into(), args, deposit: deposit.to_string() });
        self.codes.push(FindingCode::UnknownCall);
    }

    /// The supplied text matched `request`'s payload.
    fn supplied(&mut self, mpc: &str, request: &Request, input: &ProposalInput) {
        let Some(t) = &input.supplied_text else { return };
        match t.standard {
            TextStandard::Nep461 => {
                let bytes = base64_bytes(&t.message).unwrap_or_default();
                self.delegate(mpc, request, &bytes, TextSource::Planted);
            }
            TextStandard::Nep413 => {
                let read = text::read(&t.message, &t.recipient, &request.path, &input.dao);
                let expired = |m: &text::Message| input.block_timestamp_ns.is_some_and(|now| m.deadline_ns <= i128::from(now));
                match read {
                    Err(_) => {
                        self.push(sign_request(mpc, request, true, Some(TextSource::Planted), Some(TextStandard::Nep413)));
                        self.codes.push(FindingCode::HashTextDangerous);
                    }
                    Ok(message) if expired(&message) => {
                        self.push(sign_request(mpc, request, false, Some(TextSource::Planted), Some(TextStandard::Nep413)));
                        self.codes.push(FindingCode::HashUnverified);
                    }
                    Ok(message) => {
                        self.push(sign_request(mpc, request, true, Some(TextSource::Planted), Some(TextStandard::Nep413)));
                        let quotes = quote::verified(&t.quotes);
                        let (effects, codes) = intents::judge(&message.intents, &t.recipient, message.deadline_ns, &quotes, input);
                        self.effects.extend(effects);
                        self.codes.extend(codes);
                    }
                }
            }
        }
    }

    /// A NEP-461 delegate action matched `request`'s payload.
    fn delegate(&mut self, mpc: &str, request: &Request, bytes: &[u8], source: TextSource) {
        self.push(sign_request(mpc, request, true, Some(source), Some(TextStandard::Nep461)));
        match delegate::read(bytes) {
            Some(action) => {
                let (effects, args_not_json) = delegate::effects(&action);
                self.effects.extend(effects);
                self.codes.push(FindingCode::UnknownCall);
                if args_not_json {
                    self.codes.push(FindingCode::ArgsNotJson);
                }
            }
            None => self.codes.push(FindingCode::HashTextDangerous),
        }
    }
}
