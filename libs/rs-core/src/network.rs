//! The network asset contract: where published network assets live, and how a
//! client discovers networks and obtains their assets.
//!
//! A network is published as `<base>/<network_id>/{client.toml, services.json,
//! walletshield-<platform>}`, next to `<base>/networks.json`, the index of live
//! networks. A client keeps its copy in `<networks_dir>/<network_id>/` with the
//! binary named `walletshield` (`walletshield.exe` on Windows). Both clients call
//! this module; neither builds an asset URL or path itself.

use std::{
    collections::BTreeSet,
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};

use crate::net::{download, ProgressCallback, ProgressPayload};

/// Ids the CLI's subcommands own, so no network can be published under them.
/// `apps/network-assets/assemble.sh` refuses the same list.
pub const RESERVED_IDS: [&str; 3] = ["list", "connect", "help"];

/// The index's schema version this client reads.
pub const INDEX_SCHEMA: u32 = 1;

const INDEX_FILE: &str = "networks.json";
const PART_SUFFIX: &str = ".part";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// A network id: one plain path component of 1–64 characters from
/// `[a-z0-9._-]`, starting with `[a-z0-9]`, and not a reserved word.
/// `assemble.sh` publishes ids by the same rule.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct NetworkId(String);

impl NetworkId {
    pub fn parse(s: &str) -> Result<Self, FetchError> {
        let valid = (1..=64).contains(&s.len())
            && s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
            && !RESERVED_IDS.contains(&s);
        if valid {
            Ok(Self(s.to_owned()))
        } else {
            Err(FetchError::InvalidNetworkId(s.to_owned()))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for NetworkId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.pad(&self.0)
    }
}

/// A client platform by its published name, e.g. `linux-x64` or `macos-arm64`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Platform(String);

impl Platform {
    /// The platform this binary was built for.
    pub fn current() -> Result<Self, FetchError> {
        Self::from_os_arch(env::consts::OS, env::consts::ARCH)
    }

    /// Map a Rust `(target_os, target_arch)` to its published name. The
    /// WalletShield export (`packages/opt/served.sh`) publishes these names.
    pub fn from_os_arch(os: &str, arch: &str) -> Result<Self, FetchError> {
        let name = match (os, arch) {
            ("linux", "aarch64") => "linux-arm64",
            ("linux", "x86_64") => "linux-x64",
            ("macos", "aarch64") => "macos-arm64",
            ("macos", "x86_64") => "macos-x64",
            ("windows", "x86_64") => "windows-x64",
            _ => return Err(FetchError::UnsupportedPlatform(format!("{os} ({arch})"))),
        };
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_windows(&self) -> bool {
        self.0.starts_with("windows")
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.pad(&self.0)
    }
}

/// One published asset of a network.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Asset {
    ClientToml,
    ServicesJson,
    Walletshield,
}

impl Asset {
    pub const ALL: [Asset; 3] = [Asset::ClientToml, Asset::ServicesJson, Asset::Walletshield];

    /// The file name under `<base>/<network_id>/`.
    pub fn remote_name(self, platform: &Platform) -> String {
        match self {
            Asset::Walletshield => format!("walletshield-{platform}"),
            _ => self.local_name(platform),
        }
    }

    /// The file name under `<networks_dir>/<network_id>/`.
    pub fn local_name(self, platform: &Platform) -> String {
        match self {
            Asset::ClientToml => "client.toml".into(),
            Asset::ServicesJson => "services.json".into(),
            Asset::Walletshield if platform.is_windows() => "walletshield.exe".into(),
            Asset::Walletshield => "walletshield".into(),
        }
    }

