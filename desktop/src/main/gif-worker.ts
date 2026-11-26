import { parentPort,workerData } from 'node:worker_threads';
import { GifReader,GifWriter } from 'omggif';
import { PNG } from 'pngjs';
import { imageHeader } from './image-header';

// Downsample large GIFs away from Electron's main thread; preserve timing,
// compositing and transparent frames while bounding decode work and memory.
try {
  const source=Buffer.from(workerData),header=imageHeader(source),gif=new GifReader(source);
  const canAnimate=header.frames<=600&&header.width*header.height*header.frames<=240_000_000;
  const scale=Math.min(1,320/Math.max(header.width,header.height),Math.sqrt(24_000_000/(header.width*header.height*(canAnimate?header.frames:1))));
  const width=Math.max(1,Math.round(header.width*scale)),height=Math.max(1,Math.round(header.height*scale));
  const pixels=Buffer.alloc(header.width*header.height*4),small=Buffer.alloc(width*height*4);
  const palette=Array.from({length:256},(_,i)=>{if(i===255)return 0xffffff;const q=Math.max(0,i-1);return (((q>>>5)*255/7|0)<<16)|(((((q>>>2)&7)*255/7)|0)<<8)|((q&3)*255/3|0);});
  const count=canAnimate?header.frames:1;
  const encoded=Buffer.alloc(Math.min(64*1024*1024,width*height*count*2+count*1000+4096));
  const writer=new GifWriter(encoded,width,height,{palette,loop:0});let first:Buffer|undefined;
  for(let i=0;i<count;i++){
    const info=gif.frameInfo(i),before=info.disposal===3?Buffer.from(pixels):undefined;
    gif.decodeAndBlitFrameRGBA(i,pixels);
    const indexed=new Uint8Array(width*height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const p=(Math.min(header.height-1,Math.floor(y/scale))*header.width+Math.min(header.width-1,Math.floor(x/scale)))*4,k=(y*width+x)*4;
      small[k]=pixels[p];small[k+1]=pixels[p+1];small[k+2]=pixels[p+2];small[k+3]=pixels[p+3];
      indexed[y*width+x]=pixels[p+3]<128?0:Math.min(255,1+((pixels[p]>>>5)<<5|(pixels[p+1]>>>5)<<2|(pixels[p+2]>>>6)));
    }
    if(!first)first=PNG.sync.write({width,height,data:Buffer.from(small)});
    writer.addFrame(0,0,width,height,indexed,{delay:Math.max(2,info.delay),transparent:0,disposal:2});
    if(before)before.copy(pixels);
    else if(info.disposal===2)for(let y=info.y;y<info.y+info.height;y++)pixels.fill(0,(y*header.width+info.x)*4,(y*header.width+info.x+info.width)*4);
  }
  const length=writer.end();if(length>encoded.length)throw Error('动画转换超过输出预算');
  const still=`data:image/png;base64,${first!.toString('base64')}`;
  parentPort!.postMessage({data:canAnimate?`data:image/gif;base64,${encoded.subarray(0,length).toString('base64')}`:still,still,width,height,animated:canAnimate,optimized:scale<1});
}catch(e){parentPort!.postMessage({error:String(e instanceof Error?e.message:e)});}
