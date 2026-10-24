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
    cached, fetch, fetch_index, http_client, list, Asset, FetchError, FetchEvent, FetchOptions,
    Layout, NetworkId, OnFetchEvent, Platform,
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
    let base = server.start().await;
    let cache = TempDir::new().unwrap();
    let platform = Platform::from_os_arch(PLATFORM.0, PLATFORM.1).unwrap();
    let layout = Layout::new(&base, cache.path().join("networks"), platform);
    (server, layout, cache)
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
    fetch(&http_client().unwrap(), layout, &id(), opts, on).await
}

#[tokio::test]
async fn fetch_installs_the_complete_asset_set() {
    let (server, layout, _cache) = published().await;
    let dir = get(&layout, FetchOptions::default(), None).await.unwrap();

    assert_eq!(dir, layout.network_dir(&id()));
    assert_eq!(
        files(&dir),
        ["client.toml", "services.json", "walletshield"]
    );
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
    let err = fetch(
        &http_client().unwrap(),
        &layout,
        &other,
        FetchOptions::default(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), "notFound", "{err}");
    assert_eq!(files(&layout.network_dir(&other)), Vec::<String>::new());
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
        ["client.toml", "services.json", "walletshield"]
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
    assert_eq!(files(&layout.network_dir(&id())), Vec::<String>::new());
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

#[tokio::test]
async fn list_merges_live_and_cached_networks() {
    let (server, layout, _cache) = published().await;
    server.route("/networks.json", Route::Ok(INDEX.as_bytes().to_vec()));
    get(&layout, FetchOptions::default(), None).await.unwrap();
    // a retired network still on disk, and an incomplete one that does not count
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
    let rows: Vec<(&str, bool, bool)> = listing
        .networks
        .iter()
        .map(|n| (n.id.as_str(), n.listed.is_some(), n.cached))
        .collect();
    assert_eq!(
        rows,
        [
            ("devnet-2", true, false),
            ("devnet-1", true, true),
            ("lab-1", true, false),
            ("dev-old", false, true)
        ]
    );
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
        assert!(listing.networks[0].cached);
    }
}
