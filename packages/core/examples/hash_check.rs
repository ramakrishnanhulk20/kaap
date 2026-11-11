//! Reads one `ProposalInput` as JSON on stdin and prints kaap-core's `Analysis` of it as one line
//! of JSON on stdout. `scripts/hash-check-testnet.mjs` runs it natively on a sign proposal read
//! from testnet, once without its text and once with it:
//!
//!   cargo run -q -p kaap-core --example hash_check < input.json
//!
//! It reads nothing else and writes nothing else; an input that is not a `ProposalInput` exits
//! with code 2 and a reason on stderr.

use std::io::Read;
use std::process::exit;

fn main() {
    let mut text = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut text) {
        eprintln!("could not read stdin: {e}");
        exit(2);
    }
    let input: kaap_core::ProposalInput = match serde_json::from_str(&text) {
        Ok(input) => input,
        Err(e) => {
            eprintln!("stdin is not a ProposalInput: {e}");
            exit(2);
        }
    };
    match serde_json::to_string(&kaap_core::analyze(&input)) {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("the analysis did not serialise: {e}");
            exit(2);
        }
    }
}
