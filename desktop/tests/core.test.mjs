import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
await mkdir('artifacts',{recursive:true});
await build({entryPoints:['src/shared/queue.ts','src/shared/settings.ts','src/shared/aggregation.ts','src/shared/displays.ts','src/shared/moderation.ts','src/main/image-header.ts'],outdir:'artifacts/test',outbase:'src',platform:'node',format:'esm',outExtension:{'.js':'.mjs'}});
const {FreshQueue,percentile}=await import(pathToFileURL(path.resolve('artifacts/test/shared/queue.mjs')));
const {defaults,validateSettings}=await import(pathToFileURL(path.resolve('artifacts/test/shared/settings.mjs')));
const {Aggregates,RepeatWindow,contentKey,crossed}=await import(pathToFileURL(path.resolve('artifacts/test/shared/aggregation.mjs')));
const {imageHeader}=await import(pathToFileURL(path.resolve('artifacts/test/main/image-header.mjs')));
const {keywordFilter}=await import(pathToFileURL(path.resolve('artifacts/test/shared/moderation.mjs')));
const {chooseDisplay}=await import(pathToFileURL(path.resolve('artifacts/test/shared/displays.mjs')));
test('screen topology recovery prefers selected display, matches replaced IDs and falls back',()=>{
  const primary={id:'1',label:'Laptop',primary:true,bounds:{width:1920,height:1080}},external={id:'2',label:'Projector',primary:false,bounds:{width:1920,height:1080}};
  const choice={targetId:'old',targetHint:{label:'Projector',width:1920,height:1080}};
  assert.equal(chooseDisplay([primary,external],choice).id,'2');
  assert.equal(chooseDisplay([primary],choice).id,'1');assert.equal(chooseDisplay([],choice),undefined);
  assert.equal(chooseDisplay([primary,external],{targetId:'1'}).id,'1');
});
test('threshold repetition uses fixed windows and old settings gain startCount without losing media limits',()=>{
  const r=new RepeatWindow();for(let i=1;i<=6;i++)assert.equal(r.count('same',i,1000),i);
  assert.equal(r.count('other',500,1000),1);assert.equal(r.count('same',1001,1000),1);r.clear();assert.equal(r.count('same',1002,1000),1);
  const old=structuredClone(defaults);delete old.aggregation.startCount;old.media.maxAnimatedOnScreen=4;
  assert.equal(validateSettings(old).aggregation.startCount,6);assert.equal(validateSettings(old).media.maxAnimatedOnScreen,4);
  old.media.maxAnimatedOnScreen=16;assert.equal(validateSettings(old).media.maxAnimatedOnScreen,16);
});
test('keyword bans match mixed text, full-width and literal symbols without inspecting image URLs',()=>{
  const ban=keywordFilter(['广告','BAD','a.b']);
  assert.equal(ban({text:'这是广告消息'}),true);
  assert.equal(ban({text:'bAd'}),true);
  assert.equal(ban({text:'ＢＡＤ'}),true);
  assert.equal(ban({text:'aXb'}),false);
  assert.equal(ban({text:'a.b'}),true);
  assert.equal(ban({text:'[图片]',segments:[{type:'text',text:'广'},{type:'image',mediaId:'1',url:'https://qq.com/a'},{type:'text',text:'告'}]}),true);
  assert.equal(ban({text:'[图片]',segments:[{type:'image',mediaId:'1',url:'https://qq.com/BAD'}]}),false);
  assert.equal(keywordFilter([])({text:'广告'}),false);
});
test('old settings acquire an empty ban list; saved bans are bounded and normalized',()=>{
  const old=structuredClone(defaults);delete old.moderation;assert.deepEqual(validateSettings(old).moderation.keywords,[]);
  const s=structuredClone(defaults);s.moderation.keywords=[' 广告 ','','广告'];assert.deepEqual(validateSettings(s).moderation.keywords,['广告']);
  for(const keywords of [Array(501).fill('word'),['a'.repeat(81)],[42]]){s.moderation.keywords=keywords;assert.throws(()=>validateSettings(s));}
});
test('burst keeps newest messages and expires at deadline',()=>{
  const q=new FreshQueue(2,500);q.push('old',0);q.push('middle',100);q.push('new',200);
  assert.equal(q.overflow,1);assert.deepEqual(q.items.map(v=>v.value),['middle','new']);
  assert.equal(q.shift(600).value,'new');assert.equal(q.expired,1);
  q.push('never replay',700);q.clear();assert.equal(q.shift(710),undefined);
});
test('expired messages cannot be rescued by later traffic',()=>{
  const q=new FreshQueue(50,500);q.push('stale',0);q.push('fresh',501);assert.equal(q.expired,1);assert.equal(q.items.length,1);assert.equal(q.items[0].value,'fresh');
});
test('reject unsafe settings, accept validated Chinese font and negative-free ratios',()=>{
  assert.equal(validateSettings(defaults).style.fontSize,40);
  for(const mutate of [s=>s.style.color='url(javascript:x)',s=>s.display.topRatio=NaN,s=>s.style.speed=-1,s=>s.source.groupId='1;cmd',s=>s.source.groupId=12345,s=>s.behavior.toggleShortcut='F1',s=>s.style.palette=[]]){
    const s=structuredClone(defaults);mutate(s);assert.throws(()=>validateSettings(s));
  }
});
test('percentiles use nearest rank and empty sample is unknown',()=>{assert.equal(percentile([], .95),null);assert.equal(percentile([9,1,4,2],.5),2);assert.equal(percentile([9,1,4,2],.95),9);});

