// Run inside the Compose network using Node 24+. Does not send anything to QQ.
import assert from 'node:assert/strict';
const host=process.env.DANMAKU_TEST_HOST||'danmaku-server';
const group=`protocol-check-${Date.now()}`, sockets=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(route,port){
  const ws=new WebSocket(`ws://${host}:${port}${route}`);sockets.push(ws);
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('WS timeout')),8000);ws.onopen=()=>{clearTimeout(t);resolve();};ws.onerror=()=>{clearTimeout(t);reject(Error('WS failed'));};});return ws;
}
async function until(check){const end=Date.now()+5000;while(!check()&&Date.now()<end)await sleep(20);assert.ok(check(),'message deadline');}
try {
  assert.equal((await fetch(`http://${host}:5098/health`)).status,200);
  const publicStatus=await fetch(`http://${host}:5098/status`);
  assert.match(publicStatus.headers.get('content-type')||'',/text\/html/,'public /:group fallback must not expose private JSON status');
  for(const route of [`/${group}`,`/client/${group}`]){
    const response=await fetch(`http://${host}:5098${route}`);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,/<script/);
    for(const m of html.matchAll(/(?:src|href)=["']?([^\s"'>]+\.(?:js|css)(?:\?[^\s"'>]*)?)/g)){
      const asset=await fetch(new URL(m[1],`http://${host}:5098${route}`));assert.equal(asset.status,200);assert.match(asset.headers.get('content-type')||'',/javascript|css/);
    }
  }
  const received=[],wrong=[];
  (await connect(`/danmaku/${group}`,5098)).onmessage=e=>received.push(JSON.parse(e.data));
  (await connect(`/danmaku/${group}-other`,5098)).onmessage=e=>wrong.push(e.data);
  const up=await connect('/danmaku',5099);
  const original={text:'协议验证 hello 世界',sender:'本地合成',color:'#55aaff',size:42};
  up.send(JSON.stringify({group,danmaku:original}));await until(()=>received.length===1);
  const {trace,...legacy}=received[0];assert.deepEqual(legacy,original);assert.ok(trace.id);assert.ok(trace.serverProcessingMs>=0);assert.ok(trace.serverReceivedAtMs>0);
  for(const text of ['x'.repeat(51),'[environment blocked check]','   '])up.send(JSON.stringify({group,danmaku:{text}}));
  await sleep(700);assert.equal(received.length,1);assert.equal(wrong.length,0);
  const qqGroup=909090909,onebotReceived=[];
  (await connect(`/danmaku/${qqGroup}`,5098)).onmessage=e=>onebotReceived.push(JSON.parse(e.data));
  const onebot=await connect('/onebot',5099);
  onebot.send(JSON.stringify({post_type:'message',group_id:qqGroup,message_id:12345,time:Math.floor(Date.now()/1000),sender:{user_id:1,nickname:'协议验证'},message:[{type:'text',data:{text:'OneBot synthetic check'}}]}));
  await until(()=>onebotReceived.length===1);assert.equal(onebotReceived[0].text,'OneBot synthetic check');assert.equal(onebotReceived[0].trace.id,'0-12345');assert.ok(onebotReceived[0].trace.sourceTimestampSec>0);
  onebot.send(JSON.stringify({post_type:'message',group_id:qqGroup,message:[{type:'image',data:{file:'not-a-real-file'}}]}));
  await sleep(300);assert.equal(onebotReceived.length,1);
  const image={type:'image',data:{file:'fixture-image.gif',url:'https://qpic.cn/wander-fixture.gif'}};
  const face={type:'face',data:{id:'14'}};
  onebot.send(JSON.stringify({post_type:'message',group_id:qqGroup,message_id:12346,message:[{type:'text',data:{text:'mixed '}},image,face]}));
  await until(()=>onebotReceived.length===2);assert.deepEqual(onebotReceived[1].segments.map(s=>s.type),['text','image','face']);assert.equal(onebotReceived[1].segments[1].mediaId,'fixture-image.gif');assert.equal(onebotReceived[1].segments[2].faceId,'14');
  onebot.send(JSON.stringify({post_type:'message',group_id:qqGroup,message_id:12347,message:[image]}));
  await until(()=>onebotReceived.length===3);assert.equal(onebotReceived[2].segments[0].type,'image','pure images survive empty-text filter');
  onebot.send(JSON.stringify({post_type:'message',group_id:qqGroup,message_id:12348,message:[{type:'text',data:{text:'[blocked check]'}},image]}));
  await sleep(400);assert.equal(onebotReceived.length,3,'image does not bypass text blacklist');
  onebot.send(JSON.stringify({post_type:'message',group_id:qqGroup,message_id:12349,message:[{type:'mface',data:{emoji_id:'0123456789abcdef'}}]}));
  await until(()=>onebotReceived.length===4);assert.equal(onebotReceived[3].segments[0].url,'https://gxh.vip.qq.com/club/item/parcel/item/01/0123456789abcdef/raw300.gif');
  onebot.send(JSON.stringify({post_type:'message_sent',group_id:qqGroup,self_id:123456,user_id:123456,message_id:12350,message:[{type:'text',data:{text:'own account message'}}]}));
  await until(()=>onebotReceived.length===5);assert.equal(onebotReceived[4].text,'own account message');
  let memberQueries=0;
  onebot.onmessage=e=>{const request=JSON.parse(e.data);assert.equal(request.action,'get_group_member_info');memberQueries++;onebot.send(JSON.stringify({status:'ok',retcode:0,echo:request.echo,data:{card:'群内名片',nickname:'账号昵称'}}));};
  const mention=id=>({post_type:'message',group_id:qqGroup,message_id:id,message:[{type:'at',data:{qq:'112233'}},{type:'text',data:{text:' hello'+id}}]});
  onebot.send(JSON.stringify(mention(12351)));await until(()=>onebotReceived.length===6);assert.equal(onebotReceived[5].text,'@群内名片 hello12351');
  onebot.send(JSON.stringify(mention(12352)));await until(()=>onebotReceived.length===7);assert.equal(memberQueries,1,'member names cached');
  onebot.send(JSON.stringify({post_type:'message',group_id:qqGroup,message_id:12353,message:[{type:'at',data:{qq:'all'}}]}));await until(()=>onebotReceived.length===8);assert.equal(onebotReceived[7].text,'@全体成员');
  console.log('PASS: legacy pages/assets, optional trace compatibility, private status boundary, WS forwarding, group isolation, length/blacklist/empty filters, OneBot parsing and message ID. No QQ messages sent.');
} finally {for(const ws of sockets)ws.close();setTimeout(()=>process.exit(process.exitCode||0),500).unref();}
