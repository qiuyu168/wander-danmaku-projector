import { nativeImage,net } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import type { MediaResult,Segment } from '../shared/api';
import { imageHeader } from './image-header';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import faceMap from '../shared/qq-face-map.json';
import { Worker } from 'node:worker_threads';
let decoders=0;
const decodeWaiters:Array<()=>void>=[];
async function acquireDecoder(){
  if(decoders<2){decoders++;return;}
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{const index=decodeWaiters.indexOf(ready);if(index>=0)decodeWaiters.splice(index,1);reject(Error('GIF 优化排队超时'));},5000);
    const ready=()=>{clearTimeout(timer);resolve();};decodeWaiters.push(ready);
  });
}
function releaseDecoder(){const next=decodeWaiters.shift();if(next)next();else decoders--;}

export async function optimizeMedia(buffer:Buffer):Promise<MediaResult>{
  const h=imageHeader(buffer);
  if(h.type!=='gif'||Math.max(h.width,h.height)<=320&&h.animationSafe)return decodeMedia(buffer,32*1024*1024);
  await acquireDecoder();
  try{return await new Promise<MediaResult>((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'gif-worker.cjs'),{workerData:buffer,resourceLimits:{maxOldGenerationSizeMb:128}});
    const timer=setTimeout(()=>{void worker.terminate();reject(Error('GIF 优化超时'));},5000);
    worker.once('message',value=>{clearTimeout(timer);void worker.terminate();value.error?reject(Error(value.error)):resolve(value);});
    worker.once('error',e=>{clearTimeout(timer);reject(e);});
    worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('GIF 优化进程已退出'));});
  });}finally{releaseDecoder();}
}

