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

/// The built-in network source. Each client's config names it too (tests hold
/// them equal); it is never shown to users, so it may change freely.
pub const DEFAULT_SOURCE: &str = "https://dist.zknet.io";

const INDEX_FILE: &str = "networks.json";
const ORIGIN_FILE: &str = "origin.json";
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
    /// The published root, e.g. `https://dist.zknet.io`.
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

    /// Whether a complete asset set is on disk, from any source. Assets are
    /// promoted only once fully downloaded, so a present file is a whole one.
    fn is_complete(&self, id: &NetworkId) -> bool {
        Asset::ALL.iter().all(|&a| self.asset_path(id, a).is_file())
    }

    /// Where the copy on disk came from, if a complete one is there.
    pub fn cached_origin(&self, id: &NetworkId) -> Option<Origin> {
        if !self.is_complete(id) {
            return None;
        }
        let json = std::fs::read(self.network_dir(id).join(ORIGIN_FILE)).ok()?;
        serde_json::from_slice(&json).ok()
    }

    /// Whether a complete copy downloaded from this layout's source is on disk.
    pub fn is_cached(&self, id: &NetworkId) -> bool {
        self.cached_origin(id)
            .is_some_and(|o| o.base_url == self.base_url)
    }

    /// The source as users may see it: `None` for the built-in default.
    pub fn source_label(&self) -> Option<String> {
        source_label(&self.base_url)
    }
}

/// A network source as users may see it: its host (and path, if any), or
/// `None` for the built-in [`DEFAULT_SOURCE`], which is never shown.
pub fn source_label(base_url: &str) -> Option<String> {
    let base = base_url.trim_end_matches('/');
    (base != DEFAULT_SOURCE).then(|| {
        base.split_once("://")
            .map_or(base, |(_, rest)| rest)
            .to_owned()
    })
}

/// A URL with the built-in source shown as nothing: `None` if it is under it.
fn shown_url(url: &str) -> Option<&str> {
    let under_default = url
        .strip_prefix(DEFAULT_SOURCE)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'));
    (!under_default && !url.is_empty()).then_some(url)
}

fn at(url: &str) -> String {
    shown_url(url).map_or_else(String::new, |u| format!(" at {u}"))
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

/// `<networks_dir>/<id>/origin.json`: where a cached copy came from. Written
/// last when a fetch promotes, so it marks a complete set.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// The [`Layout::base_url`] the assets were downloaded from.
    pub base_url: String,
    /// RFC 3339, UTC.
    pub fetched: String,
    /// The index entry seen at download time, if the source listed it.
    pub entry: Option<IndexEntry>,
}

/// What a network is to this client now. Both clients render it; neither decides it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Listed by the current source, and a complete copy from it is on disk.
    Ready,
    /// Listed by the current source; connecting downloads it.
    Available,
    /// A copy from the current source is on disk; its index could not be read.
    Cached,
    /// A copy from the current source is on disk; its index no longer lists it.
    Unlisted,
    /// A copy from another source is on disk; the current source doesn't list it.
    OtherSource,
}

impl Status {
    /// Listed now: the networks a user most likely wants.
    pub fn is_live(self) -> bool {
        matches!(self, Status::Ready | Status::Available)
    }

    /// Live first (ready and available together), then what still works
    /// offline, then the rest.
    fn rank(self) -> u8 {
        match self {
            Status::Ready | Status::Available => 0,
            Status::Cached => 1,
            Status::Unlisted => 2,
            Status::OtherSource => 3,
        }
    }
}

