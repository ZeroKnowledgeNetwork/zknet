//! The network contract against a scripted HTTP server in the published layout.

use std::{
    collections::HashMap,
    convert::Infallible,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use bytes::Bytes;
use futures_util::{stream, StreamExt};
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::{body::Frame, server::conn::http1, service::service_fn, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tempfile::TempDir;

use sha2::{Digest, Sha256};
use zknet_core::{
    auth::TrustRoot,
    network::{
        cached, fetch_index, http_client, list, prepare, Asset, FetchError, FetchEvent,
        FetchOptions, Layout, NetworkId, NetworkKind, OnFetchEvent, Platform, Prepared, Status,
    },
};

type Body = BoxBody<Bytes, std::io::Error>;

/// A throwaway minisign key pair: the publisher in these tests.
struct Signer {
    pk: minisign::PublicKey,
    sk: minisign::SecretKey,
}

impl Signer {
    fn new() -> Self {
        let minisign::KeyPair { pk, sk } =
            minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        Self { pk, sk }
    }

    fn root(&self) -> TrustRoot {
        TrustRoot::minisign(&self.pk.to_base64()).unwrap()
    }

    fn sign(&self, list: &[u8], trusted: &str) -> Vec<u8> {
        minisign::sign(
            Some(&self.pk),
            &self.sk,
            std::io::Cursor::new(list),
            Some(trusted),
            Some("signature from a test key"),
        )
        .unwrap()
        .to_string()
        .into_bytes()
    }
}

/// The key every test server signs with, and every test layout trusts.
static PUBLISHER: LazyLock<Signer> = LazyLock::new(Signer::new);
const BUILD: &str = "v0.4.3-424-gfe69171";
const TRUSTED: &str =
    "zknet-assets v1 build=v0.4.3-424-gfe69171 commit=fe69171 timestamp:1793042057";

/// `sha256sum` lines for `(name, bytes)`.
fn checksums(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    files
        .iter()
        .map(|(name, bytes)| {
            let hash: String = Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            format!("{hash}  {name}\n")
        })
        .collect::<String>()
        .into_bytes()
}

/// How the server answers one path.
#[derive(Clone)]
enum Route {
    Ok(Vec<u8>),
    Status(StatusCode),
    /// Announce the full length, send half, then drop the connection.
    Cut(Vec<u8>),
    /// Send `chunk` bytes every `every`, `n` times.
    Slow {
        chunk: usize,
        every: Duration,
        n: usize,
    },
}

#[derive(Clone, Default)]
struct Server {
    routes: Arc<Mutex<HashMap<String, Route>>>,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

impl Server {
    fn route(&self, path: &str, route: Route) {
        self.routes.lock().unwrap().insert(path.into(), route);
    }

    fn hits(&self, path: &str) -> usize {
        self.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    fn total_hits(&self) -> usize {
        self.hits.lock().unwrap().values().sum()
    }

    /// The signed list of a network's binaries as routed now, as the publish
    /// flow would sign it.
    fn signed_list(&self, network: &str) -> Vec<u8> {
        let prefix = format!("/{network}/walletshield-");
        let routes = self.routes.lock().unwrap();
        let mut files: Vec<(String, Vec<u8>)> = routes
            .iter()
            .filter(|(p, _)| p.starts_with(&prefix))
            .filter_map(|(p, r)| {
                let bytes = match r {
                    Route::Ok(b) | Route::Cut(b) => b.clone(),
                    Route::Slow { chunk, n, .. } => vec![b'x'; chunk * n],
                    Route::Status(_) => return None,
                };
                Some((p.rsplit('/').next().unwrap().to_owned(), bytes))
            })
            .collect();
        files.sort();
        checksums(&files)
    }

    /// A route, or else the network's signed list and its signature.
    fn route_for(&self, path: &str) -> Option<Route> {
        let routed = |p: &str| self.routes.lock().unwrap().get(p).cloned();
        if let Some(route) = routed(path) {
            return Some(route);
        }
        let (network, file) = path.trim_start_matches('/').split_once('/')?;
        let list = || match routed(&format!("/{network}/checksums.txt")) {
            Some(Route::Ok(b)) => b,
            _ => self.signed_list(network),
        };
        match file {
            "checksums.txt" => Some(Route::Ok(list())),
            "checksums.txt.minisig" => Some(Route::Ok(PUBLISHER.sign(&list(), TRUSTED))),
            _ => None,
        }
    }

    async fn handle(
        &self,
        req: Request<hyper::body::Incoming>,
    ) -> Result<Response<Body>, Infallible> {
        let path = req.uri().path().to_owned();
        *self.hits.lock().unwrap().entry(path.clone()).or_default() += 1;
        let route = self.route_for(&path);
        let full = |b: Vec<u8>| Full::from(b).map_err(|e| match e {}).boxed();
        Ok(match route {
            None => status(StatusCode::NOT_FOUND),
            Some(Route::Status(code)) => status(code),
            Some(Route::Ok(body)) => Response::builder()
                .header("Content-Length", body.len())
                .body(full(body))
                .unwrap(),
            Some(Route::Cut(body)) => {
                let half = Bytes::from(body[..body.len() / 2].to_vec());
                let frames = stream::iter([
                    Ok(Frame::data(half)),
                    Err(std::io::Error::other("connection cut")),
                ]);
                Response::builder()
                    .header("Content-Length", body.len())
                    .body(BodyExt::boxed(StreamBody::new(frames)))
                    .unwrap()
            }
            Some(Route::Slow { chunk, every, n }) => {
                let frames = stream::iter(0..n).then(move |_| async move {
                    tokio::time::sleep(every).await;
                    Ok::<_, std::io::Error>(Frame::data(Bytes::from(vec![b'x'; chunk])))
                });
                Response::builder()
                    .header("Content-Length", chunk * n)
                    .body(BodyExt::boxed(StreamBody::new(frames)))
                    .unwrap()
            }
        })
    }

    /// Serve on an ephemeral loopback port; returns the base URL.
    async fn start(&self) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = self.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let server = server.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let server = server.clone();
                        async move { server.handle(req).await }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        format!("http://{addr}")
    }
}

fn status(code: StatusCode) -> Response<Body> {
    Response::builder()
        .status(code)
        .body(Full::new(Bytes::new()).map_err(|e| match e {}).boxed())
        .unwrap()
}

const ID: &str = "devnet-1";
const PLATFORM: (&str, &str) = ("linux", "x86_64");

fn id() -> NetworkId {
    NetworkId::parse(ID).unwrap()
}

/// A server publishing network `ID` for `PLATFORM`, and a fresh cache.
async fn published() -> (Server, Layout, TempDir) {
    let server = Server::default();
    server.route(
        &format!("/{ID}/client.toml"),
        Route::Ok(b"[client]\n".to_vec()),
    );
    server.route(&format!("/{ID}/services.json"), Route::Ok(b"{}\n".to_vec()));
    server.route(
        &format!("/{ID}/walletshield-linux-x64"),
        Route::Ok(vec![7; 300_000]),
    );
    server.route("/networks.json", Route::Ok(index_of(&[ID]).into_bytes()));
    let base = server.start().await;
    let cache = TempDir::new().unwrap();
    let platform = Platform::from_os_arch(PLATFORM.0, PLATFORM.1).unwrap();
    let layout = Layout::new(&base, cache.path().join("networks"), platform)
        .with_trust_root(PUBLISHER.root());
    (server, layout, cache)
}

/// An index listing `ids`, created on the hour from 2026-10-23T08:00Z in order.
fn index_of(ids: &[&str]) -> String {
    let entries: Vec<String> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            format!(r#"{{"id": "{id}", "kind": "devnet", "name": "{id}", "created": "2026-10-23T{:02}:00:00Z"}}"#, 8 + i)
        })
        .collect();
    format!(r#"{{"schema": 1, "networks": [{}]}}"#, entries.join(", "))
}

/// An index of `(id, created)` publications.
fn index(entries: &[(&str, &str)]) -> Vec<u8> {
    let entries: Vec<String> = entries
        .iter()
        .map(|(id, created)| {
            format!(r#"{{"id": "{id}", "kind": "devnet", "name": "{id}", "created": "{created}"}}"#)
        })
        .collect();
    format!(r#"{{"schema": 1, "networks": [{}]}}"#, entries.join(", ")).into_bytes()
}

/// A second source publishing `id` with its own bytes, sharing `layout`'s cache.
async fn other_source(layout: &Layout, id: &str) -> (Server, Layout) {
    let server = Server::default();
    server.route(
        &format!("/{id}/client.toml"),
        Route::Ok(b"[other]\n".to_vec()),
    );
    server.route(&format!("/{id}/services.json"), Route::Ok(b"{}\n".to_vec()));
    server.route(
        &format!("/{id}/walletshield-linux-x64"),
        Route::Ok(vec![8; 1000]),
    );
    server.route("/networks.json", Route::Ok(index_of(&[id]).into_bytes()));
    let base = server.start().await;
    (server, layout.at(&base))
}

fn recorder() -> (OnFetchEvent, Arc<Mutex<Vec<FetchEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (Arc::new(move |e| sink.lock().unwrap().push(e)), events)
}

fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

async fn get(
    layout: &Layout,
    opts: FetchOptions,
    on: Option<OnFetchEvent>,
) -> Result<std::path::PathBuf, FetchError> {
    prepare(&http_client().unwrap(), layout, &id(), opts, on)
        .await
        .map(|p| p.dir)
}

async fn prepare_id(layout: &Layout, id: &str) -> Result<Prepared, FetchError> {
    let id = NetworkId::parse(id).unwrap();
    prepare(
        &http_client().unwrap(),
        layout,
        &id,
        FetchOptions::default(),
        None,
    )
    .await
}

#[tokio::test]
async fn fetch_installs_the_complete_asset_set() {
    let (server, layout, _cache) = published().await;
    let dir = get(&layout, FetchOptions::default(), None).await.unwrap();

    assert_eq!(dir, layout.network_dir(&id()));
    assert_eq!(
        files(&dir),
        [
            "checksums.txt",
            "checksums.txt.minisig",
            "client.toml",
            "origin.json",
            "services.json",
            "walletshield"
        ]
    );
    let origin = layout.cached_origin(&id()).unwrap();
    assert_eq!(origin.base_url, layout.base_url);
    assert_eq!(origin.entry.unwrap().created, "2026-10-23T08:00:00Z");
    assert_eq!(
        std::fs::read(dir.join("walletshield")).unwrap(),
        vec![7; 300_000]
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("walletshield"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
    assert_eq!(server.hits(&format!("/{ID}/walletshield-linux-x64")), 1);
}

#[tokio::test]
async fn a_cached_network_is_used_without_a_request() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    let before = server.total_hits();

    let (on, events) = recorder();
    get(&layout, FetchOptions::default(), Some(on))
        .await
        .unwrap();
    // one index read decides it is current; no asset is requested
    assert_eq!(server.total_hits(), before + 1);
    assert_eq!(server.hits(&format!("/{ID}/walletshield-linux-x64")), 1);
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 3);
    assert!(events
        .iter()
        .all(|e| matches!(e, FetchEvent::Cached { .. })));
}

#[tokio::test]
async fn refresh_downloads_again() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    server.route(
        &format!("/{ID}/client.toml"),
        Route::Ok(b"[client] # new\n".to_vec()),
    );

    get(
        &layout,
        FetchOptions {
            refresh: true,
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(server.hits(&format!("/{ID}/client.toml")), 2);
    let toml = std::fs::read_to_string(layout.asset_path(&id(), Asset::ClientToml)).unwrap();
    assert_eq!(toml, "[client] # new\n");
}

#[tokio::test]
async fn an_unpublished_network_is_not_found() {
    let (_server, layout, _cache) = published().await;
    let other = NetworkId::parse("devnet-gone").unwrap();
    let err = prepare(
        &http_client().unwrap(),
        &layout,
        &other,
        FetchOptions::default(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), "notFound", "{err}");
    assert!(!layout.network_dir(&other).exists());
}

#[tokio::test]
async fn a_cut_download_leaves_no_part_and_keeps_the_cached_set() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    let binary = format!("/{ID}/walletshield-linux-x64");
    server.route(&binary, Route::Cut(vec![9; 300_000]));
    server.route(
        &format!("/{ID}/client.toml"),
        Route::Ok(b"[client] # new\n".to_vec()),
    );

    let err = get(
        &layout,
        FetchOptions {
            refresh: true,
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), "http", "{err}");
    let dir = layout.network_dir(&id());
    assert_eq!(
        files(&dir),
        [
            "checksums.txt",
            "checksums.txt.minisig",
            "client.toml",
            "origin.json",
            "services.json",
            "walletshield"
        ]
    );
    assert_eq!(
        std::fs::read(dir.join("walletshield")).unwrap(),
        vec![7; 300_000]
    );
    // nothing is promoted unless every asset arrived
    assert_eq!(
        std::fs::read_to_string(dir.join("client.toml")).unwrap(),
        "[client]\n"
    );
}

#[tokio::test]
async fn a_cut_first_download_leaves_nothing_cached() {
    let (server, layout, _cache) = published().await;
    server.route(
        &format!("/{ID}/walletshield-linux-x64"),
        Route::Cut(vec![9; 300_000]),
    );
    assert!(get(&layout, FetchOptions::default(), None).await.is_err());
    assert!(!layout.network_dir(&id()).exists());
    assert!(cached(&layout).is_empty());
}

/// A download that outlasts a 10 s total deadline still succeeds: only a
/// stalled connection may fail.
#[tokio::test]
async fn a_slow_download_is_not_cut_by_a_deadline() {
    let (server, layout, _cache) = published().await;
    let every = Duration::from_millis(500);
    server.route(
        &format!("/{ID}/walletshield-linux-x64"),
        Route::Slow {
            chunk: 1024,
            every,
            n: 23,
        },
    );
    let started = std::time::Instant::now();
    get(&layout, FetchOptions::default(), None).await.unwrap();
    assert!(started.elapsed() > Duration::from_secs(11));
    let binary = layout.asset_path(&id(), Asset::Walletshield);
    assert_eq!(std::fs::metadata(binary).unwrap().len(), 23 * 1024);
}

#[tokio::test]
async fn events_arrive_in_order_and_throttled() {
    let (server, layout, _cache) = published().await;
    server.route(
        &format!("/{ID}/walletshield-linux-x64"),
        Route::Slow {
            chunk: 100,
            every: Duration::from_millis(10),
            n: 50,
        },
    );
    let (on, events) = recorder();
    get(&layout, FetchOptions::default(), Some(on))
        .await
        .unwrap();

    let events = events.lock().unwrap();
    let binary: Vec<&FetchEvent> = events
        .iter()
        .filter(|e| match e {
            FetchEvent::Started { asset, .. }
            | FetchEvent::Progress { asset, .. }
            | FetchEvent::Finished { asset }
            | FetchEvent::Cached { asset } => *asset == Asset::Walletshield,
        })
        .collect();
    assert!(matches!(
        binary.first(),
        Some(FetchEvent::Started { total: 5000, .. })
    ));
    assert!(matches!(binary.last(), Some(FetchEvent::Finished { .. })));
    let progress: Vec<u64> = binary
        .iter()
        .filter_map(|e| match e {
            FetchEvent::Progress { progress, .. } => Some(progress.progress_total),
            _ => None,
        })
        .collect();
    // 50 chunks over ~500 ms: throttled to about one per 100 ms, last always sent
    assert!((2..=10).contains(&progress.len()), "{progress:?}");
    assert!(progress.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(progress.last(), Some(&5000));
    for asset in Asset::ALL {
        let finished = events
            .iter()
            .filter(|e| matches!(e, FetchEvent::Finished { asset: a } if *a == asset));
        assert_eq!(finished.count(), 1);
    }
}

const INDEX: &str = r#"{
  "schema": 1,
  "future": "ignored",
  "networks": [
    {"id": "devnet-2", "kind": "devnet", "name": "Devnet two", "created": "2026-10-23T12:00:00Z", "extra": 1},
    {"id": "../escape", "kind": "devnet", "name": "bad", "created": "2026-10-23T12:00:00Z"},
    {"id": "list", "kind": "devnet", "name": "reserved", "created": "2026-10-23T12:00:00Z"},
    {"id": "devnet-1", "kind": "devnet", "name": "Devnet one", "created": "2026-10-23T08:00:00Z"},
    {"id": "devnet-1", "kind": "devnet", "name": "duplicate", "created": "2026-10-23T08:00:00Z"},
    {"id": "lab-1", "kind": "lab", "name": "Lab", "created": "2026-10-23T08:00:00Z"}
  ]
}"#;

#[tokio::test]
async fn the_index_drops_invalid_and_duplicate_entries() {
    let (server, layout, _cache) = published().await;
    server.route("/networks.json", Route::Ok(INDEX.as_bytes().to_vec()));
    let index = fetch_index(&http_client().unwrap(), &layout).await.unwrap();
    let ids: Vec<&str> = index.networks.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, ["devnet-2", "devnet-1", "lab-1"]);
    assert_eq!(index.networks[1].name, "Devnet one");
    assert_eq!(
        serde_json::to_value(&index.networks[2].kind).unwrap(),
        "other"
    );
}

#[tokio::test]
async fn the_index_rejects_another_schema() {
    let (server, layout, _cache) = published().await;
    server.route(
        "/networks.json",
        Route::Ok(br#"{"schema": 2, "networks": []}"#.to_vec()),
    );
    let err = fetch_index(&http_client().unwrap(), &layout)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "index");
    assert!(err.to_string().contains("unsupported schema 2"));
}

/// The index `apps/network-assets` generates parses as this client reads it.
#[tokio::test]
async fn the_generated_index_fixture_parses() {
    let fixture = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/network-assets/fixtures/networks.json"
    ))
    .unwrap();
    let (server, layout, _cache) = published().await;
    server.route("/networks.json", Route::Ok(fixture));
    let index = fetch_index(&http_client().unwrap(), &layout).await.unwrap();
    let ids: Vec<&str> = index.networks.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, ["devnet-78c3de28", "dev-local"]);
    assert_eq!(index.networks[0].kind, NetworkKind::Devnet);
    assert_eq!(index.networks[1].kind, NetworkKind::Local);
    assert_eq!(index.networks[0].name, "Devnet · 2026-10-23");
}

fn rows(listing: &zknet_core::network::Listing) -> Vec<(&str, Status, &str)> {
    listing
        .networks
        .iter()
        .map(|n| (n.id.as_str(), n.status, n.source.as_str()))
        .collect()
}

#[tokio::test]
async fn every_network_is_judged_at_its_own_source() {
    let (server, layout, _cache) = published().await;
    server.route("/networks.json", Route::Ok(INDEX.as_bytes().to_vec()));
    get(&layout, FetchOptions::default(), None).await.unwrap();
    // B publishes devnet-x, which was downloaded, and devnet-y, which wasn't
    let (b, at_b) = other_source(&layout, "devnet-x").await;
    prepare_id(&at_b, "devnet-x").await.unwrap();
    b.route(
        "/networks.json",
        Route::Ok(index(&[
            ("devnet-x", "2026-10-23T08:00:00Z"),
            ("devnet-y", "2026-10-23T09:00:00Z"),
        ])),
    );
    // a copy with no recorded source, and an incomplete one that doesn't count
    for (dir, names) in [
        (
            "dev-old",
            &[
                "checksums.txt",
                "checksums.txt.minisig",
                "client.toml",
                "services.json",
                "walletshield",
            ][..],
        ),
        ("dev-partial", &["client.toml"][..]),
    ] {
        let dir = layout.networks_dir.join(dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in names {
            std::fs::write(dir.join(name), "x").unwrap();
        }
    }

    let listing = list(&http_client().unwrap(), &layout).await;
    assert!(listing.unreachable.is_empty(), "{:?}", listing.unreachable);
    let (a, bb) = (layout.base_url.as_str(), at_b.base_url.as_str());
    assert_eq!(
        rows(&listing),
        [
            // published at the launch source, newest first
            ("devnet-2", Status::Available, a),
            ("devnet-1", Status::Ready, a),
            ("lab-1", Status::Available, a),
            // published at a source a copy came from: discovered there too
            ("devnet-y", Status::Available, bb),
            ("devnet-x", Status::Ready, bb),
            // a copy with no recorded source is judged at the launch source
            ("dev-old", Status::Unpublished, a),
        ]
    );
    let x = &listing.networks[4];
    assert_eq!(x.source_label.as_deref(), bb.strip_prefix("http://"));
    assert!(x.created_ago.as_deref().unwrap().ends_with(" ago"));
    assert_eq!(listing.launch_label.as_deref(), a.strip_prefix("http://"));
}

#[tokio::test]
async fn an_unreachable_source_leaves_its_networks_cached() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    let (b, at_b) = other_source(&layout, "devnet-x").await;
    prepare_id(&at_b, "devnet-x").await.unwrap();

    b.route(
        "/networks.json",
        Route::Status(StatusCode::INTERNAL_SERVER_ERROR),
    );
    let listing = list(&http_client().unwrap(), &layout).await;
    assert_eq!(
        rows(&listing),
        [
            (ID, Status::Ready, layout.base_url.as_str()),
            ("devnet-x", Status::Cached, at_b.base_url.as_str())
        ]
    );
    assert_eq!(listing.unreachable.len(), 1);
    assert_eq!(listing.unreachable[0].source, at_b.base_url);
    assert!(!listing.launch_unreachable());
    // the copy still carries its details
    assert!(listing.networks[1].entry.is_some());

    for route in [
        Route::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Route::Ok(b"<html>".to_vec()),
    ] {
        server.route("/networks.json", route);
        let listing = list(&http_client().unwrap(), &layout).await;
        assert!(listing.launch_unreachable());
        assert_eq!(listing.networks[0].status, Status::Cached);
    }
}

/// A network runs at its own source, whatever the client was launched with.
#[tokio::test]
async fn a_network_connects_at_its_own_source() {
    let (server, layout, _cache) = published().await;
    let (b, at_b) = other_source(&layout, "devnet-x").await;
    prepare_id(&at_b, "devnet-x").await.unwrap();

    let prepared = prepare_id(&layout, "devnet-x").await.unwrap();
    assert_eq!(prepared.source, at_b.base_url);
    assert_eq!(server.hits("/devnet-x/client.toml"), 0);
    assert_eq!(b.hits("/devnet-x/client.toml"), 1);

    // not downloaded yet, published only at B: downloaded from B
    let (c, at_c) = other_source(&layout, "devnet-z").await;
    std::fs::remove_dir_all(layout.network_dir(&NetworkId::parse("devnet-x").unwrap())).unwrap();
    prepare_id(&at_c, "devnet-z").await.unwrap(); // C becomes known through its copy
    c.route(
        "/networks.json",
        Route::Ok(index(&[
            ("devnet-z", "2026-10-23T08:00:00Z"),
            ("devnet-w", "2026-10-23T09:00:00Z"),
        ])),
    );
    c.route("/devnet-w/client.toml", Route::Ok(b"[w]\n".to_vec()));
    c.route("/devnet-w/services.json", Route::Ok(b"{}\n".to_vec()));
    c.route("/devnet-w/walletshield-linux-x64", Route::Ok(vec![9; 10]));
    let prepared = prepare_id(&layout, "devnet-w").await.unwrap();
    assert_eq!(prepared.source, at_c.base_url);
    assert_eq!(c.hits("/devnet-w/walletshield-linux-x64"), 1);
}

/// ?3: a newer publication elsewhere re-origins the network; an older one doesn't.
#[tokio::test]
async fn a_newer_publication_re_origins_a_network_and_an_older_one_does_not() {
    let (server, layout, _cache) = published().await; // A publishes devnet-1 at 08:00
    let (b, at_b) = other_source(&layout, ID).await;

    // B published it at 07:00: older than A's, so A's bytes replace B's
    b.route(
        "/networks.json",
        Route::Ok(index(&[(ID, "2026-10-23T07:00:00Z")])),
    );
    prepare_id(&at_b, ID).await.unwrap();
    assert_eq!(
        std::fs::read(layout.asset_path(&id(), Asset::Walletshield)).unwrap(),
        vec![8; 1000]
    );
    let prepared = prepare_id(&layout, ID).await.unwrap();
    assert_eq!(prepared.source, layout.base_url);
    assert_eq!(
        std::fs::read(layout.asset_path(&id(), Asset::Walletshield)).unwrap(),
        vec![7; 300_000]
    );
    assert_eq!(
        layout.cached_origin(&id()).unwrap().base_url,
        layout.base_url
    );

    // B republishes it at 09:00, newer than A's. No copy points at B any more,
    // so B is known again only by launching at it; then B's bytes replace A's.
    b.route(
        "/networks.json",
        Route::Ok(index(&[(ID, "2026-10-23T09:00:00Z")])),
    );
    let listing = list(&http_client().unwrap(), &layout).await;
    assert_eq!(listing.networks[0].source, layout.base_url);
    let prepared = prepare_id(&at_b, ID).await.unwrap();
    assert_eq!(prepared.source, at_b.base_url);
    assert_eq!(
        std::fs::read(layout.asset_path(&id(), Asset::Walletshield)).unwrap(),
        vec![8; 1000]
    );

    // launched at A again, A's older publication doesn't win it back; and with
    // B down, B's newer copy still runs as is
    b.route(
        "/networks.json",
        Route::Status(StatusCode::INTERNAL_SERVER_ERROR),
    );
    let before = server.hits(&format!("/{ID}/walletshield-linux-x64"));
    let prepared = prepare_id(&layout, ID).await.unwrap();
    assert_eq!(prepared.source, at_b.base_url);
    assert_eq!(
        server.hits(&format!("/{ID}/walletshield-linux-x64")),
        before
    );
    let origin = layout.cached_origin(&id()).unwrap();
    assert_eq!(origin.base_url, at_b.base_url);
}

/// ?4: a source that republishes an id under a new `created` gets downloaded again.
#[tokio::test]
async fn a_republished_network_is_downloaded_again() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    server.route(
        "/networks.json",
        Route::Ok(index(&[(ID, "2026-10-23T08:30:00Z")])),
    );
    server.route(
        &format!("/{ID}/walletshield-linux-x64"),
        Route::Ok(vec![6; 10]),
    );

    let listing = list(&http_client().unwrap(), &layout).await;
    assert_eq!(listing.networks[0].status, Status::Available);
    get(&layout, FetchOptions::default(), None).await.unwrap();
    assert_eq!(server.hits(&format!("/{ID}/walletshield-linux-x64")), 2);
    assert_eq!(
        std::fs::read(layout.asset_path(&id(), Asset::Walletshield)).unwrap(),
        vec![6; 10]
    );
    let listing = list(&http_client().unwrap(), &layout).await;
    assert_eq!(listing.networks[0].status, Status::Ready);
}

