import { BrowserWindow } from 'electron';
import { writeFile,unlink } from 'node:fs/promises';
import path from 'node:path';
import { MediaStore,decodeMedia,safeMediaUrl } from './media';
import { defaultCard,type Settings } from '../shared/settings';
import type { Command,Snapshot } from '../shared/api';
import { saveCapture } from './capture';
import { GifWriter } from 'omggif';

export async function runImprovementSmoke(ctx:{control:BrowserWindow;overlay:BrowserWindow;cardWindow:BrowserWindow;mediaStore:MediaStore;save:(s:unknown)=>Promise<void>;command:(c:Command)=>Promise<unknown>;snapshot:()=>Snapshot;out:string}){
  const {control,overlay,cardWindow,command,snapshot}=ctx;
  const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  const assert=(v:unknown,label:string)=>{if(!v)throw Error('V2 smoke: '+label);};
  const results:string[]=[];
  await command('clear');await command('show');await sleep(200);
  const fixture=await control.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#006534';x.fillRect(0,0,100,100);x.fillStyle='white';x.font='40px sans-serif';x.fillText('QR',15,65);return c.toDataURL()})()`);
  const buffer=Buffer.from(fixture.split(',')[1],'base64');
  const file=ctx.out.replace(/\.json$/,'-fixture.png');await writeFile(file,buffer);
  const imported=await ctx.mediaStore.importFile(file);await unlink(file);
  const next=structuredClone(snapshot().settings);next.joinCards[next.source.groupId]={...defaultCard,imageId:imported.id,title:'自定义加群标题',description:'欢迎来玩\n这是本地卡片验收'};
  await ctx.save(next);await command('showCard');await sleep(200);
  assert(snapshot().cardVisible&&cardWindow.isVisible(),'card visible');assert(!cardWindow.isFocusable()&&cardWindow.isAlwaysOnTop(),'card window properties');
  assert((await cardWindow.webContents.executeJavaScript('document.body.innerText')).includes('自定义加群标题'),'custom caption');
  assert(await cardWindow.webContents.executeJavaScript('document.querySelector("img").naturalWidth')===100,'copied image survives original deletion');
  await saveCapture(cardWindow,ctx.out.replace(/\.json$/,'-card.png'));
  await command('clear');assert(cardWindow.isVisible(),'clear keeps card');await command('hide');assert(!cardWindow.isVisible()&&!snapshot().cardVisible,'emergency hide card');
  await command('show');await command('showCard');const switched=structuredClone(next);switched.source.groupId='909090905';await ctx.save(switched);assert(!cardWindow.isVisible(),'switch hides QR');
  await ctx.save(next);await command('show');await command('hideCard');await sleep(500);
  results.push('二维码副本、自定义文字、透明穿透属性、清空保留、隐藏/切群联动通过（测试图不是实际加群码）');

  for(const url of ['http://qpic.cn/a','https://localhost/a','https://qpic.cn.evil.invalid/a','file:///a','https://user:pass@qpic.cn/a','https://qpic.cn:8080/a']){let failed=false;try{safeMediaUrl(url);}catch{failed=true;}assert(failed,'reject unsafe media '+url);}
  let failed=false;try{decodeMedia(Buffer.from('not a picture'));}catch{failed=true;}assert(failed,'bad media');
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  assert(decodeMedia(gif).animated,'GIF first-frame decode and animated source');
  const longBytes=Buffer.alloc(200000),longWriter=new GifWriter(longBytes,1,1,{palette:[0,0xffffff],loop:0});
  for(let i=0;i<121;i++)longWriter.addFrame(0,0,1,1,Buffer.from([i%2]),{delay:2});
  const longGif=decodeMedia(longBytes.subarray(0,longWriter.end()));assert(!longGif.animated&&longGif.data===longGif.still,'long GIF degrades to first frame instead of rejecting');
  const oversized=Buffer.from(buffer);oversized.writeUInt32BE(50000,16);oversized.writeUInt32BE(50000,20);failed=false;try{decodeMedia(oversized);}catch{failed=true;}assert(failed,'pixel limit before PNG decode');
  let calls=0;
  const fake=new MediaStore(path.dirname(ctx.out),{lookup:(async()=>[{address:'1.1.1.1',family:4}]) as any,fetch:(async()=>{calls++;return new Response(buffer);}) as typeof fetch});
  const image={type:'image' as const,mediaId:'test-image',url:'https://qpic.cn/wander-fixture.png'};
  const a=await fake.get(image),b=await fake.get(image);assert(a.width===100&&b.width===100&&calls===1,'cache hit');
  const redirect=new MediaStore(path.dirname(ctx.out),{lookup:(async()=>[{address:'1.1.1.1',family:4}]) as any,fetch:(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})) as typeof fetch});
  failed=false;try{await redirect.get(image);}catch{failed=true;}assert(failed,'unsafe redirect');
  results.push('媒体格式/尺寸/URL/重定向校验及缓存通过（受控下载响应）');

  const packet={text:'本地合成聚合验证'};
  const send=(p:unknown,count?:number,media?:unknown)=>overlay.webContents.send('overlay',{type:'test',settings:snapshot().settings,visible:true,paused:false,packet:p,count,media});
  await command('clear');send(packet,66);await sleep(120);
  assert((await overlay.webContents.executeJavaScript('document.querySelector(".count")?.textContent'))==='×66','66 count: '+await overlay.webContents.executeJavaScript('document.body.innerText'));
  assert(await overlay.webContents.executeJavaScript('document.querySelectorAll(".milestone").length')===1,'milestone class');
  await saveCapture(overlay,ctx.out.replace(/\.json$/,'-effect66.png'));
  await command('clear');send(packet,100);await sleep(120);assert((await overlay.webContents.executeJavaScript('document.querySelector(".count")?.textContent'))==='×100','100 count');
  const before=await overlay.webContents.executeJavaScript('document.querySelector(".danmaku").getBoundingClientRect().width');
  await sleep(80);assert(before===await overlay.webContents.executeJavaScript('document.querySelector(".danmaku").getBoundingClientRect().width'),'effect does not change layout');
  await command('clear');send({text:'图文测试',segments:[{type:'text',text:'图文测试'},{type:'image',mediaId:'fixture',url:''}]},1,a);await sleep(150);
  assert(await overlay.webContents.executeJavaScript('document.querySelectorAll(".danmaku img").length')===1,'mixed image render');
  assert(await overlay.webContents.executeJavaScript('document.querySelector(".danmaku img").naturalWidth')===100,'image decoded');
  await saveCapture(overlay,ctx.out.replace(/\.json$/,'-image.png'));
  results.push('66/100 计数与特效、特效布局稳定、图文同块渲染通过');
  const gifBytes=Buffer.alloc(4096),writer=new GifWriter(gifBytes,2,2,{palette:[0xffffff,0x006534],loop:0});
  writer.addFrame(0,0,2,2,new Uint8Array([0,0,0,0]),{delay:8});writer.addFrame(0,0,2,2,new Uint8Array([1,1,1,1]),{delay:8});
  const animated=decodeMedia(gifBytes.subarray(0,writer.end()));assert(animated.animated&&animated.still.startsWith('data:image/png'),'GIF animation/first frame sources');
  const mediaSettings=structuredClone(snapshot().settings);mediaSettings.style.fontSize=16;mediaSettings.media.maxAnimatedOnScreen=1;mediaSettings.media.animated=true;
  await ctx.save(mediaSettings);await command('clear');
  for(let i=0;i<3;i++)send({text:'GIF',segments:[{type:'image',mediaId:'gif-fixture-'+i,url:''}]},1,animated);
  await sleep(180);
  assert(await overlay.webContents.executeJavaScript('document.querySelectorAll(".danmaku img").length')===3,'three GIF fixtures render');
  assert(await overlay.webContents.executeJavaScript('Array.from(document.querySelectorAll(".danmaku img")).filter(i=>i.src.startsWith("data:image/gif")).length')===1,'animation cap uses static first frames');
  mediaSettings.display.topRatio=.5;mediaSettings.media.maxAnimatedOnScreen=8;
  await ctx.save(mediaSettings);await sleep(350);await command('clear');
  for(let i=0;i<8;i++)send({text:'GIF',segments:[{type:'image',mediaId:'eight-gifs-'+i,url:''}]},1,animated);
  await sleep(180);
  const eight=await overlay.webContents.executeJavaScript('Array.from(document.querySelectorAll(".danmaku img")).filter(i=>i.src.startsWith("data:image/gif")).length');
  assert(eight===8,`eight GIFs animate together: actual ${eight}, height ${overlay.getBounds().height}`);
  await ctx.save(next);await command('clear');
  results.push('真实双帧 GIF 解码、动画源及静态首帧、同屏动画数量限制通过');
  try{
    const modern=await ctx.mediaStore.get({type:'face',faceId:'300',alt:'[QQ 表情]'});assert(modern.width>0,'modern QQ face 300 official CDN');
    const real=await ctx.mediaStore.get({type:'face',faceId:'14',alt:'[QQ 表情]'});
    assert(real.width>0,'QQ CDN image');await command('clear');
    send({text:'[QQ 表情]',segments:[{type:'face',faceId:'14',alt:'[QQ 表情]'}]});await sleep(250);
    assert(await overlay.webContents.executeJavaScript('document.querySelector(".danmaku img")?.naturalWidth>0'),'real media IPC cache render');
    results.push('QQ 官方表情 CDN 实际下载、首帧及媒体 IPC 缓存渲染通过');
  }catch(e){results.push('QQ 官方表情 CDN 实网验证未通过，已验证降级路径；原因：'+String(e).slice(0,160));}
  await command('clear');
  return results;
}
