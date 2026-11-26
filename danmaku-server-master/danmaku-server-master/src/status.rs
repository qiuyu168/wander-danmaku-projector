use std::{collections::HashMap, sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock}, time::{Instant, SystemTime, UNIX_EPOCH}};
use poem::{handler, web::Json};
use serde_json::{json, Value};

pub fn epoch_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
pub fn next_id() -> u64 { static SEQ: AtomicU64 = AtomicU64::new(1); SEQ.fetch_add(1, Ordering::Relaxed) }
struct Connection { account: String, online: Option<bool>, seen: Instant }
#[derive(Default)]
struct State { connections: HashMap<u64, Connection>, received: u64, published: u64, empty: u64, length: u64, blacklist: u64, duplicate: u64, lagged: u64, processing: Vec<f64> }
fn state() -> &'static Mutex<State> { static STATE: OnceLock<Mutex<State>> = OnceLock::new(); STATE.get_or_init(||Mutex::new(State::default())) }
pub struct ConnectionGuard(pub u64);
impl ConnectionGuard {
    pub fn new() -> Self { let id=next_id(); state().lock().unwrap().connections.insert(id,Connection { account:String::new(), online:None, seen:Instant::now() }); Self(id) }
    pub fn update(&self, event: &Value) {
        let mut state=state().lock().unwrap();
        if let Some(c)=state.connections.get_mut(&self.0) {
            c.seen=Instant::now();
            if let Some(id)=event.get("self_id").and_then(Value::as_i64) { c.account=id.to_string(); }
            if matches!(event.get("post_type").and_then(Value::as_str),Some("message"|"message_sent")) { c.online=Some(true); }
            if let Some(online)=event.pointer("/status/online").and_then(Value::as_bool) { c.online=Some(online); }
        }
    }
}
impl Drop for ConnectionGuard { fn drop(&mut self) { state().lock().unwrap().connections.remove(&self.0); } }
pub fn count(kind: &str) { let mut s=state().lock().unwrap(); match kind { "received"=>s.received+=1,"empty"=>s.empty+=1,"length"=>s.length+=1,"blacklist"=>s.blacklist+=1,"duplicate"=>s.duplicate+=1,"lagged"=>s.lagged+=1,_=>{} } }
pub fn published(ms:f64) {let mut s=state().lock().unwrap();s.published+=1;if s.processing.len()>=1000{s.processing.remove(0);}s.processing.push(ms);}
#[handler]
pub fn health() -> Json<Value> { Json(json!({"ok":true,"protocolVersion":1})) }
#[handler]
pub fn status() -> Json<Value> {
    let s=state().lock().unwrap(); let active:Vec<_>=s.connections.values().filter(|c|c.seen.elapsed().as_secs()<90).collect();
    let online=if active.iter().any(|c|c.online==Some(true)){Some(true)}else if active.iter().any(|c|c.online==Some(false)){Some(false)}else{None};
    let mut values=s.processing.clone();values.sort_by(f64::total_cmp);
    let p95=if values.is_empty(){None}else{Some(values[((values.len() as f64*0.95).ceil() as usize-1).min(values.len()-1)])};
    Json(json!({"protocolVersion":1,"onebotConnected":!active.is_empty(),"qqOnline":online,"account":active.first().map(|c|c.account.as_str()).unwrap_or(""),"received":s.received,"published":s.published,"drops":{"empty":s.empty,"length":s.length,"blacklist":s.blacklist,"duplicate":s.duplicate,"subscriberLagged":s.lagged},"processingP95Ms":p95,"processingSamples":values.len()}))
}
