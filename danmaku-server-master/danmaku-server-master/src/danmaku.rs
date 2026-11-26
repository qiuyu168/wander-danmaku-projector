use std::fmt::Display;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use futures::StreamExt;
use futures_util::SinkExt;
use poem::web::websocket::{Message, WebSocket};
use poem::web::{Data, Path, RemoteAddr};
use poem::{handler, IntoResponse};
use ring_channel::RingSender;
use serde::{Deserialize, Serialize};
use smol_str::SmolStr;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use crate::config::Config;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Danmaku {
    pub text: Arc<str>,
    pub color: Option<Arc<str>>,
    pub size: Option<f64>,
    pub sender: Option<Arc<str>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Trace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<serde_json::Value>>,
}

impl Danmaku {
    pub fn filter_text(&self) -> String {
        match &self.segments {
            Some(segments) => segments.iter().filter(|s|s["type"]=="text").filter_map(|s|s["text"].as_str()).collect::<Vec<_>>().join(""),
            None => self.text.to_string(),
        }
    }
    pub fn has_media(&self) -> bool { self.segments.as_ref().is_some_and(|s|s.iter().any(|v|v["type"]=="image"||v["type"]=="face")) }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub id: String,
    pub server_received_at_ms: u64,
    pub server_processing_ms: f64,
    pub source_timestamp_sec: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DanmakuPacket {
    pub group: SmolStr,
    pub danmaku: Danmaku,
    #[serde(skip)]
    pub received_at: Option<Instant>,
}

impl DanmakuPacket {
    pub fn stamp(&mut self, source: Option<i64>, message_id: Option<String>) {
        self.received_at=Some(Instant::now());
        let at=crate::status::epoch_ms();
        self.danmaku.trace=Some(Trace { id:message_id.unwrap_or_else(||format!("{}-{}",at,crate::status::next_id())), server_received_at_ms:at, server_processing_ms:0.0, source_timestamp_sec:source });
    }
}

impl Display for Danmaku {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(sender) = &self.sender {
            write!(f, "{}: ", sender)?;
        }
        write!(f, "{}", self.text)?;
        if self.color.is_some() || self.size.is_some() {
            write!(f, " [")?;
            if let Some(color) = &self.color {
                write!(f, "color={};", color)?;
            }
            if let Some(size) = self.size {
                write!(f, "size={};", size)?;
            }
            write!(f, "]")?;
        }
        Ok(())
    }
}

#[handler]
#[tracing::instrument(skip(ws))]
pub async fn client(
    ws: WebSocket,
    RemoteAddr(peer): &RemoteAddr,
    Path(group): Path<SmolStr>,
    Data(source): Data<&Arc<broadcast::Receiver<DanmakuPacket>>>,
) -> impl IntoResponse {
    let peer = peer.clone();
    tracing::info!("connection from {} to group {}", peer, &group);

    let mut source = source.resubscribe();
    ws.on_upgrade(move |mut socket| async move {
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                // From upstream
                packet = source.recv() => {
                    match packet {
                        Ok(packet) => {
                            if packet.group != group { continue; }
                            if let Ok(danmaku) = serde_json::to_string(&packet.danmaku) {
                                if !matches!(tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Text(danmaku))).await, Ok(Ok(()))) { break; }
                                tracing::debug!("{} -> {}", packet.group, packet.danmaku);
                            }
                        }
                        Err(RecvError::Lagged(n)) => { for _ in 0..n.min(1024) { crate::status::count("lagged"); } continue },
                        Err(_) => break,
                    }
                }

                // From client
                incoming = socket.next() => {
                    let Some(Ok(msg)) = incoming else { break; };
                    tracing::debug!("got message: {:?}", msg);
                    match msg {
                        Message::Ping(payload) => {
                            let _ = socket.send(Message::Pong(payload)).await;
                            tracing::debug!("pong");
                        }
                        Message::Close(close) => {
                            tracing::info!("connection from {} closed: {:?}", peer, close);
                            break;
                        }
                        _ => {}
                    }
                }

                // Ping
                _ = ping.tick() => {
                    let _ = socket.send(Message::Ping(vec![])).await;
                    tracing::debug!("ping");
                }

                // On error
                else => { break }
            }
        }
        if let Err(e) = socket.close().await {
            tracing::error!("failed to close connection: {}", e);
        }
    })
}

#[handler]
#[tracing::instrument(skip(ws, sink))]
pub async fn upstream(
    ws: WebSocket,
    RemoteAddr(peer): &RemoteAddr,
    Data(sink): Data<&RingSender<DanmakuPacket>>,
) -> impl IntoResponse {
    let peer = peer.clone();
    tracing::info!("connection from {}", peer);

    let sink = sink.clone();

    let config = Config::load();
    ws.on_upgrade(move |mut socket| async move {
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                // From client
                incoming = socket.next() => {
                    let Some(Ok(msg)) = incoming else { break; };
                    tracing::debug!("got message: {:?}", msg);
                    match msg {
                        Message::Text(msg) => {
                            if let Ok(mut packet) = serde_json::from_str::<DanmakuPacket>(&msg) {
                                if packet.danmaku.filter_text().chars().count() > config.max_length { crate::status::count("length"); continue; }
                                if let Some(segments)=&packet.danmaku.segments {if segments.len()>16 {continue;}}
                                packet.stamp(None,None);
                                sink.send(packet).expect("all middleware tasks are gone");
                            }
                        }
                        Message::Ping(payload) => {
                            let _ = socket.send(Message::Pong(payload)).await;
                            tracing::debug!("pong");
                        }
                        Message::Close(close) => {
                            tracing::info!("connection from {} closed: {:?}", peer, close);
                            break;
                        }
                        _ => {}
                    }
                }

                // Ping
                _ = ping.tick() => {
                    let _ = socket.send(Message::Ping(vec![])).await;
                    tracing::debug!("ping");
                }

                // On error
                else => { break }
            }
        }
        if let Err(e) = socket.close().await {
            tracing::error!("failed to close connection: {}", e);
        }
    })
}