    pub fn is_executable(self) -> bool {
        self == Asset::Walletshield
    }
}

/// The one place that knows the published URL shape and the local directory shape.
#[derive(Clone, Debug)]
pub struct Layout {
    /// The published root, e.g. `https://test.net.zknet.io`.
    pub base_url: String,
    /// The client's network cache: `<app data>/networks`.
    pub networks_dir: PathBuf,
    pub platform: Platform,
}

impl Layout {
    pub fn new(base_url: &str, networks_dir: PathBuf, platform: Platform) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            networks_dir,
            platform,
        }
    }

    pub fn index_url(&self) -> String {
        format!("{}/{INDEX_FILE}", self.base_url)
    }

    pub fn asset_url(&self, id: &NetworkId, asset: Asset) -> String {
        format!(
            "{}/{id}/{}",
            self.base_url,
            asset.remote_name(&self.platform)
        )
    }

    pub fn network_dir(&self, id: &NetworkId) -> PathBuf {
        self.networks_dir.join(id.as_str())
    }

    pub fn asset_path(&self, id: &NetworkId, asset: Asset) -> PathBuf {
        self.network_dir(id).join(asset.local_name(&self.platform))
    }

    /// Whether a complete asset set is on disk. Assets are promoted only once
    /// fully downloaded, so a present file is a whole one.
    pub fn is_cached(&self, id: &NetworkId) -> bool {
        Asset::ALL.iter().all(|&a| self.asset_path(id, a).is_file())
    }
}

/// `<base>/networks.json`: the networks that are live now. A network leaves the
/// index when it stops; nothing marks it retired. Unknown fields are ignored.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Index {
    pub schema: u32,
    pub networks: Vec<IndexEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    pub kind: NetworkKind,
    pub name: String,
    /// RFC 3339, UTC.
    pub created: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkKind {
    Local,
    Devnet,
    Testnet,
    Mainnet,
    #[serde(other)]
    Other,
}

/// One network as a client shows it: listed in the index, cached on disk, or both.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEntry {
    pub id: NetworkId,
    pub listed: Option<IndexEntry>,
    pub cached: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Listed networks in index order, then cached-only networks by id.
    pub networks: Vec<NetworkEntry>,
    /// Why the index could not be read; the cached networks are listed regardless.
    pub index_error: Option<String>,
}

/// Progress of a fetch, in order per asset. `Progress` is throttled per asset,
/// and its last value is always delivered.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum FetchEvent {
    /// The download began; `total` is `0` when the server sends no length.
    Started {
        asset: Asset,
        total: u64,
    },
    Progress {
        asset: Asset,
        progress: ProgressPayload,
    },
    /// Not downloaded: the cached copy is used.
    Cached {
        asset: Asset,
    },
    Finished {
        asset: Asset,
    },
}

pub type OnFetchEvent = Arc<dyn Fn(FetchEvent) + Send + Sync>;

#[derive(Clone, Copy, Debug, Default)]
pub struct FetchOptions {
    /// Download even when a complete copy is cached.
    pub refresh: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("invalid network id {0:?}")]
    InvalidNetworkId(String),
    #[error("unsupported platform: {0}")]
    UnsupportedPlatform(String),
    #[error("network {id} is not published at {url}")]
    NotFound { id: String, url: String },
    #[error("request to {url} failed: {source}")]
    Http {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("{}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid network index at {url}: {reason}")]
    Index { url: String, reason: String },
    #[error("{asset:?} failed verification: {reason}")]
    Verification { asset: Asset, reason: String },
}

impl FetchError {
    /// A stable tag for callers that branch on the error, e.g. the desktop UI.
    pub fn kind(&self) -> &'static str {
        match self {
            FetchError::InvalidNetworkId(_) => "invalidNetworkId",
            FetchError::UnsupportedPlatform(_) => "unsupportedPlatform",
            FetchError::NotFound { .. } => "notFound",
            FetchError::Http { .. } => "http",
            FetchError::Io { .. } => "io",
            FetchError::Index { .. } => "index",
            FetchError::Verification { .. } => "verification",
        }
    }

    fn io(path: &Path, source: std::io::Error) -> Self {
        FetchError::Io {
            path: path.to_owned(),
            source,
        }
    }
}

/// The HTTP client for every network call: a stalled connection fails, a slow
/// one does not. There is deliberately no total deadline, which would fail any
/// binary that takes longer than it to download.
pub fn http_client() -> Result<Client, FetchError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|source| FetchError::Http {
            url: String::new(),
            source,
        })
}

