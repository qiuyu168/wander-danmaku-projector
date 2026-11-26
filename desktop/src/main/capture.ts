import { BrowserWindow } from 'electron';
import {writeFile,unlink,readFile} from 'node:fs/promises';
import path from 'node:path';
export const captureWarnings:string[]=[];
export async function capture(window:BrowserWindow){
  let error:unknown;
  for(let attempt=0;attempt<3;attempt++){
    try{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{return (await Promise.race([window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('Windows display capture timed out')),1500);})])).toPNG();}
      finally{if(timer)clearTimeout(timer);}
    }
    catch(e){error=e;await new Promise(r=>setTimeout(r,250));}
  }
  throw error;
}
export async function saveCapture(window:BrowserWindow,file:string){
  try{await writeFile(file,await capture(window));}
  catch(e){await unlink(file).catch(()=>{});const warning=`${file}: ${String(e)}`;captureWarnings.push(warning);await writeFile(file+'.unavailable.txt',warning);}
}
// A static offscreen copy verifies layout when Windows has no capturable surface.
// It does not certify the real overlay, focus, transparency or HDMI composition.
export async function captureLayout(source:BrowserWindow,file:string){
  const bounds=source.getContentBounds();
  const temporary=file+'.layout.html';
  const clone=new BrowserWindow({width:bounds.width,height:bounds.height,show:false,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true}});
  try{
    const html=await source.webContents.executeJavaScript('document.documentElement.outerHTML'),scroll=await source.webContents.executeJavaScript('window.scrollY');
    const css=await readFile(path.join(__dirname,'theme.css'),'utf8');
    const page=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link[^>]+href="theme.css"[^>]*>/i,`<style>${css}</style>`);
    await writeFile(temporary,page,'utf8');
    await clone.loadFile(temporary);
    await clone.webContents.executeJavaScript(`window.scrollTo(0,${Number(scroll)})`);
    await new Promise(r=>setTimeout(r,150));await writeFile(file,await capture(clone));
  }finally{clone.destroy();await unlink(temporary).catch(()=>{});}
}
