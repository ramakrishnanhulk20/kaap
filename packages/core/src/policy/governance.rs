//! The governance kinds: ChangeConfig, UpgradeSelf, UpgradeRemote, SetStakingContract, the two
//! bounty kinds, Vote and FactoryInfoUpdate (guide section 3, rulings 5 and 21).

use base64::Engine as _;
use serde_json::{Map, Value};

use super::sputnik::object;
use crate::types::{ChangeFlag, Effect, FindingCode};

/// Sputnik's `Config` (types.rs), as both `get_config` and a ChangeConfig kind write it.
const CONFIG_FIELDS: [&str; 3] = ["name", "purpose", "metadata"];

/// The effect and findings of the governance kind `variant` with this `body` (`Value::Null` for
/// the bare `"Vote"`), or nothing for a name that is not one of them. A body Sputnik could not
/// have stored (proposals.rs 67-121: every field required, none unknown) gives no effect and
/// UNKNOWN_CALL. `config_before` is the DAO's config before a ChangeConfig, `None` when not known.
pub(crate) fn decode(variant: &str, body: &Value, config_before: Option<&Value>) -> (Vec<Effect>, Vec<FindingCode>) {
    let text = |map: &Map<String, Value>, name: &str| map[name].as_str().map(str::to_string);
    let effect = match variant {
        "ChangeConfig" => object(body, &["config"], &[])
            .and_then(|map| object(&map["config"], &CONFIG_FIELDS, &[]))
            .and_then(|config| {
                // The config before goes through the same strict reader as the new one (standard 2).
                let before = config_before.and_then(|c| object(c, &CONFIG_FIELDS, &[]));
                Some(Effect::ConfigChange {
                    name: text(config, "name")?,
                    purpose_changed: flag(before, config, purpose),
                    metadata_changed: flag(before, config, metadata),
                })
            }),
        "UpgradeSelf" => object(body, &["hash"], &[])
            .and_then(|map| Some(Effect::CodeUpgrade { target: "self".into(), code_hash: text(map, "hash")? })),
        "UpgradeRemote" => object(body, &["receiver_id", "method_name", "hash"], &[]).and_then(|map| {
            Some(Effect::CodeUpgrade { target: text(map, "receiver_id")?, code_hash: text(map, "hash")? })
        }),
        "SetStakingContract" => object(body, &["staking_id"], &[]).and_then(|map| {
            let staking = text(map, "staking_id")?;
            Some(other(variant, format!("Sets the staking contract that counts token votes to {staking}")))
        }),
        "AddBounty" => object(body, &["bounty"], &[]).map(|_| other(variant, "Adds a bounty".into())),
        "BountyDone" => object(body, &["bounty_id", "receiver_id"], &[]).and_then(|map| {
            let receiver = text(map, "receiver_id")?;
            let id = map["bounty_id"].as_u64()?;
            Some(other(variant, format!("Marks bounty {id} done by {receiver}")))
        }),
        "Vote" => body.is_null().then(|| other(variant, "Signal-only proposal, nothing is executed".into())),
        "FactoryInfoUpdate" => object(body, &["factory_info"], &[])
            .map(|_| other(variant, "Changes the factory the DAO upgrades from".into())),
        _ => return (Vec::new(), Vec::new()),
    };
    match effect {
        Some(effect) => (vec![effect], findings(variant)),
        None => (Vec::new(), vec![FindingCode::UnknownCall]),
    }
}

/// The guide section 4 codes a governance kind fires on its own: CODE_UPGRADE for the two upgrade
/// kinds, which replace code Kaap cannot read (ruling 5), and OTHER_RISKY_KIND for a new staking
/// contract, which decides every later token vote, and a factory change, which decides every later
/// self-upgrade (C2). Bounties and Vote fire nothing, as the table says.
fn findings(variant: &str) -> Vec<FindingCode> {
    match variant {
        "UpgradeSelf" | "UpgradeRemote" => vec![FindingCode::CodeUpgrade],
        "SetStakingContract" | "FactoryInfoUpdate" => vec![FindingCode::OtherRiskyKind],
        _ => Vec::new(),
    }
}

/// Whether one config field differs: `Unknown` unless `field` reads on both configs, so a missing
/// or unreadable config before never reads as "unchanged" (ruling 21). `purpose` reads only as a
/// string and `metadata` only as a base64 string, on either side; any other type is `Unknown` for
/// that flag alone.
fn flag(
    before: Option<&Map<String, Value>>,
    after: &Map<String, Value>,
    field: fn(&Map<String, Value>) -> Option<Vec<u8>>,
) -> ChangeFlag {
    match (before.and_then(field), field(after)) {
        (Some(was), Some(now)) if was == now => ChangeFlag::Unchanged,
        (Some(_), Some(_)) => ChangeFlag::Changed,
        _ => ChangeFlag::Unknown,
    }
}

fn purpose(config: &Map<String, Value>) -> Option<Vec<u8>> {
    config.get("purpose")?.as_str().map(|s| s.as_bytes().to_vec())
}

/// `metadata` is near-sdk's `Base64VecU8`, so the bytes it stands for are compared, and text that
/// is not standard padded base64 does not read.
fn metadata(config: &Map<String, Value>) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(config.get("metadata")?.as_str()?).ok()
}

fn other(kind: &str, summary: String) -> Effect {
    Effect::OtherKind { kind: kind.into(), summary }
}
