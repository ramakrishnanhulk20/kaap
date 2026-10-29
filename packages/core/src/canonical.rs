//! The one canonical form of a proposal kind and of a policy, and the hashes built on it (C5,
//! C14). Nobody hashes a kind or a policy any other way.
//!
//! Sputnik keeps a role's members and permissions in hash sets and its vote policies in a map,
//! so the JSON it returns can list them in another order between two reads with no edit in
//! between (seen on a live DAO between 24 and 26 Oct 2026). The canonical form therefore sorts
//! every object's keys, a `Group` role's member list and a role's `permissions` list, and
//! nothing else. Every other array keeps its order, because there the order is meaning: `roles`
//! decides which of two same-named roles wins (C1), and FunctionCall `actions` run in sequence.
//! The two sets are sorted only where Sputnik puts a role (`ChangePolicy.policy.roles[]`,
//! `ChangePolicyAddOrUpdateRole.role`, a policy's `roles[]`), never wherever a key happens to be
//! called `permissions`, so an array whose order matters elsewhere is never sorted by accident.
//!
//! The parser is stricter than serde_json's default, so two readers can never take one input
//! two ways (standard 2): a duplicate object key, a number that is not a whole number within 64
//! bits, trailing data, nesting deeper than serde_json's limit of 128, or input over 256 KiB is an
//! error. Sputnik writes every amount, gas value and quorum as a string, so a real kind or policy
//! only ever holds small whole numbers.
//!
//! Keys are written in byte order by this module itself rather than through `serde_json::Map`,
//! whose order silently changes if any crate in the build turns on serde_json's
//! `preserve_order` feature.
//!
//! These bytes exist only to be hashed. The kind sent with VoteReject is always the exact bytes
//! read from `get_proposal`, never this form (C5).

use std::collections::BTreeSet;
use std::fmt;
use std::io::Write;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};

/// Inputs above this are refused (standard 4). Sputnik's largest real kinds, full ChangePolicy
/// proposals of big DAOs, are a few tens of KiB.
pub const MAX_CANON_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CanonError {
    TooLarge { len: usize, max: usize },
    Invalid(String),
}

impl fmt::Display for CanonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CanonError::TooLarge { len, max } => {
                write!(f, "input is {len} bytes, over the {max} byte limit")
            }
            CanonError::Invalid(why) => write!(f, "not canonicalisable JSON: {why}"),
        }
    }
}

impl std::error::Error for CanonError {}

/// Returns the canonical form of a `ProposalKind` as `get_proposal` returns it.
///
/// Errors with `TooLarge` above `MAX_CANON_BYTES` and `Invalid` on anything the strict parser
/// refuses. An unrecognised kind is still canonicalised (keys sorted, arrays kept in order).
pub fn canonical_kind(kind_json: &[u8]) -> Result<Vec<u8>, CanonError> {
    let mut root = parse(kind_json)?;
    if let Node::Object(variants) = &mut root {
        for (variant, body) in variants.iter_mut() {
            match variant.as_str() {
                "ChangePolicy" => {
                    if let Some(policy) = field_mut(body, "policy") {
                        sort_policy_sets(policy);
                    }
                }
                "ChangePolicyAddOrUpdateRole" => {
                    if let Some(role) = field_mut(body, "role") {
                        sort_role_sets(role);
                    }
                }
                _ => {}
            }
        }
    }
    Ok(encode(&root))
}

/// Returns the canonical form of a policy as `get_policy` returns it. Same errors as
/// `canonical_kind`.
pub fn canonical_policy(policy_json: &[u8]) -> Result<Vec<u8>, CanonError> {
    let mut root = parse(policy_json)?;
    sort_policy_sets(&mut root);
    Ok(encode(&root))
}

/// sha256 of `canonical_kind`: the `kind_hash` a verdict carries and the guard recomputes from
/// the bytes it forwards.
pub fn kind_hash(kind_json: &[u8]) -> Result<[u8; 32], CanonError> {
    Ok(sha256(&canonical_kind(kind_json)?))
}

/// sha256 of `canonical_policy`: the `policy_hash` a verdict carries.
pub fn policy_hash(policy_json: &[u8]) -> Result<[u8; 32], CanonError> {
    Ok(sha256(&canonical_policy(policy_json)?))
}

pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

enum Node {
    Null,
    Bool(bool),
    Int(i128),
    Str(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

fn parse(bytes: &[u8]) -> Result<Node, CanonError> {
    if bytes.len() > MAX_CANON_BYTES {
        return Err(CanonError::TooLarge { len: bytes.len(), max: MAX_CANON_BYTES });
    }
    serde_json::from_slice::<Node>(bytes).map_err(|e| CanonError::Invalid(e.to_string()))
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(NodeVisitor)
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON with unique keys and whole numbers only")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Node, E> {
        Ok(Node::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Node, E> {
        Ok(Node::Int(v.into()))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Node, E> {
        Ok(Node::Int(v.into()))
    }

    // serde_json hands over a float for any fraction, exponent, "-0" or whole number beyond 64
    // bits. Each could be written more than one way, so none has a single canonical form.
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Node, E> {
        Err(E::custom("number is not a whole number within 64 bits"))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Node, E> {
        Ok(Node::Str(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Node, E> {
        Ok(Node::Str(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Node>()? {
            items.push(item);
        }
        Ok(Node::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let mut seen = BTreeSet::new();
        let mut fields = Vec::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom(format!("duplicate key {key:?}")));
            }
            let value = map.next_value::<Node>()?;
            fields.push((key, value));
        }
        Ok(Node::Object(fields))
    }
}

fn field_mut<'a>(node: &'a mut Node, key: &str) -> Option<&'a mut Node> {
    match node {
        Node::Object(fields) => fields.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn sort_policy_sets(policy: &mut Node) {
    if let Some(Node::Array(roles)) = field_mut(policy, "roles") {
        roles.iter_mut().for_each(sort_role_sets);
    }
}

fn sort_role_sets(role: &mut Node) {
    if let Some(Node::Array(permissions)) = field_mut(role, "permissions") {
        sort_set(permissions);
    }
    if let Some(kind) = field_mut(role, "kind") {
        if let Some(Node::Array(members)) = field_mut(kind, "Group") {
            sort_set(members);
        }
    }
}

// Ordered by each element's own canonical bytes, which is a total order on any JSON, so every
// permutation of the set writes the same output.
fn sort_set(items: &mut [Node]) {
    items.sort_by_cached_key(encode);
}

fn encode(node: &Node) -> Vec<u8> {
    let mut out = Vec::new();
    write_node(node, &mut out);
    out
}

// Writing into a Vec cannot fail, so the io results below are discarded on purpose.
fn write_node(node: &Node, out: &mut Vec<u8>) {
    match node {
        Node::Null => out.extend_from_slice(b"null"),
        Node::Bool(true) => out.extend_from_slice(b"true"),
        Node::Bool(false) => out.extend_from_slice(b"false"),
        Node::Int(n) => {
            let _ = write!(out, "{n}");
        }
        Node::Str(s) => write_str(s, out),
        Node::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_node(item, out);
            }
            out.push(b']');
        }
        Node::Object(fields) => {
            let mut sorted: Vec<&(String, Node)> = fields.iter().collect();
            sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            out.push(b'{');
            for (i, (key, value)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_str(key, out);
                out.push(b':');
                write_node(value, out);
            }
            out.push(b'}');
        }
    }
}

fn write_str(s: &str, out: &mut Vec<u8>) {
    let _ = serde_json::to_writer(&mut *out, s);
}
