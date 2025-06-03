use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

// This matches exactly what is in tauri.conf.json:plugins.zknet.
// There are no fallbacks in code, so a missing key is a hard error.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZKNetClientCfg {
    pub api_listen_address: String,
    pub default_walletshield_listen_address: String,
    pub url_network: String,
}

// facilitate access to the ZKNetClientCfg state from the frontend
#[tauri::command]
pub fn cfg(state: tauri::State<'_, ZKNetClientCfg>) -> ZKNetClientCfg {
    state.inner().clone()
}

/// Generic helper to deserialize any tairi.conf.json plugin section on demand.
pub fn plugin_cfg<R, T>(app: &AppHandle<R>, section: &str) -> T
where
    R: Runtime,
    T: for<'de> Deserialize<'de>,
{
    let raw = app
        .config()
        .plugins
        .0
        .get(section)
        .unwrap_or_else(|| panic!("missing plugins.{section} in tauri.conf.json"))
        .clone();

    serde_json::from_value(raw).unwrap_or_else(|e| panic!("invalid plugins.{section}: {e}"))
}