/// An unpublished copy runs as it is; a down launch source doesn't stop a known network.
#[tokio::test]
async fn an_unpublished_or_unreachable_copy_still_runs() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    server.route("/networks.json", Route::Ok(index(&[])));
    let listing = list(&http_client().unwrap(), &layout).await;
    assert_eq!(listing.networks[0].status, Status::Unpublished);
    get(&layout, FetchOptions::default(), None).await.unwrap();

    server.route(
        "/networks.json",
        Route::Status(StatusCode::INTERNAL_SERVER_ERROR),
    );
    get(&layout, FetchOptions::default(), None).await.unwrap();
    assert_eq!(server.hits(&format!("/{ID}/walletshield-linux-x64")), 1);
}

// --- asset authentication: the signed binary list --------------------------

const BINARY: &str = "walletshield-linux-x64";

fn binary_path() -> String {
    format!("/{ID}/{BINARY}")
}

/// Pin the published list and signature to `files`, signed with `trusted`.
fn publish_list(server: &Server, files: &[(&str, Vec<u8>)], trusted: &str) {
    let files: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(n, b)| (n.to_string(), b.clone()))
        .collect();
    let list = checksums(&files);
    server.route(
        &format!("/{ID}/checksums.txt.minisig"),
        Route::Ok(PUBLISHER.sign(&list, trusted)),
    );
    server.route(&format!("/{ID}/checksums.txt"), Route::Ok(list));
}