/// One network as both clients list it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEntry {
    pub id: NetworkId,
    pub status: Status,
    /// The current index's entry, else the one recorded with the cached copy.
    pub entry: Option<IndexEntry>,
    /// The source of the copy on disk, if any (data: the full URL).
    pub origin: Option<String>,
    /// [`source_label`] of `origin`: `None` for the built-in source or no copy.
    pub origin_label: Option<String>,
    /// `entry.created` as `docker ps` writes CREATED, e.g. `11 hours ago`.
    pub created_ago: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The source this listing is for (data: the full URL).
    pub source: String,
    /// [`source_label`] of `source`: `None` for the built-in source.
    pub source_label: Option<String>,
    /// Live first, newest first within a status, then by id.
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
    #[error("network {id} is not published{}", at(url))]
    NotFound { id: String, url: String },
    #[error("request{} failed: {source}", shown_url(url).map_or_else(String::new, |u| format!(" to {u}")))]
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
    #[error("invalid network index{}: {reason}", at(url))]
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

    /// An HTTP error that names its URL once, in its own message, and only if
    /// it isn't under the built-in source.
    fn http(url: &str, source: reqwest::Error) -> Self {
        FetchError::Http {
            url: url.to_owned(),
            source: source.without_url(),
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
        .map_err(|source| FetchError::http("", source))
}

/// Read the index. Entries whose id is not a valid [`NetworkId`] are dropped.
pub async fn fetch_index(http: &Client, layout: &Layout) -> Result<Index, FetchError> {
    let url = layout.index_url();
    let http_err = |source| FetchError::http(&url, source);
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

/// The networks with a complete asset set on disk, by id, with where each came
/// from (`None` if that wasn't recorded).
pub fn cached(layout: &Layout) -> Vec<(NetworkId, Option<Origin>)> {
    let Ok(entries) = std::fs::read_dir(&layout.networks_dir) else {
        return Vec::new();
    };
    let mut ids: Vec<(NetworkId, Option<Origin>)> = entries
        .filter_map(|e| NetworkId::parse(e.ok()?.file_name().to_str()?).ok())
        .filter(|id| layout.is_complete(id))
        .map(|id| {
            let origin = layout.cached_origin(&id);
            (id, origin)
        })
        .collect();
    ids.sort_by(|a, b| a.0.cmp(&b.0));
    ids
}

/// The live networks merged with the cached ones, each with its [`Status`].
pub async fn list(http: &Client, layout: &Layout) -> Listing {
    let index = fetch_index(http, layout).await;
    listing(layout, index, std::time::SystemTime::now())
}

fn listing(
    layout: &Layout,
    index: Result<Index, FetchError>,
    now: std::time::SystemTime,
) -> Listing {
    let here = |o: &Option<Origin>| o.as_ref().is_none_or(|o| o.base_url == layout.base_url);
    let mut on_disk: std::collections::BTreeMap<NetworkId, Option<Origin>> =
        cached(layout).into_iter().collect();
    let (listed, index_error) = match index {
        Ok(index) => (Some(index.networks), None),
        Err(e) => (None, Some(e.to_string())),
    };

    let row = |id: NetworkId, status, entry: Option<IndexEntry>, origin: Option<&Origin>| {
        let origin = origin.map(|o| o.base_url.clone());
        NetworkEntry {
            created_ago: entry.as_ref().and_then(|e| created_ago(&e.created, now)),
            origin_label: origin.as_deref().and_then(source_label),
            id,
            status,
            entry,
            origin,
        }
    };

    let mut networks = Vec::new();
    for entry in listed.iter().flatten() {
        let Ok(id) = NetworkId::parse(&entry.id) else {
            continue;
        };
        let copy = on_disk.remove(&id);
        let (status, origin) = match copy {
            Some(Some(o)) if o.base_url == layout.base_url => (Status::Ready, Some(o)),
            // a copy from elsewhere doesn't count here, and is replaced on connect
            _ => (Status::Available, None),
        };
        networks.push(row(id, status, Some(entry.clone()), origin.as_ref()));
    }
    for (id, origin) in on_disk {
        let status = match (&listed, here(&origin)) {
            (_, false) => Status::OtherSource,
            (None, true) => Status::Cached,
            (Some(_), true) => Status::Unlisted,
        };
        let entry = origin.as_ref().and_then(|o| o.entry.clone());
        networks.push(row(id, status, entry, origin.as_ref()));
    }

    let created = |n: &NetworkEntry| n.entry.as_ref().map(|e| e.created.clone());
    networks.sort_by(|a, b| {
        a.status
            .rank()
            .cmp(&b.status.rank())
            .then_with(|| match (created(a), created(b)) {
                (Some(x), Some(y)) => y.cmp(&x),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.id.cmp(&b.id))
    });

    Listing {
        source: layout.base_url.clone(),
        source_label: layout.source_label(),
        networks,
        index_error,
    }
}

/// What [`prepare`] made ready to run.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// The network's directory, where WalletShield is spawned.
    pub dir: PathBuf,
    /// The source of the copy that will run (data: the full URL).
    pub origin: String,
    /// [`source_label`] of `origin`.
    pub origin_label: Option<String>,
    /// The copy came from another source than the current one: the current
    /// source doesn't list the network, and a copy from elsewhere is on disk.
    pub other_source: bool,
}

/// Make a network ready to run; both clients call this before spawning.
///
/// - A complete copy from the current source is used as is, without a request,
///   unless `opts.refresh`.
/// - Otherwise the index is read once. If the current source doesn't list the
///   network but a copy from another source is on disk, that copy is used.
/// - Otherwise the assets are downloaded from the current source, replacing any
///   copy from elsewhere: another source's bytes never run under an id the
///   current source publishes.
pub async fn prepare(
    http: &Client,
    layout: &Layout,
    id: &NetworkId,
    opts: FetchOptions,
    on_event: Option<OnFetchEvent>,
) -> Result<Prepared, FetchError> {
    let here = |dir| Prepared {
        dir,
        origin: layout.base_url.clone(),
        origin_label: layout.source_label(),
        other_source: false,
    };
    if !opts.refresh && layout.is_cached(id) {
        emit_cached(&on_event);
        return Ok(here(layout.network_dir(id)));
    }

    let index = fetch_index(http, layout).await.ok();
    let entry = index
        .as_ref()
        .and_then(|i| i.networks.iter().find(|n| n.id == id.as_str()).cloned());
    let elsewhere = layout
        .cached_origin(id)
        .filter(|o| o.base_url != layout.base_url);
    if let (Some(_), None, Some(origin)) = (&index, &entry, &elsewhere) {
        emit_cached(&on_event);
        return Ok(Prepared {
            dir: layout.network_dir(id),
            origin_label: source_label(&origin.base_url),
            origin: origin.base_url.clone(),
            other_source: true,
        });
    }

    fetch(http, layout, id, entry, on_event).await.map(here)
}

fn emit_cached(on_event: &Option<OnFetchEvent>) {
    if let Some(cb) = on_event {
        for asset in Asset::ALL {
            cb(FetchEvent::Cached { asset });
        }
    }
}

/// Download a network's assets from the layout's source, and return its directory.
///
/// Every asset is downloaded concurrently to `<name>.part`; only when all have
/// arrived is each one verified, made executable if it is the binary, and
/// renamed into place, with `origin.json` last. On any failure the `.part`
/// files are removed and the cached set is untouched.
async fn fetch(
    http: &Client,
    layout: &Layout,
    id: &NetworkId,
    entry: Option<IndexEntry>,
    on_event: Option<OnFetchEvent>,
) -> Result<PathBuf, FetchError> {
    let emit = |event| {
        if let Some(cb) = &on_event {
            cb(event)
        }
    };
    let dir = layout.network_dir(id);

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
        write_origin(layout, id, entry).await
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

/// Record where the promoted set came from, atomically.
async fn write_origin(
    layout: &Layout,
    id: &NetworkId,
    entry: Option<IndexEntry>,
) -> Result<(), FetchError> {
    let origin = Origin {
        base_url: layout.base_url.clone(),
        fetched: rfc3339(std::time::SystemTime::now()),
        entry,
    };
    let path = layout.network_dir(id).join(ORIGIN_FILE);
    let part = layout
        .network_dir(id)
        .join(format!("{ORIGIN_FILE}{PART_SUFFIX}"));
    let json = serde_json::to_vec_pretty(&origin).expect("an Origin serializes");
    tokio::fs::write(&part, json)
        .await
        .map_err(|e| FetchError::io(&part, e))?;
    tokio::fs::rename(&part, &path)
        .await
        .map_err(|e| FetchError::io(&path, e))
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
        Ok(source) => return FetchError::http(url, source),
        Err(e) => e,
    };
    match error.downcast::<std::io::Error>() {
        Ok(source) => FetchError::io(part, source),
        Err(e) => FetchError::io(part, std::io::Error::other(e)),
    }
}

/// `created` (RFC 3339, UTC) as `docker ps` writes CREATED: `11 hours ago`.
/// `None` if `created` doesn't parse.
pub fn created_ago(created: &str, now: std::time::SystemTime) -> Option<String> {
    let then = parse_rfc3339(created)?;
    let d = now.duration_since(then).unwrap_or_default();
    Some(format!("{} ago", human_duration(d)))
}

/// go-units `HumanDuration` (github.com/docker/go-units, duration.go), which
/// `docker ps` and `docker images` use for CREATED.
fn human_duration(d: Duration) -> String {
    let seconds = d.as_secs();
    let minutes = seconds / 60;
    let hours = (d.as_secs_f64() / 3600.0 + 0.5) as u64;
    match () {
        _ if seconds < 1 => "Less than a second".into(),
        _ if seconds == 1 => "1 second".into(),
        _ if seconds < 60 => format!("{seconds} seconds"),
        _ if minutes == 1 => "About a minute".into(),
        _ if minutes < 60 => format!("{minutes} minutes"),
        _ if hours == 1 => "About an hour".into(),
        _ if hours < 48 => format!("{hours} hours"),
        _ if hours < 24 * 7 * 2 => format!("{} days", hours / 24),
        _ if hours < 24 * 30 * 2 => format!("{} weeks", hours / 24 / 7),
        _ if hours < 24 * 365 * 2 => format!("{} months", hours / 24 / 30),
        _ => format!("{} years", seconds / 3600 / 24 / 365),
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` (what `assemble.sh` writes) to a time.
fn parse_rfc3339(s: &str) -> Option<std::time::SystemTime> {
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let shape = b.len() >= 20
        && [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')]
            .iter()
            .all(|&(i, c)| b[i] == c || (i == 10 && b[i] == b't'));
    let tail = s.get(19..).unwrap_or("");
    let utc = tail == "Z"
        || tail.strip_suffix('Z').is_some_and(|f| {
            f.starts_with('.') && f.len() > 1 && f[1..].bytes().all(|c| c.is_ascii_digit())
        });
    if !shape || !utc {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let secs = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec;
    let secs = u64::try_from(secs).ok()?;
    Some(std::time::UNIX_EPOCH + Duration::from_secs(secs))
}

/// A time as RFC 3339 UTC to the second, as `assemble.sh` writes `created`.
fn rfc3339(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86400));
    let rem = secs.rem_euclid(86400);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

// Howard Hinnant's civil-calendar algorithms (proleptic Gregorian, days since 1970-01-01).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
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
    fn created_ago_matches_go_units_human_duration() {
        let t0 = parse_rfc3339("2026-10-24T00:00:00Z").unwrap();
        let ago = |secs: u64| {
            created_ago("2026-10-24T00:00:00Z", t0 + Duration::from_secs(secs)).unwrap()
        };
        for (secs, want) in [
            (0, "Less than a second ago"),
            (1, "1 second ago"),
            (59, "59 seconds ago"),
            (60, "About a minute ago"),
            (119, "About a minute ago"),
            (120, "2 minutes ago"),
            (59 * 60 + 59, "59 minutes ago"),
            (3600, "About an hour ago"),
            (3600 + 29 * 60, "About an hour ago"),
            (3600 + 30 * 60, "2 hours ago"),
            (11 * 3600, "11 hours ago"),
            (47 * 3600, "47 hours ago"),
            (47 * 3600 + 30 * 60, "2 days ago"),
            (13 * 86400, "13 days ago"),
            (14 * 86400, "2 weeks ago"),
            (59 * 86400, "8 weeks ago"),
            (60 * 86400, "2 months ago"),
            (729 * 86400, "24 months ago"),
            (730 * 86400, "2 years ago"),
        ] {
            assert_eq!(ago(secs), want, "{secs}s");
        }
        // a clock behind the publisher's reads as just now, as docker does
        assert_eq!(
            created_ago("2026-10-24T00:00:10Z", t0).unwrap(),
            "Less than a second ago"
        );
    }

    #[test]
    fn rfc3339_round_trips_and_rejects_other_shapes() {
        for s in [
            "1970-01-01T00:00:00Z",
            "2026-10-24T07:18:14Z",
            "2000-02-29T23:59:59Z",
            "2100-03-01T00:00:00Z",
        ] {
            assert_eq!(rfc3339(parse_rfc3339(s).unwrap()), s);
        }
        assert_eq!(
            parse_rfc3339("2026-10-24T07:18:14.250Z"),
            parse_rfc3339("2026-10-24T07:18:14Z")
        );
        for bad in [
            "",
            "2026-10-24",
            "2026-10-24T07:18:14",
            "2026-10-24T07:18:14+02:00",
            "2026-13-01T00:00:00Z",
            "yesterday",
        ] {
            assert_eq!(parse_rfc3339(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_built_in_source_is_never_shown() {
        assert_eq!(source_label(DEFAULT_SOURCE), None);
        assert_eq!(source_label(&format!("{DEFAULT_SOURCE}/")), None);
        assert_eq!(
            source_label("http://127.0.0.1:8765").as_deref(),
            Some("127.0.0.1:8765")
        );
        assert_eq!(
            source_label("https://mirror.example/zknet/").as_deref(),
            Some("mirror.example/zknet")
        );
        // a host that merely starts like the default is not the default
        assert_eq!(
            source_label("https://dist.zknet.io.evil").as_deref(),
            Some("dist.zknet.io.evil")
        );

        let hidden = FetchError::NotFound {
            id: "devnet-1".into(),
            url: format!("{DEFAULT_SOURCE}/devnet-1/client.toml"),
        };
        assert_eq!(hidden.to_string(), "network devnet-1 is not published");
        let shown = FetchError::NotFound {
            id: "devnet-1".into(),
            url: "http://127.0.0.1:8765/devnet-1/client.toml".into(),
        };
        assert_eq!(
            shown.to_string(),
            "network devnet-1 is not published at http://127.0.0.1:8765/devnet-1/client.toml"
        );
        let index = FetchError::Index {
            url: format!("{DEFAULT_SOURCE}/networks.json"),
            reason: "HTTP 500".into(),
        };
        assert_eq!(index.to_string(), "invalid network index: HTTP 500");
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
