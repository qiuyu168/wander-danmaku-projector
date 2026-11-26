// Validate allocation bounds before asking Chromium/nativeImage to decode.
export function imageHeader(b:Buffer):{type:'png'|'jpeg'|'webp'|'gif';width:number;height:number;frames:number;animationSafe:boolean}{
  let type:'png'|'jpeg'|'webp'|'gif',width=0,height=0,frames=1;
  if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){type='png';width=b.readUInt32BE(16);height=b.readUInt32BE(20);}
  else if(b.length>=10&&['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))){
    type='gif';width=b.readUInt16LE(6);height=b.readUInt16LE(8);frames=0;
    let offset=13+((b[10]&128)?3*(1<<((b[10]&7)+1)):0);
    const skip=()=>{while(offset<b.length){const n=b[offset++];if(!n)return;offset+=n;if(offset>b.length)throw Error('GIF 数据截断');}throw Error('GIF 数据损坏');};
    while(offset<b.length){const tag=b[offset++];if(tag===59)break;if(tag===33){offset++;skip();}
      else if(tag===44){if(offset+9>b.length)throw Error('GIF 帧损坏');const fw=b.readUInt16LE(offset+4),fh=b.readUInt16LE(offset+6);if(!fw||!fh||fw*fh>16_000_000||b.readUInt16LE(offset)+fw>width||b.readUInt16LE(offset+2)+fh>height)throw Error('GIF 帧尺寸无效');const flags=b[offset+8];offset+=9;if(flags&128)offset+=3*(1<<((flags&7)+1));offset++;skip();frames++;if(frames>2000)throw Error('GIF 帧数过多');}
      else throw Error('GIF 数据格式无效');
    }
    if(!frames)throw Error('GIF 没有有效帧');
  }
  else if(b.length>=4&&b[0]===255&&b[1]===216){
    type='jpeg';let offset=2;
    while(offset+4<b.length){if(b[offset++]!==255)continue;const tag=b[offset++];if(tag===255)continue;if(tag===217||tag===218)break;if(tag===216||tag===1||tag>=208&&tag<=215)continue;
      const size=b.readUInt16BE(offset);if(size<2||offset+size>b.length)throw Error('JPEG 数据损坏');
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(tag)){height=b.readUInt16BE(offset+3);width=b.readUInt16BE(offset+5);break;}offset+=size;
    }
  }
  else if(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
    type='webp';const chunk=b.toString('ascii',12,16);
    if(chunk==='VP8X'){width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);if(b[20]&2)throw Error('动态 WebP 暂不支持，请使用 GIF');}
    else if(chunk==='VP8 '){width=b.readUInt16LE(26)&16383;height=b.readUInt16LE(28)&16383;}
    else if(chunk==='VP8L'){const bits=b.readUInt32LE(21);width=1+(bits&16383);height=1+((bits>>>14)&16383);}
  }
  else throw Error('仅支持 PNG/JPEG/WebP/GIF 图片');
  if(!width||!height||width>16000||height>16000||width*height>16_000_000)throw Error('图片像素无效或超过 1600 万像素');
  return {type,width,height,frames,animationSafe:type!=='gif'||frames<=120&&width*height*frames<=32_000_000};
}