/// Fetch `ID`, expecting a verification refusal; its message.
async fn refused(layout: &Layout, opts: FetchOptions) -> String {
    let err = get(layout, opts, None).await.unwrap_err();
    assert_eq!(err.kind(), "verification", "{err}");
    err.to_string()
}

/// Nothing of a refused first download is left behind.
fn nothing_cached(layout: &Layout) {
    assert!(!layout.network_dir(&id()).exists());
    assert!(cached(layout).is_empty());
}

fn prefix() -> String {
    format!("{BINARY} for network {ID} failed verification: ")
}

#[tokio::test]
async fn a_signed_binary_runs_and_its_build_is_recorded() {
    let (_server, layout, _cache) = published().await;
    let prepared = prepare_id(&layout, ID).await.unwrap();
    assert_eq!(prepared.build.as_deref(), Some(BUILD));
    assert_eq!(
        layout.cached_origin(&id()).unwrap().build.as_deref(),
        Some(BUILD)
    );
}

#[tokio::test]
async fn a_tampered_binary_is_refused_and_never_installed() {
    let (server, layout, _cache) = published().await;
    publish_list(&server, &[(BINARY, vec![7; 300_000])], TRUSTED);
    let mut tampered = vec![7; 300_000];
    tampered.push(b'!');
    server.route(&binary_path(), Route::Ok(tampered));

    let msg = refused(&layout, FetchOptions::default()).await;
    assert!(
        msg.starts_with(&format!("{}its sha256 is ", prefix())),
        "{msg}"
    );
    nothing_cached(&layout);
}