/// Read the index. Entries whose id is not a valid [`NetworkId`] are dropped.
pub async fn fetch_index(http: &Client, layout: &Layout) -> Result<Index, FetchError> {
    let url = layout.index_url();
    let http_err = |source| FetchError::Http {
        url: url.clone(),
        source,
    };
    let response = http.get(&url).send().await.map_err(http_err)?;
    if !response.status().is_success() {
        return Err(FetchError::Index {
            url,
            reason: format!("HTTP {}", response.status()),
        });
    }
    let body = response.text().await.map_err(http_err)?;
    let mut index: Index = serde_json::from_str(&body).map_err(|e| FetchError::Index {
        url: url.clone(),
        reason: e.to_string(),
    })?;
    if index.schema != INDEX_SCHEMA {
        return Err(FetchError::Index {
            url,
            reason: format!("unsupported schema {}", index.schema),
        });
    }
    let mut seen = BTreeSet::new();
    index
        .networks
        .retain(|n| NetworkId::parse(&n.id).is_ok() && seen.insert(n.id.clone()));
    Ok(index)
}

/// The networks with a complete asset set on disk, by id.
pub fn cached(layout: &Layout) -> Vec<NetworkId> {
    let Ok(entries) = std::fs::read_dir(&layout.networks_dir) else {
        return Vec::new();
    };
    let mut ids: Vec<NetworkId> = entries
        .filter_map(|e| NetworkId::parse(e.ok()?.file_name().to_str()?).ok())
        .filter(|id| layout.is_cached(id))
        .collect();
    ids.sort();
    ids
}

/// The live networks merged with the cached ones.
pub async fn list(http: &Client, layout: &Layout) -> Listing {
    let mut cached_ids: BTreeSet<NetworkId> = cached(layout).into_iter().collect();
    let (listed, index_error) = match fetch_index(http, layout).await {
        Ok(index) => (index.networks, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    let mut networks: Vec<NetworkEntry> = listed
        .into_iter()
        .filter_map(|entry| {
            let id = NetworkId::parse(&entry.id).ok()?;
            Some(NetworkEntry {
                cached: cached_ids.remove(&id),
                id,
                listed: Some(entry),
            })
        })
        .collect();
    networks.extend(cached_ids.into_iter().map(|id| NetworkEntry {
        id,
        listed: None,
        cached: true,
    }));
    Listing {
        networks,
        index_error,
    }
}

/// Ensure a network's complete asset set is on disk, and return its directory.
///
/// A cached set is used as is unless `opts.refresh`. Otherwise every asset is
/// downloaded concurrently to `<name>.part`; only when all have arrived is each
/// one verified, made executable if it is the binary, and renamed into place.
/// On any failure the `.part` files are removed and the cached set is untouched.
pub async fn fetch(
    http: &Client,
    layout: &Layout,
    id: &NetworkId,
    opts: FetchOptions,
    on_event: Option<OnFetchEvent>,
) -> Result<PathBuf, FetchError> {
    let emit = |event| {
        if let Some(cb) = &on_event {
            cb(event)
        }
    };
    let dir = layout.network_dir(id);

    if !opts.refresh && layout.is_cached(id) {
        for asset in Asset::ALL {
            emit(FetchEvent::Cached { asset });
        }
        return Ok(dir);
    }

    let created = !dir.exists();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| FetchError::io(&dir, e))?;

    let staged = async {
        let [a, b, c] = Asset::ALL;
        tokio::try_join!(
            stage(http, layout, id, a, on_event.clone()),
            stage(http, layout, id, b, on_event.clone()),
            stage(http, layout, id, c, on_event.clone()),
        )?;
        for asset in Asset::ALL {
            promote(layout, id, asset).await?;
        }
        Ok(())
    }
    .await;

    if let Err(e) = staged {
        for asset in Asset::ALL {
            let _ = tokio::fs::remove_file(part_path(layout, id, asset)).await;
        }
        if created {
            let _ = tokio::fs::remove_dir(&dir).await; // only if still empty
        }
        return Err(e);
    }
    for asset in Asset::ALL {
        emit(FetchEvent::Finished { asset });
    }
    Ok(dir)
}

fn part_path(layout: &Layout, id: &NetworkId, asset: Asset) -> PathBuf {
    let mut path = layout.asset_path(id, asset).into_os_string();
    path.push(PART_SUFFIX);
    path.into()
}

/// Download one asset to its `.part` file.
async fn stage(
    http: &Client,
    layout: &Layout,
    id: &NetworkId,
    asset: Asset,
    on_event: Option<OnFetchEvent>,
) -> Result<(), FetchError> {
    let url = layout.asset_url(id, asset);
    let part = part_path(layout, id, asset);
    let file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| FetchError::io(&part, e))?;

    let progress = on_event.clone().map(|cb| Throttle::new(asset, cb));
    let callback = progress
        .clone()
        .map(|t| Box::new(move |p: ProgressPayload| t.progress(p)) as ProgressCallback);

    download(http, &url, file, callback, None, None)
        .await
        .map_err(|e| download_error(e, id, &url, &part))?;
    if let Some(t) = progress {
        t.finish();
    }
    Ok(())
}

