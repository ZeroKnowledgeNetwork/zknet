//! The desktop's adapter onto zknet_core::network: it supplies the layout from
//! the app's config and data dir, streams progress over a Channel, and turns
//! errors into a shape the webview can branch on.

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use zknet_core::network::{
    self, FetchError, FetchEvent, FetchOptions, Layout, Listing, NetworkId, OnFetchEvent, Platform,
    Prepared,
};

use crate::config::ZKNetClientCfg;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    /// `FetchError::kind()`, or `app` for a failure outside the network contract.
    kind: &'static str,
    message: String,
}

impl From<FetchError> for CmdError {
    fn from(e: FetchError) -> Self {
        Self {
            kind: e.kind(),
            message: e.to_string(),
        }
    }
}

impl From<tauri::Error> for CmdError {
    fn from(e: tauri::Error) -> Self {
        Self {
            kind: "app",
            message: e.to_string(),
        }
    }
}

fn layout<R: Runtime>(app: &AppHandle<R>, cfg: &ZKNetClientCfg) -> Result<Layout, CmdError> {
    let networks_dir = app.path().app_local_data_dir()?.join("networks");
    Ok(Layout::new(
        &cfg.url_network,
        networks_dir,
        Platform::current()?,
    ))
}

/// The live networks of the index merged with those cached on this device.
#[tauri::command]
pub async fn networks_list<R: Runtime>(
    app: AppHandle<R>,
    cfg: State<'_, ZKNetClientCfg>,
) -> Result<Listing, CmdError> {
    let layout = layout(&app, &cfg)?;
    Ok(network::list(&network::http_client()?, &layout).await)
}

/// Make a network ready to run (`zknet_core::network::prepare`), streaming
/// progress over `on_event`. Its `dir` is where WalletShield is spawned.
#[tauri::command]
pub async fn network_fetch<R: Runtime>(
    app: AppHandle<R>,
    cfg: State<'_, ZKNetClientCfg>,
    network_id: String,
    refresh: bool,
    on_event: Channel<FetchEvent>,
) -> Result<Prepared, CmdError> {
    let layout = layout(&app, &cfg)?;
    let id = NetworkId::parse(&network_id)?;
    let on_event: OnFetchEvent = std::sync::Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let options = FetchOptions {
        refresh,
        allow_unsigned: cfg.allow_unsigned,
    };
    Ok(network::prepare(
        &network::http_client()?,
        &layout,
        &id,
        options,
        Some(on_event),
    )
    .await?)
}

/// This build's platform by its published name, e.g. `linux-x64`.
#[tauri::command]
pub fn platform() -> Result<String, CmdError> {
    Ok(Platform::current()?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_reach_the_webview_with_their_kind() {
        let e = CmdError::from(NetworkId::parse("../x").unwrap_err());
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            serde_json::json!({"kind": "invalidNetworkId", "message": "invalid network id \"../x\""})
        );
        let e = CmdError::from(FetchError::NotFound {
            id: "devnet-1".into(),
            url: "https://h/devnet-1/client.toml".into(),
        });
        assert_eq!(e.kind, "notFound");
    }

    /// Only the dev-local overlay may ask for unsigned assets.
    #[test]
    fn only_the_dev_local_overlay_allows_unsigned_assets() {
        let conf = |text: &str| -> serde_json::Value { serde_json::from_str(text).unwrap() };
        let zknet = |v: serde_json::Value| v["plugins"]["zknet"]["allowUnsigned"].clone();
        assert_eq!(zknet(conf(include_str!("../tauri.conf.json"))), false);
        assert_eq!(
            zknet(conf(include_str!("../tauri.dev-local.conf.json"))),
            true
        );
        assert_eq!(
            zknet(conf(include_str!("../tauri.dev.conf.json"))),
            serde_json::Value::Null
        );
    }

    /// "Is this the built-in source?" is answered by zknet_core alone.
    #[test]
    fn the_configured_source_is_the_built_in_one() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["plugins"]["zknet"]["urlNetwork"],
            network::DEFAULT_SOURCE
        );
    }
}
