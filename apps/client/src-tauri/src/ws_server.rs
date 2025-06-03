// Start a websocket server, connect messages to tauri frontend for the business logic.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message};

type Tx = mpsc::Sender<Message>;
type Rx = mpsc::Receiver<Message>;

#[derive(Default)]
pub struct ConnMap(tokio::sync::Mutex<HashMap<u32, Tx>>);

#[derive(Clone, Serialize)]
pub struct WsEvent {
    pub conn_id: u32,
    pub data: String,
}

#[tauri::command]
pub async fn api_reply(app: AppHandle, conn_id: u32, data: String) -> Result<(), String> {
    let map = app.state::<ConnMap>();
    let guard = map.0.lock().await;
    guard
        .get(&conn_id)
        .ok_or("unknown connection")?
        .send(Message::Text(data.into()))
        .await
        .map_err(|e| e.to_string())
}

pub fn start<R: Runtime + 'static>(app: &AppHandle<R>, addr: &str) {
    let listener_addr = addr.to_owned();
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let listener = TcpListener::bind(&listener_addr)
            .await
            .expect("cannot bind");

        let mut next_id = 1u32;
        while let Ok((stream, _)) = listener.accept().await {
            let id = next_id;
            next_id += 1;
            let app = app_handle.clone();

            tauri::async_runtime::spawn(async move {
                let ws = accept_async(stream).await.expect("ws accept");
                let (mut to_peer, mut from_peer) = ws.split();

                let (tx_front, mut rx_front): (Tx, Rx) = mpsc::channel(32);
                app.state::<ConnMap>().0.lock().await.insert(id, tx_front);
                let _ = app.emit("api_conn_open", id);

                loop {
                    tokio::select! {
                        Some(frame) = from_peer.next() => {
                            match frame {
                                Ok(Message::Text(txt_bytes)) => {
                                    let txt = txt_bytes.to_string();
                                    let _ = app.emit("api_request", WsEvent { conn_id: id, data: txt });
                                }
                                Ok(_) => {} // ignore non-text frames
                                Err(_) => break,
                            }
                        }
                        Some(outgoing) = rx_front.recv() => {
                            if to_peer.send(outgoing).await.is_err() {
                                break;
                            }
                        }
                        else => break,
                    }
                }

                app.state::<ConnMap>().0.lock().await.remove(&id);
                let _ = app.emit("api_conn_close", id);
            });
        }
    });
}
