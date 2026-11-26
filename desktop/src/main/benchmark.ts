import { BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { Settings } from '../shared/settings';
import type { Snapshot, Command } from '../shared/api';
import type { Runtime } from './runtime';

// Both renderers receive the same messages. All wait measurements stay within
// their own renderer's performance clock; no cross-process clock subtraction.
function instrumentation() {
  const w=window as any;
  const pending=new Map<string,number>(), waits:number[]=[], frames:number[]=[];
  let received=0,shown=0,last=0,maxPending=0;
  const Original=window.WebSocket;
  w.WebSocket=class extends Original {
    constructor(url:string, protocols?:string|string[]) {
      super(url,protocols);
      this.addEventListener('message',e=>{try {
        const p=JSON.parse(String(e.data));
        if(/^B[abcd]{5}/.test(p.text)){pending.set(p.text,performance.now());received++;maxPending=Math.max(maxPending,pending.size);}
      }catch{}});
    }
  };
  function frame(now:number){
    if(last&&now-last<2000)frames.push(now-last);last=now;
    if(frames.length>30000)frames.shift();
    if(pending.size)for(const el of document.querySelectorAll('span,div')){
      if(el.childElementCount)continue;
      const text=el.textContent||'',at=pending.get(text);
      if(at===undefined)continue;
      const r=el.getBoundingClientRect();
      if(r.left<innerWidth&&r.right>0&&r.bottom>0&&r.top<innerHeight){waits.push(performance.now()-at);pending.delete(text);shown++;}
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  const pct=(a:number[],p:number)=>{if(!a.length)return null;const s=[...a].sort((a,b)=>a-b);return Math.round(s[Math.ceil(p*s.length)-1]*100)/100;};
  w.__benchmark=()=>({received,shown,notObserved:received-shown,maxPending,waitP50:pct(waits,.5),waitP95:pct(waits,.95),waitP99:pct(waits,.99),waitMax:waits.length?Math.max(...waits):null,frameP95:pct(frames,.95),frameP99:pct(frames,.99),waits,heapBytes:w.performance.memory?.usedJSHeapSize});
}

export async function runBenchmark(ctx:{overlay:BrowserWindow;settings:Settings;runtime:Runtime;save:(s:unknown)=>Promise<void>;command:(c:Command)=>Promise<unknown>;snapshot:()=>Snapshot;out:string}){
  const before=structuredClone(ctx.settings),group='909090908';
  const baseline=new BrowserWindow({show:false,frame:false,transparent:true,focusable:false,skipTaskbar:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  const samples:unknown[]=[];
  try {
    const next=structuredClone(before);next.source.groupId=group;next.display.targetId=ctx.snapshot().displays[0].id;
    next.display.topRatio=.25;next.style.fontSize=40;next.style.speed=144;next.style.fontFamily='Microsoft YaHei';
    const warmup=structuredClone(next);warmup.source.groupId='909090907';
    await ctx.save(warmup);await ctx.command('show');await sleep(300);
    await ctx.overlay.webContents.executeJavaScript(`(${instrumentation.toString()})()`);
    await baseline.loadURL('about:blank');
    baseline.webContents.debugger.attach('1.3');
    await baseline.webContents.debugger.sendCommand('Page.enable');
    await baseline.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`(${instrumentation.toString()})()`});
    baseline.setBounds(ctx.overlay.getBounds());baseline.setIgnoreMouseEvents(true);baseline.showInactive();
    await baseline.loadURL(`http://localhost:5098/${group}?defaultSize=40&speed=144&font=Microsoft%20YaHei`);
    await ctx.save(next);await ctx.command('show');
    baseline.setBounds(ctx.overlay.getBounds());baseline.setIgnoreMouseEvents(true);baseline.showInactive();
    await sleep(1500);
    const sample=async(phase:string)=>{
      samples.push({phase,at:new Date().toISOString(),baseline:await baseline.webContents.executeJavaScript('window.__benchmark()'),current:await ctx.overlay.webContents.executeJavaScript('window.__benchmark()'),metrics:ctx.snapshot().metrics});
      await writeFile(ctx.out,JSON.stringify({state:'running',bounds:ctx.overlay.getBounds(),samples},null,2));
    };
    await sample('before');
    const source=`
      const ws=new WebSocket('ws://danmaku-server:5099/danmaku');
      await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
      let n=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const textFor=i=>'B'+Array.from({length:5},(_,j)=>'abcd'[(i>>(j*2))&3]).join('')+'欢迎参与现场弹幕测试活动呀呀';
      const probe=new WebSocket('ws://danmaku-server:5098/danmaku/${group}-preflight');
      await new Promise((r,j)=>{probe.onopen=r;probe.onerror=j});
      await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('性能测试文本被过滤，停止无效测量')),5000);probe.onmessage=()=>{clearTimeout(t);r()};ws.send(JSON.stringify({group:'${group}-preflight',danmaku:{text:textFor(0)}}));});probe.close();
      async function phase(name,count,interval){
        for(let i=0;i<count;i++){ws.send(JSON.stringify({group:'${group}',danmaku:{text:textFor(n++)}}));await sleep(interval);}
        console.log(name);
      }
      await phase('regular',300,1000);await sleep(1000);
      await phase('burst',200,50);await sleep(1000);
      await phase('recovery',10,1000);await sleep(1500);
      for(let i=0;i<100;i++){ws.send(JSON.stringify({group:'${group}',danmaku:{text:textFor(900)}}));await sleep(50);}console.log('repeat100');
      for(let i=0;i<200;i++){ws.send(JSON.stringify({group:'${group}',danmaku:{text:textFor(i%5===0?600+i:901)}}));await sleep(50);}console.log('repeat80percent');
      await sleep(1500);ws.close();setTimeout(()=>process.exit(0),300);
    `;
    const child=spawn(ctx.runtime.docker,['run','--rm','--network','danmaku-server_default','-i','docker.m.daocloud.io/library/node:24-alpine','node','--input-type=module','-'],{windowsHide:true});
    let sampleChain=Promise.resolve(),stderr='';
    child.stdout.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))sampleChain=sampleChain.then(()=>sample(line.trim()));});
    child.stderr.on('data',chunk=>stderr+=chunk.toString());
    child.stdin.end(source);
    await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(stderr)));});
    await sampleChain;await sample('final');
    await writeFile(ctx.out,JSON.stringify({state:'complete',date:new Date().toISOString(),bounds:ctx.overlay.getBounds(),settings:next.style,aggregation:next.aggregation,scenario:'同一服务、同一合成输入；1/s 300s → 20/s 10s → 1/s 10s → 100%重复 20/s 5s → 80%重复 20/s 10s',measurement:'各渲染进程 WS 接收 → rAF 内观察 DOM 矩形进入视口；重复阶段 observer 仅记录文本可见，不代表计数已刷新。聚合代表消息数以 metrics.represented 为准。非 QQ/HDMI 实测。',samples},null,2));
  } finally {baseline.destroy();await ctx.command('hide');await ctx.save(before);}
}
