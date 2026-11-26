import type { Settings } from '../shared/settings';
import type { Packet,Segment,MediaResult } from '../shared/api';
import { percentile } from '../shared/queue';
import { Aggregates,RepeatWindow,contentKey,crossed } from '../shared/aggregation';
import { keywordFilter } from '../shared/moderation';

type Part={text:string}|{media:MediaResult};
type Entity={key:string;at:number;readyAt:number;count:number;lastCount:number;packet:Packet;test:boolean;alive:boolean;ready:boolean;parts:Part[];el?:HTMLSpanElement;badge?:HTMLSpanElement;x:number;y:number;width:number;height:number;speed:number;painted:boolean;effectUntil:number;animated:number;triggered:Set<number>};
let settings:Settings,visible=false,paused=false,socket:WebSocket|null=null,generation=0,retry=0,connection='未连接';
let retryTimer:ReturnType<typeof setTimeout>,raf=0,lastFrame=0,serial=0;
let obstacle:{x:number;y:number;width:number;height:number}|undefined;
const stage=document.getElementById('stage')!,aggregates=new Aggregates<Entity>(),repeats=new RepeatWindow();
let active:Entity[]=[],pending:Entity[]=[];
let blocked=0,isBlocked=keywordFilter([]);
const waits:number[]=[],frames:number[]=[],backend:number[]=[],arrivals:number[]=[];
let received=0,shown=0,represented=0,merged=0,retried=0,created=0,ignored=0,stale=0,invalid=0,expired=0,overflow=0,droppedMessages=0,mediaFailed=0,mediaReady=0,effects=0,effectDegraded=0,lastMessageAt:number|null=null;
const sample=(a:number[],n:number)=>{a.push(n);if(a.length>2000)a.shift();};
function retire(e:Entity){e.alive=false;e.el?.querySelectorAll('img').forEach(img=>img.removeAttribute('src'));e.el?.remove();aggregates.remove(e);}
function clear(){for(const e of [...active,...pending])retire(e);active=[];pending=[];aggregates.clear();repeats.clear();stage.querySelector('.identify')?.remove();}
function wake(){if(!raf){lastFrame=performance.now();raf=requestAnimationFrame(frame);}}
function lose(e:Entity,reason:'expired'|'overflow'){retire(e);if(!e.test){if(reason==='expired')expired++;else overflow++;droppedMessages+=e.count;}}
function expire(now:number){pending=pending.filter(e=>{if(e.ready&&now-e.readyAt>=500){lose(e,'expired');return false;}return e.alive;});}
function canEnter(y:number,h:number,speed:number){
  if(obstacle&&y<obstacle.y+obstacle.height&&y+h>obstacle.y)return false;
  return active.filter(a=>a.y<y+h&&a.y+a.height>y).every(a=>{const right=a.x+a.width,gap=innerWidth-2-right;return gap>=24&&(speed<=a.speed||gap/(speed-a.speed)>right/a.speed);});
}
function emit(e:Entity){
  const s=settings.style,line=Math.ceil(s.fontSize*1.2),h=line*(e.parts.some(p=>'media'in p)?2:1),speed=s.speed;
  let y=-1;for(let row=0;row+h<=innerHeight;row+=line)if(canEnter(row,h,speed)){y=row;break;}
  if(y<0||active.length>=200)return false;
  const el=document.createElement('span');el.className='danmaku';
  const content=document.createElement('span');content.className='content';
  let animated=active.reduce((n,a)=>n+a.animated,0);e.animated=0;
  for(const part of e.parts){
    if('text'in part){const text=document.createElement('span');text.className='message-text';text.textContent=part.text;content.append(text);}
    else {
      const image=document.createElement('img'),m=part.media,play=m.animated&&settings.media.animated&&animated<settings.media.maxAnimatedOnScreen;
      image.src=play?m.data:m.still;image.alt='表情图片';
      image.style.height=`${Math.min(h-4,Math.max(line,m.height))}px`;image.style.maxWidth=`${Math.min(280,innerWidth/3)}px`;
      image.style.width=`${Math.min(Math.min(280,innerWidth/3),(h-4)*m.width/m.height)}px`;image.style.objectFit='contain';
      content.append(image);if(play){animated++;e.animated++;}
    }
  }
  el.append(content);
  const badge=document.createElement('span');badge.className='count';el.append(badge);e.badge=badge;
  badge.style.width=e.count>1?'4.3em':'0';
  Object.assign(el.style,{height:`${h}px`,fontFamily:s.fontFamily,fontSize:`${s.fontSize}px`,color:s.colorMode==='palette'?s.palette[Math.floor(Math.random()*s.palette.length)]:s.color,opacity:String(s.textOpacity),textShadow:s.shadowEnabled?'0 1px 3px #000,1px 0 1px #000,-1px 0 1px #000':'none',transform:`translate(${innerWidth-2}px,${y}px)`});
  stage.append(el);Object.assign(e,{el,x:innerWidth-2,y,height:h,width:el.getBoundingClientRect().width,speed});active.push(e);
  if(!e.test&&typeof e.packet.trace?.serverProcessingMs==='number')sample(backend,e.packet.trace.serverProcessingMs);
  return true;
}
function update(e:Entity,now:number){
  if(e.lastCount===e.count)return;
  e.badge!.textContent=e.count>1?`×${e.count>9999?'9999+':e.count}`:'';
  const level=crossed(e.lastCount,e.count,settings.aggregation.milestones.filter(n=>!e.triggered.has(n)));e.lastCount=e.count;
  if(!level||!settings.aggregation.effectsEnabled)return;
  for(const n of settings.aggregation.milestones)if(n<=e.count)e.triggered.add(n);
  const reduced=settings.aggregation.reducedMotion||matchMedia('(prefers-reduced-motion: reduce)').matches,busy=active.filter(a=>a.effectUntil>now).length>=2;
  e.el!.classList.add('milestone');
  if(!reduced&&!busy){e.effectUntil=now+(level>=100?1800:1200);e.el!.classList.add(level>=100?'effect100':'effect66');if(!e.test)effects++;}
  else if(!e.test)effectDegraded++;
}
function frame(now:number){
  raf=0;const delta=now-lastFrame;lastFrame=now;if(delta>0&&delta<2000)sample(frames,delta);
  if(!visible){clear();return;}
  for(const e of active){
    e.x-=e.speed*delta/1000;e.el!.style.transform=`translate(${e.x}px,${e.y}px)`;update(e,now);
    if(e.effectUntil&&now>=e.effectUntil){e.el!.classList.remove('effect66','effect100');e.effectUntil=0;}
    if(!e.painted&&e.x<innerWidth){e.painted=true;if(!e.test){shown++;represented+=e.count;sample(waits,performance.now()-e.at);}}
  }
  active=active.filter(e=>{if(e.x+e.width<0){retire(e);return false;}return true;});expire(now);
  pending=pending.filter(e=>!(e.ready&&emit(e)));
  if(active.length||pending.some(e=>e.ready))raf=requestAnimationFrame(frame);
}
function valid(packet:Packet){
  if(!packet||typeof packet.text!=='string'||packet.text.length>1000)return false;
  if(packet.segments!==undefined){
    if(!Array.isArray(packet.segments)||packet.segments.length>16||packet.segments.filter(s=>s?.type==='image').length>3)return false;
    if(!packet.segments.every(s=>s&&(s.type==='text'?typeof s.text==='string'&&s.text.length<=1000:s.type==='image'?typeof s.url==='string'&&s.url.length<=4096&&typeof s.mediaId==='string'&&s.mediaId.length<=4096:s.type==='face'&&typeof s.faceId==='string'&&/^\d{1,4}$/.test(s.faceId))))return false;
  }
  return !!packet.text.trim()||!!packet.segments?.some(s=>s.type!=='text');
}
function accept(packet:Packet,test=false,count=1,localMedia?:MediaResult){
  if(!valid(packet)){invalid++;return;}
  const now=performance.now();if(!test){received++;lastMessageAt=Date.now();arrivals.push(now);if(arrivals.length>2000)arrivals.shift();}
  if(!test&&isBlocked(packet)){blocked++;return;}
  if(!visible||paused){if(!test)ignored++;return;}
  if(!test&&packet.trace?.sourceTimestampSec&&Date.now()/1000-packet.trace.sourceTimestampSec>15){stale++;return;}
  if(!test&&aggregates.duplicate(packet.trace?.id,now)){retried++;return;}
  expire(now);
  const key=test?`test-${serial++}`:contentKey(packet);
  const repetition=!test?repeats.count(key,now,settings.aggregation.windowMs):1;
  const congested=pending.length>0||active.length>=Math.max(2,Math.floor(innerHeight/(settings.style.fontSize*1.2))*.6);
  const previous=settings.aggregation.enabled&&!test&&repetition>=settings.aggregation.startCount&&congested?aggregates.find(key,now,settings.aggregation.windowMs):undefined;
  if(previous?.alive&&(!previous.el||previous.count>1||!active.some(a=>a!==previous&&a.y<previous.y+previous.height&&a.y+a.height>previous.y&&a.x>previous.x&&a.x<previous.x+previous.width+settings.style.fontSize*3.3+24))){if(previous.el&&previous.count===1){previous.badge!.style.width='4.3em';previous.width=previous.el.getBoundingClientRect().width;}previous.count=Math.min(Number.MAX_SAFE_INTEGER,previous.count+1);merged++;if(previous.painted)represented++;wake();return;}
  const e:Entity={key,at:now,readyAt:now,count,lastCount:0,packet,test,alive:true,ready:false,parts:[],x:0,y:0,width:0,height:0,speed:0,painted:false,effectUntil:0,animated:0,triggered:new Set()};
  if(!test)created++;aggregates.add(e);
  if(pending.length>=50)lose(pending.shift()!,'overflow');pending.push(e);
  const segments:Segment[]=packet.segments?.length?packet.segments:[{type:'text',text:packet.text}];
  const ready=(parts:Part[])=>{if(!e.alive)return;e.parts=parts;e.ready=true;e.readyAt=performance.now();if(emit(e))pending=pending.filter(v=>v!==e);wake();};
  if(!segments.some(s=>s.type!=='text')){ready([{text:packet.text}]);return;}
  const gen=generation;let settled=false;const resolved=new Map<number,Part>();
  const fallback=()=>segments.map((s,i)=>resolved.get(i)||({text:s.type==='text'?s.text:s.type==='face'?'[QQ 表情]':'[图片未加载]'}));
  const timer=setTimeout(()=>{if(!settled){settled=true;if(e.alive&&gen===generation){if(!test)mediaFailed++;ready(fallback());}}},6000);
  Promise.all(segments.map(async(s,i):Promise<Part>=>{
    if(s.type==='text')return {text:s.text};
    if(!settings.media.enabled)return {text:s.type==='face'?'[QQ 表情]':'[图片]'};
    try{const media=localMedia||await window.desktop.media(s);if(!test&&e.alive&&!settled)mediaReady++;const part={media};resolved.set(i,part);return part;}
    catch{if(!test&&e.alive&&!settled)mediaFailed++;return {text:s.type==='face'?'[QQ 表情]':'[图片未加载]'};}
  })).then(parts=>{clearTimeout(timer);if(settled)return;settled=true;if(e.alive&&gen===generation)ready(parts);});
}
function connect(group:string){
  generation++;const gen=generation;clearTimeout(retryTimer);socket?.close();socket=null;clear();retry=0;
  received=shown=represented=merged=retried=created=ignored=stale=invalid=expired=overflow=droppedMessages=mediaFailed=mediaReady=effects=effectDegraded=0;waits.length=backend.length=frames.length=arrivals.length=0;lastMessageAt=null;
  blocked=0;
  if(!group){connection='未设置群号';return;}
  const open=()=>{
    if(gen!==generation)return;connection='连接中';const ws=new WebSocket(`ws://localhost:5098/danmaku/${encodeURIComponent(group)}`);socket=ws;
    ws.onopen=()=>{if(gen!==generation){ws.close();return;}retry=0;clear();connection='已连接';};
    ws.onmessage=event=>{if(gen!==generation||ws!==socket)return;try{accept(JSON.parse(event.data));}catch{invalid++;}};
    ws.onclose=()=>{if(gen!==generation||ws!==socket)return;clear();connection='已断开';retryTimer=setTimeout(open,Math.min(10000,500*2**Math.min(retry++,5)));};ws.onerror=()=>ws.close();
  };open();
}
function configure(next:Settings){
  const group=settings?.source.groupId,layout=settings?.display.topRatio,agg=JSON.stringify(settings?.aggregation),media=JSON.stringify(settings?.media);
  settings=next;isBlocked=keywordFilter(next.moderation.keywords);
  if(group!==next.source.groupId)connect(next.source.groupId);
  else if(layout!==next.display.topRatio||agg!==JSON.stringify(next.aggregation)||media!==JSON.stringify(next.media))clear();
  else {
    // Remove matching visible and preparing entities immediately after applying a ban.
    const keep=(e:Entity)=>{if(!e.test&&isBlocked(e.packet)){retire(e);return false;}return true;};
    active=active.filter(keep);pending=pending.filter(keep);
  }
}
window.desktop.onOverlay(event=>{
  if(event.settings)configure(event.settings);visible=event.visible??visible;paused=event.paused??paused;
  const before=JSON.stringify(obstacle);obstacle=event.cardRect;if(before!==JSON.stringify(obstacle))clear();
  if(event.type==='clear'||!visible&&event.type!=='identify')clear();
  if(event.type==='pause'){for(const e of pending)retire(e);pending=[];}
  if(event.type==='test'&&event.packet)accept(event.packet,true,event.count||1,event.media);
  if(event.type==='identify'){clear();const label=document.createElement('div');label.className='identify';label.textContent=event.label||'投影区域';stage.append(label);}
});
window.addEventListener('resize',clear);
window.desktop.snapshot().then(s=>{configure(s.settings);visible=s.visible;paused=s.paused;});
setInterval(()=>{
  const now=performance.now();while(arrivals.length&&now-arrivals[0]>5000)arrivals.shift();
  window.desktop.metrics({connection,received,blocked,shown,represented,merged,retried,created,ignored,stale,invalid,lastMessageAt,receivedRate5s:Math.round(arrivals.length/5*100)/100,queue:pending.length,preparing:pending.filter(e=>!e.ready).length,active:active.length,expired,overflow,droppedMessages,mediaFailed,mediaReady,effects,effectDegraded,waitSamples:waits.length,waitP50:percentile(waits,.5),waitP95:percentile(waits,.95),waitP99:percentile(waits,.99),waitMax:waits.length?Math.max(...waits):null,backendP95:percentile(backend,.95),frameP95:percentile(frames,.95),frameP99:percentile(frames,.99),boundary:'接收 WS → rAF 软件可见近似；图片含最多 6 秒准备；不是 HDMI 实测'});
},1000);
window.addEventListener('beforeunload',()=>{generation++;clearTimeout(retryTimer);socket?.close();cancelAnimationFrame(raf);clear();});