#[tokio::test]
async fn an_unsigned_network_is_refused() {
    let (server, layout, _cache) = published().await;
    server.route(
        &format!("/{ID}/checksums.txt.minisig"),
        Route::Status(StatusCode::NOT_FOUND),
    );
    let msg = refused(&layout, FetchOptions::default()).await;
    assert_eq!(
        msg,
        format!(
            "{}the source publishes no signature (checksums.txt.minisig)",
            prefix()
        )
    );
    nothing_cached(&layout);
}

#[tokio::test]
async fn another_key_is_refused_before_the_binary_downloads() {
    let (server, layout, _cache) = published().await;
    let stranger = Signer::new();
    let layout = layout.with_trust_root(stranger.root());
    let msg = refused(&layout, FetchOptions::default()).await;
    assert_eq!(
        msg,
        format!(
            "{}the asset list is signed by key {}, not by this client's key {}",
            prefix(),
            PUBLISHER.root().key_id(),
            stranger.root().key_id()
        )
    );
    assert_eq!(server.hits(&binary_path()), 0);
    nothing_cached(&layout);
}

#[tokio::test]
async fn another_platforms_binary_is_refused_and_named() {
    let (server, layout, _cache) = published().await;
    let arm = vec![3; 1000];
    server.route(
        &format!("/{ID}/walletshield-linux-arm64"),
        Route::Ok(arm.clone()),
    );
    publish_list(
        &server,
        &[
            ("walletshield-linux-arm64", arm.clone()),
            (BINARY, vec![7; 300_000]),
        ],
        TRUSTED,
    );
    server.route(&binary_path(), Route::Ok(arm));
    let msg = refused(&layout, FetchOptions::default()).await;
    assert!(
        msg.ends_with("(these are the bytes of walletshield-linux-arm64)"),
        "{msg}"
    );
    nothing_cached(&layout);
}

