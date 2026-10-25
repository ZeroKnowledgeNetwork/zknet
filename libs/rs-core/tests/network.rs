//! The network contract against a scripted HTTP server in the published layout.

use std::{
    collections::HashMap,
    convert::Infallible,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use bytes::Bytes;
use futures_util::{stream, StreamExt};
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::{body::Frame, server::conn::http1, service::service_fn, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tempfile::TempDir;

use zknet_core::network::{
    cached, fetch_index, http_client, list, prepare, Asset, FetchError, FetchEvent, FetchOptions,
    Layout, NetworkId, NetworkKind, OnFetchEvent, Platform, Prepared, Status,
};

type Body = BoxBody<Bytes, std::io::Error>;

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

    async fn handle(
        &self,
        req: Request<hyper::body::Incoming>,
    ) -> Result<Response<Body>, Infallible> {
        let path = req.uri().path().to_owned();
        *self.hits.lock().unwrap().entry(path.clone()).or_default() += 1;
        let route = self.routes.lock().unwrap().get(&path).cloned();
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
    let layout = Layout::new(&base, cache.path().join("networks"), platform);
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
    let other = Layout::new(&base, layout.networks_dir.clone(), layout.platform.clone());
    (server, other)
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
    assert_eq!(server.total_hits(), before);
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

    get(&layout, FetchOptions { refresh: true }, None)
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

    let err = get(&layout, FetchOptions { refresh: true }, None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "http", "{err}");
    let dir = layout.network_dir(&id());
    assert_eq!(
        files(&dir),
        [
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

#[tokio::test]
async fn list_gives_every_network_a_status_live_first() {
    let (server, layout, _cache) = published().await;
    server.route("/networks.json", Route::Ok(INDEX.as_bytes().to_vec()));
    get(&layout, FetchOptions::default(), None).await.unwrap();
    // a copy from another source, one with no origin record, and an incomplete one
    let (_b, other) = other_source(&layout, "devnet-x").await;
    prepare_id(&other, "devnet-x").await.unwrap();
    for (dir, names) in [
        (
            "dev-old",
            &["client.toml", "services.json", "walletshield"][..],
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
    assert_eq!(listing.index_error, None);
    assert_eq!(listing.source, layout.base_url);
    assert_eq!(
        listing.source_label.as_deref(),
        layout.base_url.strip_prefix("http://")
    );
    let rows: Vec<(&str, Status)> = listing
        .networks
        .iter()
        .map(|n| (n.id.as_str(), n.status))
        .collect();
    assert_eq!(
        rows,
        [
            // live together, newest first: an older ready sorts below a newer available
            ("devnet-2", Status::Available),
            ("devnet-1", Status::Ready),
            ("lab-1", Status::Available),
            ("dev-old", Status::Unlisted),
            ("devnet-x", Status::OtherSource),
        ]
    );
    let x = &listing.networks[4];
    assert_eq!(x.origin.as_deref(), Some(other.base_url.as_str()));
    assert_eq!(
        x.origin_label.as_deref(),
        other.base_url.strip_prefix("http://")
    );
    // details of a copy no longer listed come from its origin record
    assert_eq!(x.entry.as_ref().unwrap().created, "2026-10-23T08:00:00Z");
    assert!(x.created_ago.as_deref().unwrap().ends_with(" ago"));
    assert!(listing.networks[3].entry.is_none());
    assert!(listing
        .networks
        .iter()
        .all(|n| n.id.as_str() != "dev-partial"));
}

#[tokio::test]
async fn list_survives_an_unreachable_or_broken_index() {
    let (server, layout, _cache) = published().await;
    get(&layout, FetchOptions::default(), None).await.unwrap();
    for route in [
        Route::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Route::Ok(b"<html>".to_vec()),
    ] {
        server.route("/networks.json", route);
        let listing = list(&http_client().unwrap(), &layout).await;
        assert!(listing.index_error.is_some());
        assert_eq!(listing.networks.len(), 1);
        assert_eq!(listing.networks[0].id.as_str(), ID);
        assert_eq!(listing.networks[0].status, Status::Cached);
        // the recorded entry still gives the row its details
        assert!(listing.networks[0].entry.is_some());
    }
}

/// ?3-2: the current source doesn't list it, so the copy from elsewhere runs.
#[tokio::test]
async fn an_other_source_copy_is_used_when_the_current_source_does_not_list_it() {
    let (server, layout, _cache) = published().await;
    let (_b, other) = other_source(&layout, "devnet-x").await;
    prepare_id(&other, "devnet-x").await.unwrap();

    let before = server.total_hits();
    let prepared = prepare_id(&layout, "devnet-x").await.unwrap();
    assert!(prepared.other_source);
    assert_eq!(prepared.origin, other.base_url);
    // one index read, no asset requests to the current source
    assert_eq!(server.total_hits(), before + 1);
    assert_eq!(server.hits("/devnet-x/client.toml"), 0);
}

/// ?3-3: the current source lists the same id, so its bytes replace the other copy.
#[tokio::test]
async fn another_source_s_bytes_never_run_under_an_id_the_current_source_lists() {
    let (server, layout, _cache) = published().await;
    let (_b, other) = other_source(&layout, ID).await;
    prepare_id(&other, ID).await.unwrap();
    assert_eq!(
        std::fs::read(layout.asset_path(&id(), Asset::Walletshield)).unwrap(),
        vec![8; 1000]
    );

    let prepared = prepare_id(&layout, ID).await.unwrap();
    assert!(!prepared.other_source);
    assert_eq!(prepared.origin, layout.base_url);
    assert_eq!(server.hits(&format!("/{ID}/walletshield-linux-x64")), 1);
    assert_eq!(
        std::fs::read(layout.asset_path(&id(), Asset::Walletshield)).unwrap(),
        vec![7; 300_000]
    );
    assert_eq!(
        layout.cached_origin(&id()).unwrap().base_url,
        layout.base_url
    );
}

/// An unreachable current source never falls back to another source's copy.
#[tokio::test]
async fn an_unreachable_source_does_not_fall_back_to_another_copy() {
    let (_server, layout, _cache) = published().await;
    let (_b, other) = other_source(&layout, "devnet-x").await;
    prepare_id(&other, "devnet-x").await.unwrap();
    let down = Layout::new(
        "http://127.0.0.1:9",
        layout.networks_dir.clone(),
        layout.platform.clone(),
    );
    let err = prepare_id(&down, "devnet-x").await.unwrap_err();
    assert_eq!(err.kind(), "http", "{err}");
}
