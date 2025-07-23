use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths::AppPaths;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub api_listen_address: String,
    pub url_network: String,
    pub walletshield_listen_address: String,
}

pub fn load_config(paths: &AppPaths, config_json: &str) -> AppConfig {
    let base: Value = serde_json::from_str(config_json).expect("Invalid built-in config.json");

    let overrides: Value = fs::read_to_string(paths.path_settings())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    let merged = merge(base, overrides);
    serde_json::from_value(merged).expect("Merged config is invalid")
}

/// Deep merge override into base, recursively.
fn merge(base: Value, override_: Value) -> Value {
    match (base, override_) {
        (Value::Object(mut base_map), Value::Object(override_map)) => {
            for (k, v) in override_map {
                let base_val = base_map.remove(&k).unwrap_or(Value::Null);
                base_map.insert(k, merge(base_val, v));
            }
            Value::Object(base_map)
        }
        (_, override_leaf) => override_leaf,
    }
}