#[tokio::test]
async fn a_binary_from_another_build_is_refused() {
    let (server, layout, _cache) = published().await;
    publish_list(&server, &[(BINARY, vec![7; 300_000])], TRUSTED);
    server.route(&binary_path(), Route::Ok(vec![6; 300_000]));
    let msg = refused(&layout, FetchOptions::default()).await;
    assert!(msg.contains("but the signed asset list says"), "{msg}");
    nothing_cached(&layout);
}

#[tokio::test]
async fn an_edited_list_is_refused_before_the_binary_downloads() {
    let (server, layout, _cache) = published().await;
    publish_list(&server, &[(BINARY, vec![7; 300_000])], TRUSTED);
    server.route(
        &format!("/{ID}/checksums.txt"),
        Route::Ok(checksums(&[(BINARY.into(), vec![6; 300_000])])),
    );
    let msg = refused(&layout, FetchOptions::default()).await;
    assert_eq!(
        msg,
        format!(
            "{}the asset list's signature is invalid for key {}",
            prefix(),
            PUBLISHER.root().key_id()
        )
    );
    assert_eq!(server.hits(&binary_path()), 0);
    nothing_cached(&layout);
}

#[tokio::test]
async fn a_signature_that_is_not_for_an_asset_list_is_refused() {
    let (server, layout, _cache) = published().await;
    publish_list(
        &server,
        &[(BINARY, vec![7; 300_000])],
        "timestamp:1793042057\tfile:checksums.txt\thashed",
    );
    let msg = refused(&layout, FetchOptions::default()).await;
    assert_eq!(
        msg,
        format!("{}the signature is not for a zknet asset list", prefix())
    );
    nothing_cached(&layout);
}

