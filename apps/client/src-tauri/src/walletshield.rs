//! The desktop's adapter onto zknet_client_core::walletshield. The webview
//! spawns WalletShield through the shell plugin, which resolves a spawn by the
//! first capability scope whose name matches and builds argv from that scope's
//! argument template: arguments beyond the template are dropped silently. The
//! arguments built here must match the `walletshield-listen` scope; the tests
//! resolve them through the plugin itself.

use serde::Serialize;
use tauri::State;
use zknet_client_core::walletshield;

use crate::config::ZKNetClientCfg;

/// The shell capability scope WalletShield is spawned under.
const SCOPE: &str = "walletshield-listen";

#[derive(Debug, Serialize)]
pub struct Spawn {
    scope: &'static str,
    args: Vec<String>,
}

fn spawn(listen_address: &str, log_level: &str) -> Spawn {
    Spawn {
        scope: SCOPE,
        args: walletshield::args(listen_address, log_level),
    }
}

/// WalletShield's scope and arguments, at the configured log level.
#[tauri::command]
pub fn walletshield_spawn(cfg: State<'_, ZKNetClientCfg>, listen_address: String) -> Spawn {
    spawn(&listen_address, &cfg.walletshield_log_level)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const CAPABILITIES: [&str; 2] = [
        include_str!("../capabilities/default.json"),
        include_str!("../capabilities/desktop.json"),
    ];

    /// The argument templates of the `shell:allow-spawn` scopes named `name`.
    fn templates(name: &str) -> Vec<Vec<Value>> {
        CAPABILITIES
            .iter()
            .map(|c| serde_json::from_str::<Value>(c).unwrap())
            .flat_map(|c| c["permissions"].as_array().unwrap().clone())
            .filter(|p| p["identifier"] == "shell:allow-spawn")
            .flat_map(|p| p["allow"].as_array().unwrap().clone())
            .filter(|s| s["name"] == name)
            .map(|s| s["args"].as_array().unwrap().clone())
            .collect()
    }

    /// The scope's template takes these arguments as they are: every fixed
    /// argument in its place, a validated variable for each value the config
    /// supplies, and no argument beyond the template (it would be dropped).
    /// The validators themselves are checked against the config's values in
    /// walletshield.spec.ts.
    #[test]
    fn the_arguments_fit_the_spawn_scope() {
        let [template] = &templates(SCOPE)[..] else {
            panic!("exactly one {SCOPE} scope");
        };
        let s = spawn("LISTEN", "LEVEL");
        assert_eq!(template.len(), s.args.len());
        let mut vars = vec![];
        for (slot, arg) in template.iter().zip(&s.args) {
            match slot {
                Value::String(fixed) => assert_eq!(fixed, arg),
                Value::Object(var) if var["validator"].is_string() => vars.push(arg.as_str()),
                other => panic!("unexpected template slot {other}"),
            }
        }
        // the listen address, then the log level: the order the spec validates
        assert_eq!(vars, ["LISTEN", "LEVEL"]);
    }
}
