//! Today's USD prices from 1Click's public token list (`GET /v0/tokens`, no key), the list `kaap
//! check` and the evaluation price with. kaap-core turns it into its price table, so a token is keyed
//! by its exact contract id, never by symbol (C3), and priced alike everywhere.
//!
//! What this does not cover: a wrong price on the list. There is one source and nothing to compare
//! it with. A payment and the history it is measured against use the same list, so one token's wrong
//! price cancels out of LARGE_AMOUNT's comparison unless the history was paid in other tokens.

use kaap_core::prices::prices_from_tokens;
use kaap_core::Prices;

use crate::net::{Deadline, Http, Limits, Method, Request, ONECLICK_TOKENS};

pub const PRICE_LIST_URL: &str = "https://1click.chaindefuser.com/v0/tokens";

/// The CLI's `MAX_PRICE_LIST_BYTES`. The list is about 55 KiB.
pub const MAX_PRICE_LIST_BYTES: usize = 1024 * 1024;

const PRICE_LIMITS: Limits =
    Limits { connect_ms: 5_000, first_byte_ms: 8_000, between_bytes_ms: 5_000, overall_ms: 8_000, max_body_bytes: MAX_PRICE_LIST_BYTES };

/// Reads the price list with one GET, or `None` for a failed read: a status other than 200, a body
/// over the cap, a timeout, text that is not a JSON list, or a list that prices nothing. A list that
/// prices nothing tells the job no more than no list at all, so it must not count as a read.
pub fn read_prices(http: &mut dyn Http, deadline: Deadline) -> Option<Prices> {
    if deadline.passed() {
        return None;
    }
    let request = Request {
        method: Method::Get,
        endpoint: ONECLICK_TOKENS,
        tail: "",
        headers: &[("accept", "application/json")],
        body: None,
        keep_headers: &[],
        limits: PRICE_LIMITS.within(deadline),
    };
    let response = http.send(&request).ok()?;
    if response.status != 200 || response.body.len() > MAX_PRICE_LIST_BYTES {
        return None;
    }
    let text = std::str::from_utf8(&response.body).ok()?;
    prices_from_tokens(text).filter(|prices| !prices.usd_by_token.is_empty())
}

// One GET against stand-in answers. Whole runs with this reader are in tests/prices.rs.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{HttpFail, Response};

    const SAVED: &str = include_str!("../tests/fixtures/oneclick-tokens-2026-11-05.json");

    /// One request as sent: method, url, body, overall time limit and body cap.
    type Sent = (Method, String, Option<Vec<u8>>, u64, usize);

    #[derive(Default)]
    struct OneAnswer {
        answer: Option<Result<Response, HttpFail>>,
        sent: Vec<Sent>,
    }

    impl Http for OneAnswer {
        fn send(&mut self, r: &Request<'_>) -> Result<Response, HttpFail> {
            let url = format!("https://{}{}{}", r.endpoint.authority, r.endpoint.path, r.tail);
            self.sent.push((r.method, url, r.body.map(<[u8]>::to_vec), r.limits.overall_ms, r.limits.max_body_bytes));
            self.answer.take().expect("one request only")
        }
    }

    fn read(answer: Result<Response, HttpFail>) -> Option<Prices> {
        read_prices(&mut OneAnswer { answer: Some(answer), sent: Vec::new() }, Deadline::after_ms(1_000))
    }

    #[test]
    fn the_saved_list_prices_near_as_wrapped_near_by_exact_id() {
        let prices = read(Ok(Response::new(200, SAVED.as_bytes().to_vec()))).unwrap();
        assert_eq!(prices.usd_by_token.get("wrap.near"), Some(&(24, 3.73)));
        assert_eq!(prices.usd_by_token.get("near"), Some(&(24, 3.73)));
        assert!(!prices.usd_by_token.contains_key("wNEAR"), "never by symbol");
    }

    #[test]
    fn it_makes_one_get_to_the_price_list_within_the_deadline_and_the_cap() {
        let mut http = OneAnswer { answer: Some(Ok(Response::new(200, SAVED.as_bytes().to_vec()))), sent: Vec::new() };
        read_prices(&mut http, Deadline::after_ms(1_000)).unwrap();
        let [(method, url, body, overall_ms, cap)] = &http.sent[..] else { panic!("{} requests", http.sent.len()) };
        assert_eq!((*method, url.as_str(), body), (Method::Get, PRICE_LIST_URL, &None));
        assert!(*overall_ms <= 1_000, "{overall_ms}");
        assert_eq!(*cap, 1024 * 1024);
    }

    #[test]
    fn every_failed_read_is_none() {
        let body = |text: &[u8]| Ok(Response::new(200, text.to_vec()));
        for (name, answer) in [
            ("status 500", Ok(Response::new(500, SAVED.as_bytes().to_vec()))),
            ("status 204", Ok(Response::new(204, Vec::new()))),
            ("timed out", Err(HttpFail::Timeout)),
            ("over the cap at the transport", Err(HttpFail::TooLarge)),
            ("over the cap in hand", body(&vec![b' '; MAX_PRICE_LIST_BYTES + 1])),
            ("not text", body(b"\xff\xfe")),
            ("not JSON", body(b"<html>busy</html>")),
            ("an object", body(br#"{"tokens":[]}"#)),
            ("empty", body(b"")),
            ("an empty list", body(b"[]")),
            ("a list of nothing usable", body(br#"[1,"two",{"assetId":"nep141:wrap.near","decimals":24,"price":0}]"#)),
        ] {
            assert_eq!(read(answer), None, "{name}");
        }
    }

    #[test]
    fn a_deadline_already_passed_sends_nothing() {
        let mut http = OneAnswer::default();
        assert_eq!(read_prices(&mut http, Deadline::after_ms(0)), None);
        assert!(http.sent.is_empty());
    }
}