test('v1 migrates without losing source, custom styles or display',()=>{
  const old=structuredClone(defaults);old.schemaVersion=1;delete old.joinCards;delete old.media;delete old.aggregation;
  old.source.groupId='123456';old.style.color='#123456';old.display.targetId='-123';
  const s=validateSettings(old);assert.equal(s.schemaVersion,2);assert.equal(s.source.groupId,'123456');assert.equal(s.style.color,'#123456');assert.equal(s.display.targetId,'-123');assert.deepEqual(s.aggregation.milestones,[66,100]);assert.equal(old.schemaVersion,1);
});
test('QR resources and effect settings reject invalid input',()=>{
  for(const mutate of [s=>s.joinCards={'123':{imageId:'../other',title:'',description:'',position:'topLeft',widthDip:240,marginDip:24}},s=>s.aggregation.milestones=[100,66],s=>s.aggregation.milestones=[66,66],s=>s.media.maxAnimatedOnScreen=17,s=>s.aggregation.windowMs=0]){const s=structuredClone(defaults);mutate(s);assert.throws(()=>validateSettings(s));}
});
test('aggregation uses ordered structured content and stable image identity',()=>{
  assert.equal(contentKey({text:' 好耶！\r\n '}),contentKey({text:'好耶！'}));
  assert.notEqual(contentKey({text:'好耶！'}),contentKey({text:'好耶！！'}));
  const image=url=>({text:'[图片]',segments:[{type:'image',mediaId:'stable-file',url}]});assert.equal(contentKey(image('https://x/a?old')),contentKey(image('https://x/a?new')));
  const other=image('a');other.segments[0].mediaId='different';assert.notEqual(contentKey(image('a')),contentKey(other));
  const text={type:'text',text:'hello'},img=image('a').segments[0];assert.notEqual(contentKey({text:'',segments:[text,img]}),contentKey({text:'',segments:[img,text]}));
});
test('duplicates do not extend aggregation window; expired entities cannot be revived',()=>{
  const a=new Aggregates(),e={key:'a',at:0,count:1};a.add(e);e.count++;
  assert.equal(a.find('a',9999,10000),e);assert.equal(a.find('a',10000,10000),undefined);
  a.remove(e);assert.equal(a.find('a',100,10000),undefined);
  assert.equal(a.duplicate('id',0),false);assert.equal(a.duplicate('id',100),true);assert.equal(a.duplicate('another',100),false);assert.equal(a.duplicate(undefined,101),false);a.clear();assert.equal(a.duplicate('id',200),false);
});
test('milestone crossing handles batched counts and highest level only',()=>{
  assert.equal(crossed(65,66,[66,100]),66);assert.equal(crossed(99,100,[66,100]),100);assert.equal(crossed(65,101,[66,100]),100);assert.equal(crossed(100,101,[66,100]),0);
});
test('image allocation checks precede decode, including GIF frame budget',()=>{
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');assert.equal(imageHeader(gif).frames,1);
  const start=gif.indexOf(44,13),frame=gif.subarray(start,gif.length-1);
  const long=Buffer.concat([gif.subarray(0,start),...Array(121).fill(frame),Buffer.from([59])]);
  assert.equal(imageHeader(long).animationSafe,false);assert.equal(imageHeader(long).frames,121);
  const truncated=gif.subarray(0,gif.length-3);assert.throws(()=>imageHeader(truncated));
  const oversized=Buffer.from(gif);oversized.writeUInt16LE(16000,6);oversized.writeUInt16LE(16000,8);assert.throws(()=>imageHeader(oversized));
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(50000,16);png.writeUInt32BE(50000,20);assert.throws(()=>imageHeader(png));
  assert.throws(()=>imageHeader(Buffer.from('not an image')));
  const webp=Buffer.alloc(30);webp.write('RIFF',0);webp.write('WEBPVP8X',8);webp[20]=2;assert.throws(()=>imageHeader(webp));
});
