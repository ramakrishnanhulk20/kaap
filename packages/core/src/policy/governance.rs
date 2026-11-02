//! The governance kinds: ChangeConfig, UpgradeSelf, UpgradeRemote, SetStakingContract, the two
//! bounty kinds, Vote and FactoryInfoUpdate (guide section 3, rulings 5 and 21).

use serde_json::Value;

use super::sputnik::object;
use crate::types::{ChangeFlag, Effect, FindingCode};

/// The effect and findings of the governance kind `variant` with this `body` (`Value::Null` for
/// the bare `"Vote"`), or nothing for a name that is not one of them. A body Sputnik could not
/// have stored (proposals.rs 67-121: every field required, none unknown) gives no effect and
/// UNKNOWN_CALL.
pub(crate) fn decode(variant: &str, body: &Value) -> (Vec<Effect>, Vec<FindingCode>) {
    let text = |map: &serde_json::Map<String, Value>, name: &str| map[name].as_str().map(str::to_string);
    let effect = match variant {
        // The config before is not part of the input, so neither flag can be known (ruling 21).
        "ChangeConfig" => object(body, &["config"], &[])
            .and_then(|map| object(&map["config"], &["name", "purpose", "metadata"], &[]))
            .and_then(|config| {
                Some(Effect::ConfigChange {
                    name: text(config, "name")?,
                    purpose_changed: ChangeFlag::Unknown,
                    metadata_changed: ChangeFlag::Unknown,
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

fn other(kind: &str, summary: String) -> Effect {
    Effect::OtherKind { kind: kind.into(), summary }
}
