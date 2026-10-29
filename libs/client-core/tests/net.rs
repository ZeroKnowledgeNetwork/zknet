use std::{
    convert::Infallible,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use anyhow::Result;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{server::conn::http1, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tempfile::NamedTempFile;
use tokio::{fs::File, io::AsyncReadExt};

use zknet_core::net::{download, upload, ProgressPayload};

/// Handle a single request.
async fn handle_req(
    req: Request<hyper::body::Incoming>,
    uploaded: Arc<Mutex<Vec<u8>>>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    const DOWNLOAD_BODY: &[u8] = b"hello-async-world";

    match (req.method(), req.uri().path()) {
        (&Method::GET, "/download") => Ok(Response::builder()
            .status(StatusCode::OK)
            .header("Content-Length", DOWNLOAD_BODY.len())
            .body(Full::from(Bytes::from_static(DOWNLOAD_BODY)))
            .unwrap()),

        (&Method::PUT, "/upload") => {
            let bytes = req
                .into_body()
                .collect()
                .await
                .expect("collect body")
                .to_bytes();
            uploaded.lock().unwrap().extend_from_slice(&bytes);
            Ok(Response::new(Full::from(Bytes::from_static(b"ok"))))
        }

        _ => Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Full::from(Bytes::new()))
            .unwrap()),
    }
}

/// Spawn an HTTP/1.1 server on an ephemeral port.
async fn spawn_test_server(
    uploaded: Arc<Mutex<Vec<u8>>>,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;

    let handle = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("accept error: {e}");
                    continue;
                }
            };

            let io = TokioIo::new(stream);
            let uploaded = uploaded.clone();

            tokio::spawn(async move {
                if let Err(e) = http1::Builder::new()
                    .serve_connection(io, service_fn(move |req| handle_req(req, uploaded.clone())))
                    .await
                {
                    eprintln!("srv err: {e}");
                }
            });
        }
    });

    Ok((addr, handle))
}

#[tokio::test(flavor = "multi_thread")]
async fn download_and_upload_roundtrip() -> Result<()> {
    let uploaded = Arc::new(Mutex::new(Vec::new()));
    let (addr, _srv) = spawn_test_server(uploaded.clone()).await?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    /* ---------- download ---------- */
    let tmp = NamedTempFile::new()?;
    let mut tmp_file = File::create(tmp.path()).await?;

    // Use Arc<Mutex> to fix lifetime issues
    let events = Arc::new(Mutex::new(Vec::<ProgressPayload>::new()));
    let events_clone = events.clone();

    download(
        &client,
        &format!("http://{addr}/download"),
        &mut tmp_file,
        Some(Box::new(move |p| {
            events_clone.lock().unwrap().push(p);
        })),
        None,
        None,
    )
    .await?;

    let mut buf = String::new();
    File::open(tmp.path())
        .await?
        .read_to_string(&mut buf)
        .await?;
    assert_eq!(buf.as_bytes(), b"hello-async-world");

    // Check events after the download is complete
    {
        let events_guard = events.lock().unwrap();
        assert!(!events_guard.is_empty());
        assert_eq!(
            events_guard.last().unwrap().progress_total,
            buf.len() as u64
        );
    } // drop events_guard

    /* ---------- upload ---------- */
    let resp_text = upload(
        &client,
        &format!("http://{addr}/upload"),
        tmp.path(),
        None,
        None,
    )
    .await?;
    assert_eq!(resp_text, "ok");
    assert_eq!(&*uploaded.lock().unwrap(), b"hello-async-world");

    Ok(())
}
