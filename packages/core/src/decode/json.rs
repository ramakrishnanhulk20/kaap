//! The one strict JSON reader for FunctionCall `args` and for the `msg` strings inside them
//! (standard 2). A duplicate object key at any depth is its own outcome rather than a lenient
//! reading: serde_json keeps the last value of `{"a":1,"a":2}`, a receiver contract may keep the
//! first or refuse the call, and the decoder must never describe a call one way while the chain
//! runs it another. Trailing data and nesting deeper than serde_json's limit of 128 are not JSON.
//!
//! Numbers are kept as serde_json reads them. An integer beyond 64 bits or a fraction becomes a
//! float, so such a number shown inside an `unknown_call` may be rounded; no effect amount is read
//! from a JSON number, because every token and NEAR amount on NEAR is a string.

use std::cell::Cell;
use std::fmt;

use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum Parsed {
    Json(Value),
    NotJson,
    /// Valid JSON apart from an object with the same key twice.
    DuplicateKey,
}

/// Reads `bytes` as exactly one JSON value.
pub fn parse(bytes: &[u8]) -> Parsed {
    let duplicate = Cell::new(false);
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let read = Seed(&duplicate).deserialize(&mut de).and_then(|v| de.end().map(|()| v));
    match read {
        Ok(value) => Parsed::Json(value),
        Err(_) if duplicate.get() => Parsed::DuplicateKey,
        Err(_) => Parsed::NotJson,
    }
}

/// Carries the flag that tells a duplicate key apart from any other parse error, since serde's
/// error type cannot carry it.
#[derive(Clone, Copy)]
struct Seed<'a>(&'a Cell<bool>);

impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON with unique object keys")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(Value::from(v))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(Value::from(v))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        Number::from_f64(v).map(Value::Number).ok_or_else(|| E::custom("number is not finite"))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(self)? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut fields = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if fields.contains_key(&key) {
                self.0.set(true);
                return Err(de::Error::custom(format!("duplicate key {key:?}")));
            }
            let value = map.next_value_seed(self)?;
            fields.insert(key, value);
        }
        Ok(Value::Object(fields))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_reading_or_none() {
        assert_eq!(parse(br#" {"a":[1,{"b":"c"}]} "#), Parsed::Json(serde_json::json!({"a": [1, {"b": "c"}]})));
        assert_eq!(parse(br#"{"a":1,"a":2}"#), Parsed::DuplicateKey);
        assert_eq!(parse(br#"[{"x":{"y":1,"y":1}}]"#), Parsed::DuplicateKey);
        for bad in [&b""[..], b" \t\n", b"{", b"{} {}", b"proofoffinger.near", b"773854c8", &[0xde, 0xad]] {
            assert_eq!(parse(bad), Parsed::NotJson, "{bad:?}");
        }
        let deep = "[".repeat(200) + &"]".repeat(200);
        assert_eq!(parse(deep.as_bytes()), Parsed::NotJson);
    }
}
