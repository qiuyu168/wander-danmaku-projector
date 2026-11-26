// Run after bundling src/main/media.ts to artifacts/media-check.cjs.
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {GifWriter}=require('omggif');
const {MediaStore,decodeMedia,optimizeMedia}=require('../artifacts/media-check.cjs');
const output=process.env.WANDER_MEDIA_TEST_OUTPUT||path.join(app.getPath('temp'),'wander-media-check.json');
app.whenReady().then(async()=>{
  const results=[];
  try{
    const buffer=Buffer.alloc(100000),writer=new GifWriter(buffer,2,2,{palette:[0,0xffffff],loop:0});
    for(let i=0;i<121;i++)writer.addFrame(0,0,2,2,Buffer.from([i%2,0,1,0]),{delay:2});
    const gif=buffer.subarray(0,writer.end()),still=decodeMedia(gif);
    assert.equal(still.animated,false);assert.equal(still.data,still.still);assert.equal(still.width,2);
    results.push('121-frame GIF produces valid static first frame');
    const optimized=await optimizeMedia(gif);assert(optimized.animated);results.push('121-frame GIF remains animated through worker optimization');
    const large=Buffer.alloc(20*1024*1024),largeWriter=new GifWriter(large,800,600,{palette:[0,0xffffff],loop:0});
    for(let i=0;i<12;i++)largeWriter.addFrame(0,0,800,600,Buffer.alloc(800*600,i%2),{delay:8});
    const reduced=await optimizeMedia(large.subarray(0,largeWriter.end()));assert(reduced.animated);assert.equal(reduced.width,320);assert.equal(reduced.height,240);
    results.push('800x600 animated GIF shrinks to 320x240 while retaining animation');
    const over8=Buffer.concat([gif,Buffer.alloc(9*1024*1024)]);
    const fakeLarge=new MediaStore(app.getPath('temp'),{lookup:async()=>[{address:'1.1.1.1',family:4}],fetch:async()=>new Response(over8)});
    assert((await fakeLarge.get({type:'image',mediaId:'9mb',url:'https://qpic.cn/9mb.gif'})).animated);results.push('9 MiB GIF downloads and decodes within expanded bound');
    const store=new MediaStore(app.getPath('temp'));
    for(const faceId of ['14','300','348']){
      const media=await store.get({type:'face',faceId,alt:'QQ face'});assert(media.width>0);
      results.push(`QQ official CDN face ${faceId} decoded (${media.width}x${media.height})`);
    }
    const fake=new MediaStore(app.getPath('temp'),{lookup:async()=>[{address:'1.1.1.1',family:4}],fetch:async()=>new Response(gif)});
    assert((await fake.get({type:'image',mediaId:'long',url:'https://qpic.cn/test.gif'})).animated);assert.equal(fake.stats.staticFallbacks,0);
    fs.writeFileSync(output,JSON.stringify({passed:true,results},null,2));
  }catch(e){fs.writeFileSync(output,JSON.stringify({passed:false,results,error:String(e)},null,2));process.exitCode=1;}
  finally{app.quit();}
});
