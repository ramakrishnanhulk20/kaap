#[cfg(target_arch = "wasm32")]
use std::io::{Read, Write};

// Covered by the wasm's sha256, so the hosts the job reaches and the keys it holds cannot
// change without publishing a new version.
#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(all(target_arch = "wasm32", not(feature = "local")))]
fn connect(network: kaap_core::Network, deadline: kaap_sealed::net::Deadline) -> kaap_sealed::job::Connections {
    use kaap_sealed::host::{HostProvider, HostSigner};
    use kaap_sealed::net::{DRPC_MAINNET, DRPC_TESTNET};
    use kaap_sealed::rpc::RpcProvider;
    use kaap_sealed::wasi_http::WasiHttp;

    // parse_input only ever accepts testnet or mainnet.
    let https = match network {
        kaap_core::Network::Mainnet => DRPC_MAINNET,
        kaap_core::Network::Testnet | kaap_core::Network::Sandbox => DRPC_TESTNET,
    };
    kaap_sealed::job::Connections {
        host: Box::new(HostProvider),
        https: Box::new(RpcProvider::new(WasiHttp, https, deadline)),
        ai: Box::new(WasiHttp),
        signer: Box::new(HostSigner),
    }
}

#[cfg(all(target_arch = "wasm32", feature = "local"))]
use kaap_sealed::local::connections as connect;

#[cfg(target_arch = "wasm32")]
fn main() {
    let mut raw = Vec::new();
    // One byte over the cap is enough to refuse an oversized input.
    let cap = kaap_sealed::input::MAX_INPUT_BYTES as u64 + 1;
    let _ = std::io::stdin().take(cap).read_to_end(&mut raw);
    let network = std::env::var("NEAR_NETWORK_ID").ok();
    let key = std::env::var("NEAR_AI_API_KEY").ok();
    let text = kaap_sealed::job::run(&raw, network.as_deref(), key.as_deref(), connect);
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("kaap-sealed runs only as a wasm32-wasip2 component: bash packages/sealed/build.sh");
    std::process::exit(2);
}
