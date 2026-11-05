//! HTTPS from inside the component, through the WASI HTTP interface OutLayer's worker provides.
//!
//! Every request sets a connect, a first-byte and a between-bytes timeout, which the worker
//! applies to the connection, and waits on one monotonic-clock timer for the whole exchange, so a
//! server that answers slowly but steadily is still cut off at `overall_ms`. Bodies are read up to
//! `max_body_bytes` and no further. Written straight on the `wasi` bindings because
//! wasi-http-client 0.2.1 sets only a connect timeout, blocks without a deadline, and hands a whole
//! request body to `blocking-write-and-flush`, which WASI caps at 4,096 bytes.

use wasi::clocks::monotonic_clock;
use wasi::http::outgoing_handler;
use wasi::http::types::{Fields, Method as WasiMethod, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
use wasi::io::poll::{poll, Pollable};
use wasi::io::streams::{InputStream, StreamError};

use crate::net::{is_safe_tail, Http, HttpFail, Method, Request, Response, MAX_HEADER_BYTES};

const NS_PER_MS: u64 = 1_000_000;
const READ_CHUNK: u64 = 64 * 1024;

pub struct WasiHttp;

impl Http for WasiHttp {
    fn send(&mut self, r: &Request<'_>) -> Result<Response, HttpFail> {
        let limits = r.limits;
        if limits.overall_ms == 0 {
            return Err(HttpFail::Timeout);
        }
        if !is_safe_tail(r.tail) {
            return Err(HttpFail::Setup);
        }
        let ns = |ms: u64| ms.saturating_mul(NS_PER_MS);
        let timer = monotonic_clock::subscribe_duration(ns(limits.overall_ms));

        let entries: Vec<(String, Vec<u8>)> =
            r.headers.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect();
        let headers = Fields::from_list(&entries).map_err(|_| HttpFail::Setup)?;
        let request = OutgoingRequest::new(headers);
        let method = match r.method {
            Method::Get => WasiMethod::Get,
            Method::Post => WasiMethod::Post,
        };
        request.set_method(&method).map_err(|_| HttpFail::Setup)?;
        request.set_scheme(Some(&Scheme::Https)).map_err(|_| HttpFail::Setup)?;
        request.set_authority(Some(r.endpoint.authority)).map_err(|_| HttpFail::Setup)?;
        let path = format!("{}{}", r.endpoint.path, r.tail);
        request.set_path_with_query(Some(&path)).map_err(|_| HttpFail::Setup)?;
        let body = request.body().map_err(|_| HttpFail::Setup)?;

        let options = RequestOptions::new();
        options.set_connect_timeout(Some(ns(limits.connect_ms))).map_err(|_| HttpFail::Setup)?;
        options.set_first_byte_timeout(Some(ns(limits.first_byte_ms))).map_err(|_| HttpFail::Setup)?;
        options.set_between_bytes_timeout(Some(ns(limits.between_bytes_ms))).map_err(|_| HttpFail::Setup)?;

        let future = outgoing_handler::handle(request, Some(options)).map_err(|_| HttpFail::Send)?;
        write_body(&body, r.body.unwrap_or(&[]), &timer)?;
        OutgoingBody::finish(body, None).map_err(|_| HttpFail::Send)?;

        let answered = {
            let ready = future.subscribe();
            loop {
                if let Some(result) = future.get() {
                    break result;
                }
                wait(&ready, &timer)?;
            }
        };
        let response = answered.map_err(|_| HttpFail::Send)?.map_err(|_| HttpFail::Send)?;
        let status = response.status();
        let headers = kept_headers(&response.headers(), r.keep_headers)?;
        let incoming = response.consume().map_err(|_| HttpFail::Read)?;
        let bytes = {
            let stream = incoming.stream().map_err(|_| HttpFail::Read)?;
            read_all(&stream, limits.max_body_bytes, &timer)?
        };
        Ok(Response { status, body: bytes, headers })
    }

    fn pause(&mut self, ms: u64) {
        monotonic_clock::subscribe_duration(ms.saturating_mul(NS_PER_MS)).block();
    }
}

/// The first value of each header the request asked for, as text. A value over
/// `MAX_HEADER_BYTES` or not UTF-8 fails the request rather than being cut or guessed at.
fn kept_headers(fields: &Fields, names: &[&str]) -> Result<Vec<(String, String)>, HttpFail> {
    let mut out = Vec::new();
    for name in names {
        if let Some(value) = fields.get(&name.to_string()).into_iter().next() {
            if value.len() > MAX_HEADER_BYTES {
                return Err(HttpFail::TooLarge);
            }
            let text = String::from_utf8(value).map_err(|_| HttpFail::Read)?;
            out.push((name.to_string(), text));
        }
    }
    Ok(out)
}

/// Waits until `ready` fires; a timeout when the job's timer fires first.
fn wait(ready: &Pollable, timer: &Pollable) -> Result<(), HttpFail> {
    if poll(&[ready, timer]).contains(&0) {
        Ok(())
    } else {
        Err(HttpFail::Timeout)
    }
}

fn write_body(body: &OutgoingBody, mut bytes: &[u8], timer: &Pollable) -> Result<(), HttpFail> {
    if bytes.is_empty() {
        return Ok(());
    }
    let stream = body.write().map_err(|_| HttpFail::Send)?;
    let ready = stream.subscribe();
    while !bytes.is_empty() {
        let permit = stream.check_write().map_err(|_| HttpFail::Send)?;
        if permit == 0 {
            wait(&ready, timer)?;
            continue;
        }
        let n = usize::try_from(permit).unwrap_or(usize::MAX).min(bytes.len());
        stream.write(&bytes[..n]).map_err(|_| HttpFail::Send)?;
        bytes = &bytes[n..];
    }
    stream.flush().map_err(|_| HttpFail::Send)?;
    // After a flush, check-write answers 0 until the flush has completed.
    loop {
        match stream.check_write() {
            Ok(0) => wait(&ready, timer)?,
            Ok(_) => return Ok(()),
            Err(_) => return Err(HttpFail::Send),
        }
    }
}

fn read_all(stream: &InputStream, max: usize, timer: &Pollable) -> Result<Vec<u8>, HttpFail> {
    let ready = stream.subscribe();
    let mut out = Vec::new();
    loop {
        match stream.read(READ_CHUNK) {
            Ok(chunk) if chunk.is_empty() => wait(&ready, timer)?,
            Ok(chunk) => {
                if out.len() + chunk.len() > max {
                    return Err(HttpFail::TooLarge);
                }
                out.extend_from_slice(&chunk);
            }
            Err(StreamError::Closed) => return Ok(out),
            Err(_) => return Err(HttpFail::Read),
        }
    }
}