#[tokio::test]
async fn any_signed_build_is_accepted_and_named() {
    let (server, layout, _cache) = published().await;
    publish_list(
        &server,
        &[(BINARY, vec![7; 300_000])],
        "zknet-assets v1 build=v0.4.3-198-g1196008 commit=1196008 timestamp:1792700000",
    );
    let prepared = prepare_id(&layout, ID).await.unwrap();
    assert_eq!(prepared.build.as_deref(), Some("v0.4.3-198-g1196008"));
}

#[tokio::test]
async fn a_refused_refresh_keeps_the_cached_set_as_it_was() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    let dir = layout.network_dir(&id());
    let before: Vec<(String, Vec<u8>)> = files(&dir)
        .into_iter()
        .map(|f| {
            let bytes = std::fs::read(dir.join(&f)).unwrap();
            (f, bytes)
        })
        .collect();

    // a new config arrives with a binary the list doesn't vouch for
    publish_list(&server, &[(BINARY, vec![7; 300_000])], TRUSTED);
    server.route(
        &format!("/{ID}/client.toml"),
        Route::Ok(b"[client] # new\n".to_vec()),
    );
    server.route(&binary_path(), Route::Ok(vec![6; 300_000]));
    let opts = FetchOptions {
        refresh: true,
        ..Default::default()
    };
    refused(&layout, opts).await;

    let after: Vec<(String, Vec<u8>)> = files(&dir)
        .into_iter()
        .map(|f| {
            let bytes = std::fs::read(dir.join(&f)).unwrap();
            (f, bytes)
        })
        .collect();
    assert_eq!(before, after, "the cached set changed");
}