export function safeMediaUrl(value:string):URL {
  if(typeof value!=='string'||value.length>4096)throw Error('图片地址无效');
  const url=new URL(value);
  if(url.protocol==='http:'&&url.hostname==='gchat.qpic.cn'&&!url.port)url.protocol='https:';
  const trusted=['qpic.cn','qq.com','gtimg.cn'].some(h=>url.hostname===h||url.hostname.endsWith('.'+h))||url.hostname==='multimedia.nt.qq.com.cn';
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!trusted)throw Error('仅接受 QQ 官方 HTTPS 图片地址');
  return url;
}
export function decodeMedia(buffer:Buffer,maxBytes=8*1024*1024,allowGif=true):MediaResult {
  if(!buffer.length||buffer.length>maxBytes)throw Error('图片超过大小限制');
  const header=imageHeader(buffer),{type}=header;if(!allowGif&&type==='gif')throw Error('群二维码请选择静态图片');
  let first=buffer;
  if(type==='gif'){
    const gif=new GifReader(buffer),pixels=Buffer.alloc(header.width*header.height*4);gif.decodeAndBlitFrameRGBA(0,pixels);
    first=PNG.sync.write({width:header.width,height:header.height,data:pixels});
  }
  const image=nativeImage.createFromBuffer(first),size=image.getSize();
  if(image.isEmpty()||!size.width||!size.height||size.width*size.height>16_000_000||size.width>16000||size.height>16000)throw Error('图片无效或像素过大');
  const still=image.toDataURL(),animated=type==='gif'&&header.animationSafe;
  return {data:animated?`data:image/gif;base64,${buffer.toString('base64')}`:still,still,width:size.width,height:size.height,animated};
}
export class MediaStore {
  private cache=new Map<string,{result:MediaResult;bytes:number}>();
  private pending=new Map<string,Promise<MediaResult>>();
  private bytes=0;private running=0;private waiters:Array<()=>void>=[];
  stats={cacheHits:0,downloads:0,failures:0,timeout:0,bytes:0,staticFallbacks:0,lastError:''};
  constructor(private directory:string,private transport:{fetch:typeof fetch;lookup:typeof lookup}={fetch:net.fetch as typeof fetch,lookup}){}
  async importFile(file:string){
    if((await stat(file)).size>10*1024*1024)throw Error('二维码图片超过 10 MiB');
    const bytes=await readFile(file),result=decodeMedia(bytes,10*1024*1024,false);
    const png=Buffer.from(result.still.split(',')[1],'base64'),id=createHash('sha256').update(png).digest('hex');
    await mkdir(this.directory,{recursive:true});await writeFile(path.join(this.directory,id+'.png'),png);
    return {id,data:result.still};
  }
  async card(id:string){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('图片标识无效');return decodeMedia(await readFile(path.join(this.directory,id+'.png')),64*1024*1024,false).still;}
  async get(segment:Segment):Promise<MediaResult>{
    let url:string;
    if(segment?.type==='image')url=segment.url;
    else if(segment?.type==='face'&&Object.hasOwn(faceMap,segment.faceId)){url=`https://qzonestyle.gtimg.cn/qzone/em/e${faceMap[segment.faceId as keyof typeof faceMap]}.gif`;}
    else throw Error('暂未适配此 QQ 表情');
    safeMediaUrl(url);
    const key=createHash('sha256').update(url).digest('hex'),cached=this.cache.get(key);
    if(cached){this.stats.cacheHits++;this.cache.delete(key);this.cache.set(key,cached);return cached.result;}
    const existing=this.pending.get(key);if(existing)return existing;
    if(this.pending.size>=50)throw Error('媒体准备队列已满');
    const work=this.download(url).then(result=>{
      const bytes=(result.data.length+result.still.length)*2;
      while(this.bytes+bytes>200*1024*1024&&this.cache.size){const first=this.cache.keys().next().value!,v=this.cache.get(first)!;this.bytes-=v.bytes;this.cache.delete(first);}
      if(bytes<=200*1024*1024){this.cache.set(key,{result,bytes});this.bytes+=bytes;}this.stats.bytes=this.bytes;return result;
    }).catch(e=>{this.stats.failures++;this.stats.lastError=String(e instanceof Error?e.message:e).slice(0,180);throw e;}).finally(()=>this.pending.delete(key));
    this.pending.set(key,work);return work;
  }
  private async download(source:string){
    if(this.running>=4)await new Promise<void>((r,j)=>{const timer=setTimeout(()=>{const i=this.waiters.indexOf(next);if(i>=0)this.waiters.splice(i,1);j(Error('媒体等待超时'));},1500);const next=()=>{clearTimeout(timer);r();};this.waiters.push(next);});
    this.running++;const controller=new AbortController(),timer=setTimeout(()=>{this.stats.timeout++;controller.abort();},12000);
    try{
      let url=safeMediaUrl(source);
      for(let redirect=0;redirect<4;redirect++){
        const addresses=await Promise.race([this.transport.lookup(url.hostname,{all:true}),new Promise<never>((_r,j)=>{if(controller.signal.aborted)j(Error('图片解析超时'));else controller.signal.addEventListener('abort',()=>j(Error('图片解析超时')),{once:true});})]);
        if(!addresses.length||addresses.some(v=>isPrivate(v.address)))throw Error('图片域名解析到非公网地址');
        const response=await this.transport.fetch(url,{signal:controller.signal,redirect:'manual'});
        if(response.status>=300&&response.status<400){await response.body?.cancel();url=safeMediaUrl(new URL(response.headers.get('location')||'',url).href);continue;}
        if(!response.ok||!response.body)throw Error(`图片下载失败（HTTP ${response.status}）`);
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>32*1024*1024){controller.abort();throw Error('图片超过 32 MiB');}chunks.push(Buffer.from(chunk));}
        this.stats.downloads++;const buffer=Buffer.concat(chunks),result=await optimizeMedia(buffer);if(buffer.toString('ascii',0,3)==='GIF'&&!result.animated)this.stats.staticFallbacks++;return result;
      }
      throw Error('图片重定向过多');
    }finally{clearTimeout(timer);this.running--;this.waiters.shift()?.();}
  }
}
function isPrivate(address:string){
  if(address.includes(':'))return address==='::1'||address==='::'||/^(fc|fd|fe8|fe9|fea|feb|::ffff:)/i.test(address);
  const [a,b]=address.split('.').map(Number);return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a>=224||a===100&&b>=64&&b<=127;
}