/// Check, prepare and move a staged asset into place.
async fn promote(layout: &Layout, id: &NetworkId, asset: Asset) -> Result<(), FetchError> {
    let part = part_path(layout, id, asset);
    verify(layout, id, asset, &part)?;
    #[cfg(unix)]
    if asset.is_executable() {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| FetchError::io(&part, e))?;
    }
    let path = layout.asset_path(id, asset);
    tokio::fs::rename(&part, &path)
        .await
        .map_err(|e| FetchError::io(&path, e))
}

/// The verification slot: called on the staged bytes of every asset before it is
/// promoted, so nothing unverified becomes runnable. It accepts everything until
/// asset authentication lands; its arguments are what that must bind together.
fn verify(
    _layout: &Layout,
    _id: &NetworkId,
    _asset: Asset,
    _staged: &Path,
) -> Result<(), FetchError> {
    Ok(())
}

fn download_error(error: anyhow::Error, id: &NetworkId, url: &str, part: &Path) -> FetchError {
    let error = match error.downcast::<reqwest::Error>() {
        Ok(e) if e.status() == Some(StatusCode::NOT_FOUND) => {
            return FetchError::NotFound {
                id: id.to_string(),
                url: url.to_owned(),
            }
        }
        Ok(source) => {
            return FetchError::Http {
                url: url.to_owned(),
                source,
            }
        }
        Err(e) => e,
    };
    match error.downcast::<std::io::Error>() {
        Ok(source) => FetchError::io(part, source),
        Err(e) => FetchError::io(part, std::io::Error::other(e)),
    }
}

/// Turns per-chunk progress into `FetchEvent`s: `Started` once, then `Progress`
/// at most every [`PROGRESS_INTERVAL`], with the last value always delivered.
#[derive(Clone)]
struct Throttle {
    asset: Asset,
    on_event: OnFetchEvent,
    state: Arc<Mutex<ThrottleState>>,
}

#[derive(Default)]
struct ThrottleState {
    started: bool,
    last_emit: Option<Instant>,
    pending: Option<ProgressPayload>,
}

impl Throttle {
    fn new(asset: Asset, on_event: OnFetchEvent) -> Self {
        Self {
            asset,
            on_event,
            state: Arc::default(),
        }
    }