#[tokio::test]
async fn a_cached_binary_is_checked_again_before_it_runs() {
    let (_server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    std::fs::write(
        layout.asset_path(&id(), Asset::Walletshield),
        b"changed on disk",
    )
    .unwrap();

    let msg = refused(&layout, FetchOptions::default()).await;
    assert!(
        msg.starts_with(&format!("{}its sha256 is ", prefix())),
        "{msg}"
    );
}

#[tokio::test]
async fn a_copy_without_its_signed_list_is_downloaded_again() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    std::fs::remove_file(layout.network_dir(&id()).join("checksums.txt.minisig")).unwrap();

    let prepared = prepare_id(&layout, ID).await.unwrap();
    assert_eq!(prepared.build.as_deref(), Some(BUILD));
    assert_eq!(server.hits(&binary_path()), 2);
}

#[tokio::test]
async fn a_loopback_source_may_serve_an_unsigned_set_when_asked() {
    // the test server is on 127.0.0.1 and tests are debug builds
    let (server, layout, _cache) = published().await;
    server.route(
        &format!("/{ID}/checksums.txt.minisig"),
        Route::Status(StatusCode::NOT_FOUND),
    );
    let opts = FetchOptions {
        allow_unsigned: true,
        ..Default::default()
    };
    let prepared = prepare(&http_client().unwrap(), &layout, &id(), opts, None)
        .await
        .unwrap();
    assert_eq!(prepared.build, None);
    let dir = layout.network_dir(&id());
    assert!(dir.join("walletshield").is_file());
    assert!(!dir.join("checksums.txt").exists());
    assert_eq!(
        layout.cached_origin(&id()),
        None,
        "an unsigned copy is not complete"
    );
}

#[tokio::test]
async fn asking_for_unsigned_still_verifies_a_signed_set() {
    let (server, layout, _cache) = published().await;
    publish_list(&server, &[(BINARY, vec![7; 300_000])], TRUSTED);
    server.route(&binary_path(), Route::Ok(vec![6; 300_000]));
    let opts = FetchOptions {
        allow_unsigned: true,
        ..Default::default()
    };
    let msg = refused(&layout, opts).await;
    assert!(msg.contains("but the signed asset list says"), "{msg}");
}

#[tokio::test]
async fn unsigned_is_refused_for_a_remote_source() {
    let (_server, layout, _cache) = published().await;
    // `.invalid` never resolves (RFC 2606), so no request leaves the host
    let remote = layout.at("https://zknet.invalid");
    let opts = FetchOptions {
        allow_unsigned: true,
        ..Default::default()
    };
    let err = prepare(&http_client().unwrap(), &remote, &id(), opts, None)
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        format!(
            "{}unsigned assets are allowed only from a local source (127.0.0.1, ::1 or localhost), not zknet.invalid",
            prefix()
        )
    );
}
