use std::{collections::HashMap, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};

pub struct Names {
    pub outgoing: mpsc::Sender<Value>,
    replies: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cache: Mutex<HashMap<(i64, String), (String, Instant)>>,
    limit: Semaphore,
    seq: AtomicU64,
}
impl Names {
    pub fn new(outgoing:mpsc::Sender<Value>)->Arc<Self>{Arc::new(Self{outgoing,replies:Mutex::new(HashMap::new()),cache:Mutex::new(HashMap::new()),limit:Semaphore::new(4),seq:AtomicU64::new(1)})}
    pub async fn reply(&self,event:&Value){
        if let Some(echo)=event["echo"].as_str(){if let Some(tx)=self.replies.lock().await.remove(echo){let _=tx.send(event.clone());}}
    }
    pub async fn remember(&self,group:i64,id:String,name:String){
        if id.is_empty()||name.trim().is_empty(){return;}
        let mut cache=self.cache.lock().await;
        cache.retain(|_,(_,at)|at.elapsed()<Duration::from_secs(600));
        if cache.len()>=2048 {if let Some(key)=cache.iter().min_by_key(|(_,(_,at))|*at).map(|(k,_)|k.clone()){cache.remove(&key);}}
        cache.insert((group,id),(name.chars().take(80).collect(),Instant::now()));
    }
    pub async fn resolve(&self,group:i64,id:&str)->Option<String>{
        if id=="all"{return Some("全体成员".into());}
        if let Some((name,at))=self.cache.lock().await.get(&(group,id.into())){if at.elapsed()<Duration::from_secs(600){return (!name.is_empty()).then(||name.clone());}}
        let Ok(user)=id.parse::<u64>() else{return None;};
        let Ok(_permit)=self.limit.try_acquire() else{return None;};
        let echo=format!("wander-name-{}",self.seq.fetch_add(1,Ordering::Relaxed));
        let (tx,rx)=oneshot::channel();self.replies.lock().await.insert(echo.clone(),tx);
        let request=json!({"action":"get_group_member_info","params":{"group_id":group,"user_id":user,"no_cache":false},"echo":echo});
        if self.outgoing.try_send(request).is_err(){self.replies.lock().await.remove(&echo);return None;}
        let response=tokio::time::timeout(Duration::from_millis(650),rx).await;
        self.replies.lock().await.remove(&echo);
        let name=match response{Ok(Ok(value))=>value["data"]["card"].as_str().filter(|s|!s.trim().is_empty()).or_else(||value["data"]["nickname"].as_str()).map(str::to_owned),_=>None};
        if let Some(ref name)=name{self.remember(group,id.into(),name.clone()).await;}else{
            // Negative cache avoids repeated queries for unavailable users.
            let mut cache=self.cache.lock().await;if cache.len()<2048{cache.insert((group,id.into()),(String::new(),Instant::now()));}
        }
        name
    }
}
pub fn user_id(value:&Value)->String{value.as_str().map(str::to_owned).or_else(||value.as_u64().map(|v|v.to_string())).unwrap_or_default()}