    fn progress(&self, p: ProgressPayload) {
        let mut s = self.state.lock().unwrap();
        if !s.started {
            s.started = true;
            (self.on_event)(FetchEvent::Started {
                asset: self.asset,
                total: p.total,
            });
        }
        let due = s.last_emit.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL);
        if due || (p.total > 0 && p.progress_total == p.total) {
            s.last_emit = Some(Instant::now());
            s.pending = None;
            (self.on_event)(FetchEvent::Progress {
                asset: self.asset,
                progress: p,
            });
        } else {
            s.pending = Some(p);
        }
    }

    fn finish(&self) {
        let mut s = self.state.lock().unwrap();
        if !s.started {
            (self.on_event)(FetchEvent::Started {
                asset: self.asset,
                total: 0,
            });
        }
        if let Some(p) = s.pending.take() {
            (self.on_event)(FetchEvent::Progress {
                asset: self.asset,
                progress: p,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform(name: &str) -> Platform {
        Platform(name.into())
    }

    #[test]
    fn network_ids_are_one_plain_lowercase_component() {
        for ok in [
            "dev-local",
            "devnet-78c3de28",
            "a",
            "0.x_y-z",
            &"a".repeat(64),
        ] {
            assert!(NetworkId::parse(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "../x",
            "a/b",
            "a\\b",
            ".hidden",
            "-x",
            "_x",
            "Dev",
            "a b",
            "list",
            "connect",
            "help",
            &"a".repeat(65),
        ] {
            assert_eq!(
                NetworkId::parse(bad).unwrap_err().kind(),
                "invalidNetworkId",
                "{bad}"
            );
        }
    }

    #[test]
    fn platforms_map_to_their_published_names() {
        let p = |os, arch| Platform::from_os_arch(os, arch).map(|p| p.0);
        assert_eq!(p("linux", "x86_64").unwrap(), "linux-x64");
        assert_eq!(p("linux", "aarch64").unwrap(), "linux-arm64");
        assert_eq!(p("macos", "x86_64").unwrap(), "macos-x64");
        assert_eq!(p("macos", "aarch64").unwrap(), "macos-arm64");
        assert_eq!(p("windows", "x86_64").unwrap(), "windows-x64");
        assert_eq!(
            p("plan9", "mips").unwrap_err().kind(),
            "unsupportedPlatform"
        );
        assert_eq!(
            Platform::current().map(|p| p.0).ok(),
            p(env::consts::OS, env::consts::ARCH).ok()
        );
    }

    #[test]
    fn layout_knows_urls_and_paths() {
        let id = NetworkId::parse("devnet-1").unwrap();
        let linux = Layout::new(
            "https://h.example/",
            "/d/networks".into(),
            platform("linux-x64"),
        );
        assert_eq!(linux.index_url(), "https://h.example/networks.json");
        assert_eq!(
            linux.asset_url(&id, Asset::Walletshield),
            "https://h.example/devnet-1/walletshield-linux-x64"
        );
        assert_eq!(
            linux.asset_url(&id, Asset::ClientToml),
            "https://h.example/devnet-1/client.toml"
        );
        assert_eq!(
            linux.asset_path(&id, Asset::Walletshield),
            Path::new("/d/networks/devnet-1/walletshield")
        );
        let windows = Layout::new(
            "https://h.example",
            "/d/networks".into(),
            platform("windows-x64"),
        );
        assert_eq!(
            windows.asset_url(&id, Asset::Walletshield),
            "https://h.example/devnet-1/walletshield-windows-x64"
        );
        assert_eq!(
            windows.asset_path(&id, Asset::Walletshield),
            Path::new("/d/networks/devnet-1/walletshield.exe")
        );
        assert_eq!(
            part_path(&windows, &id, Asset::Walletshield),
            Path::new("/d/networks/devnet-1/walletshield.exe.part")
        );
    }

    #[test]
    fn ids_and_platforms_honour_format_width() {
        let id = NetworkId::parse("dev-1").unwrap();
        assert_eq!(format!("[{id:<8}]"), "[dev-1   ]");
        assert_eq!(format!("[{:>11}]", platform("linux-x64")), "[  linux-x64]");
    }

    #[test]
    fn fetch_events_serialize_for_the_desktop() {
        let json = serde_json::to_value(FetchEvent::Started {
            asset: Asset::ClientToml,
            total: 7,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"event": "started", "data": {"asset": "clientToml", "total": 7}})
        );
    }
}
