
use eyre::Result;
use futures_util::{StreamExt, SinkExt, stream::FuturesUnordered, future::BoxFuture, FutureExt};
use poem::web::websocket::{Message as WebSocketMessage, WebSocket};
use poem::web::{Data, RemoteAddr};
use poem::{handler, IntoResponse};
use ring_channel::RingSender;
use smol_str::ToSmolStr;

use crate::config::Config;
use crate::danmaku::{Danmaku, DanmakuPacket};
use crate::onebot::cqcode::cq_to_text;

mod cqcode;
mod names;

#[handler]
#[tracing::instrument(skip_all)]
pub async fn onebot(
    ws: WebSocket,
    peer: &RemoteAddr,
    Data(sink): Data<&RingSender<DanmakuPacket>>,
) -> impl IntoResponse {
    tracing::info!("connection from {}", peer);
    let sink = sink.clone();
    let config = Config::load();
    ws.on_upgrade(|socket| async move {
        let connection=crate::status::ConnectionGuard::new();
        let (mut writer,mut reader)=socket.split();
        let (tx,mut rx)=tokio::sync::mpsc::channel::<serde_json::Value>(32);
        let names=names::Names::new(tx);
        let mut tasks:FuturesUnordered<BoxFuture<'_,Result<Option<DanmakuPacket>>>>=FuturesUnordered::new();
        let config=&config;
        let mut heartbeat=tokio::time::interval(std::time::Duration::from_secs(30));
        let mut last_seen=std::time::Instant::now();
        loop {
            tokio::select! {
                _=heartbeat.tick()=>{if last_seen.elapsed().as_secs()>90{tracing::warn!("OneBot heartbeat missing; closing transport for reconnect without restarting QQ");break;}}
                outgoing=rx.recv()=>{if let Some(value)=outgoing{if writer.send(WebSocketMessage::Text(value.to_string())).await.is_err(){break;}}}
                packet=tasks.next(),if !tasks.is_empty()=>{match packet{Some(Ok(Some(packet)))=>{if sink.send(packet).is_err(){break;}},Some(Err(e))=>tracing::warn!("message parse failed: {}",e),_=>{}}}
                message=reader.next()=>{
                    let Some(Ok(message))=message else{break;};
                    last_seen=std::time::Instant::now();
                    if let WebSocketMessage::Text(message)=message{
                        if let Ok(event)=serde_json::from_str::<serde_json::Value>(&message){
                            connection.update(&event);
                            if event.get("echo").is_some(){names.reply(&event).await;continue;}
                            if !matches!(event["post_type"].as_str(),Some("message"|"message_sent")){continue;}
                        }
                        // Name lookups must not block heartbeats, API replies or other messages.
                        if tasks.len()<64{let names=names.clone();tasks.push(async move{handle_message_event(message,config,&names).await}.boxed());}
                    }
                }
            }
        }
    })
}

#[tracing::instrument(skip_all)]
async fn handle_message_event(message: String, config: &Config, names:&names::Names) -> Result<Option<DanmakuPacket>> {
    let received_at=std::time::Instant::now();
    let event: serde_json::Value=serde_json::from_str(&message)?;
    if event["post_type"]!="message"&&event["post_type"]!="message_sent" {return Ok(None);}
    let Some(group)=event["group_id"].as_i64() else {return Ok(None)};
    let sender_name=event["sender"]["card"].as_str().filter(|s|!s.is_empty()).or_else(||event["sender"]["nickname"].as_str());
    if let Some(name)=sender_name{names.remember(group,names::user_id(&event["user_id"]),name.into()).await;}
    let mut segments=Vec::new();
    if let Some(text)=event["message"].as_str() {
        // Legacy CQ text remains readable; segment arrays are required for media.
        let text=cq_to_text(text).iter().map(|s|s.as_ref()).collect::<Vec<_>>().join("");
        segments.push(serde_json::json!({"type":"text","text":text}));
    } else if let Some(items)=event["message"].as_array() {
        if items.len()>16 {crate::status::count("length");return Ok(None);}
        for item in items {
            let data=&item["data"];
            match item["type"].as_str().unwrap_or("") {
                "text" => { if let Some(text)=data["text"].as_str() {segments.push(serde_json::json!({"type":"text","text":text}));} }
                "at" => {
                    let id=names::user_id(&data["qq"]);
                    let name=if let Some(name)=data["name"].as_str().filter(|s|!s.trim().is_empty()){Some(name.to_owned())}else if received_at.elapsed().as_millis()<650{names.resolve(group,&id).await}else{None};
                    let text=format!("@{}",name.as_deref().unwrap_or("群成员"));
                    segments.push(serde_json::json!({"type":"text","text":text}));
                }
                "image" | "mface" => {
                    let emoji=data["emoji_id"].as_str().filter(|s|s.len()>=2&&s.len()<=128&&s.bytes().all(|c|c.is_ascii_hexdigit()));
                    let market_url=emoji.map(|id|format!("https://gxh.vip.qq.com/club/item/parcel/item/{}/{}/raw300.gif",&id[..2],id));
                    let url=data["url"].as_str().filter(|s|!s.is_empty()).or_else(||data["file"].as_str().filter(|s|s.starts_with("https://"))).or(market_url.as_deref()).unwrap_or("");
                    if url.len()>4096 {continue;}
                    if !url.is_empty() {
                        // QQ file identifiers survive signed URL refreshes. If absent,
                        // use the complete URL: missed merging is safer than false merging.
                        let id=data["file"].as_str().filter(|s|!s.is_empty()&&!s.contains("://")).unwrap_or(url);
                        segments.push(serde_json::json!({"type":"image","mediaId":id,"url":url,"alt":"[图片]"}));
                    } else {segments.push(serde_json::json!({"type":"text","text":"[图片未提供下载地址]"}));}
                }
                "face" => {
                    let id=data["id"].as_str().map(str::to_owned).or_else(||data["id"].as_i64().map(|n|n.to_string())).unwrap_or_default();
                    segments.push(serde_json::json!({"type":"face","faceId":id,"alt":"[QQ 表情]"}));
                }
                _ => {}
            }
        }
    }
    let plain=segments.iter().filter(|s|s["type"]=="text").filter_map(|s|s["text"].as_str()).collect::<Vec<_>>().join("");
    if plain.chars().count()>config.max_length {crate::status::count("length");return Ok(None);}
    if segments.iter().filter(|s|s["type"]=="image").count()>3 {crate::status::count("length");return Ok(None);}
    let media=segments.iter().any(|s|s["type"]=="image"||s["type"]=="face");
    let summary=segments.iter().map(|s|s["text"].as_str().unwrap_or(if s["type"]=="face" {"[QQ 表情]"} else {"[图片]"})).collect::<Vec<_>>().join("");
    let sender=event["sender"]["card"].as_str().filter(|s|!s.is_empty()).or_else(||event["sender"]["nickname"].as_str()).map(Into::into);
    let danmaku=Danmaku {text:summary.trim().into(),color:None,size:None,sender,trace:None,segments:if media {Some(segments)} else {None}};
    let mut packet=DanmakuPacket {group:group.to_smolstr(),danmaku,received_at:None};
    let source=event["time"].as_i64().filter(|n|*n>0);
    let id=event["message_id"].as_i64().map(|n|format!("{}-{}",event["self_id"].as_i64().unwrap_or(0),n));
    packet.stamp(source,id);packet.received_at=Some(received_at);Ok(Some(packet))
}
