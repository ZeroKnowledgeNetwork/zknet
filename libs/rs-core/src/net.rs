//! Async upload / download with back-pressure.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use bytes::Bytes;
use futures_util::{stream, StreamExt};
use reqwest::{header::HeaderMap, Body, Client};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Progress event (follows Tauri upload plugin API)
#[derive(Debug, Serialize, Clone)]
pub struct ProgressPayload {
    /// Bytes in this chunk
    pub progress: u64,
    /// Bytes transferred so far
    pub progress_total: u64,
    /// Total size if known (`0` = unknown)
    pub total: u64,
    /// Bytes per second
    pub transfer_speed: f64,
}

pub type ProgressCallback = Box<dyn FnMut(ProgressPayload) + Send + 'static>;

/// Stream `url` into `writer` without buffering the whole body.
pub async fn download<W>(
    client: &Client,
    url: &str,
    mut writer: W,
    mut progress: Option<ProgressCallback>,
    headers: Option<HeaderMap>,
    body: Option<String>,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin + Send,
{
    let mut req = client.get(url);
    if let Some(h) = headers {
        req = req.headers(h);
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);

    let start = Instant::now();
    let mut downloaded = 0u64;

    let mut bytes_stream = resp.bytes_stream();
    while let Some(chunk) = bytes_stream.next().await {
        let bytes = chunk?;
        writer.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;

        if let Some(cb) = progress.as_mut() {
            let elapsed = start.elapsed().max(Duration::from_micros(1));
            cb(ProgressPayload {
                progress: bytes.len() as u64,
                progress_total: downloaded,
                total,
                transfer_speed: downloaded as f64 / elapsed.as_secs_f64(),
            });
        }
    }
    writer.flush().await?;
    writer.shutdown().await?;
    Ok(())
}

/// Upload `file_path` with progress (simple HTTP `PUT`).
pub async fn upload(
    client: &Client,
    url: &str,
    file_path: impl AsRef<Path>,
    progress: Option<Box<dyn FnMut(ProgressPayload) + Send + 'static>>,
    headers: Option<HeaderMap>,
) -> anyhow::Result<String> {
    const BUF: usize = 64 * 1024;

    let file = tokio::fs::File::open(&file_path).await?;
    let total = file.metadata().await?.len();

    let start = Instant::now();

    // unfold state = (file-handle, bytes-sent, progress-callback)
    let stream = stream::unfold(
        (file, 0u64, progress),
        move |(mut f, mut sent, mut prog)| async move {
            let mut buf = vec![0u8; BUF];
            match f.read(&mut buf).await {
                Ok(0) => None, // EOF
                Ok(n) => {
                    buf.truncate(n);
                    sent += n as u64;

                    if let Some(ref mut cb) = prog {
                        let elapsed = start.elapsed().max(Duration::from_micros(1));
                        cb(ProgressPayload {
                            progress: n as u64,
                            progress_total: sent,
                            total,
                            transfer_speed: sent as f64 / elapsed.as_secs_f64(),
                        });
                    }

                    // Pass the state (including `prog`) to the next iteration
                    Some((Ok(Bytes::from(buf)), (f, sent, prog)))
                }
                Err(e) => Some((Err(e), (f, sent, prog))),
            }
        },
    );

    let mut req = client.put(url).body(Body::wrap_stream(stream));
    if let Some(h) = headers {
        req = req.headers(h);
    }

    let resp = req.send().await?.error_for_status()?;
    Ok(resp.text().await?)
}
