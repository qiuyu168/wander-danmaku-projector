import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, dialog, powerMonitor } from 'electron';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { defaults, validateSettings, type Settings } from '../shared/settings';
import type { DisplayInfo, Snapshot, Command } from '../shared/api';
import { Runtime } from './runtime';
import { MediaStore,decodeMedia } from './media';
import { chooseDisplay } from '../shared/displays';

app.setName('wander');

let control: BrowserWindow, overlay: BrowserWindow, cardWindow:BrowserWindow, tray: Tray, runtime: Runtime, mediaStore:MediaStore;
let cardVisible=false,cardData='',cardRequest=0,cardRect:{x:number;y:number;width:number;height:number}|undefined;
let settings: Settings=structuredClone(defaults), visible=false, paused=false, quitting=false;
let metrics: Record<string,unknown>={}, timer: NodeJS.Timeout, settingsPath='', saving=false;
let shortcut='',shortcutError='';
let displayTimer:ReturnType<typeof setTimeout>;
let preferredDisplay:Settings['display']|undefined;
const isSmoke=process.argv.includes('--smoke-test');
const isBenchmark=process.argv.includes('--benchmark');
const smokeStep=(step:string)=>{if(isSmoke&&process.env.DANMAKU_SMOKE_OUTPUT)appendFileSync(process.env.DANMAKU_SMOKE_OUTPUT+'.progress.txt',step+'\n');};
if(isSmoke&&process.env.WANDER_SMOKE_PROFILE)app.setPath('userData',process.env.WANDER_SMOKE_PROFILE);
const displays=():DisplayInfo[]=>screen.getAllDisplays().map(d=>({id:String(d.id),label:d.label||`显示器 ${d.id}`,primary:d.id===screen.getPrimaryDisplay().id,scaleFactor:d.scaleFactor,bounds:d.bounds}));
const snapshot=():Snapshot=>({settings,displays:displays(),status:{...runtime.state,error:runtime.state.error||shortcutError},visible,paused,cardVisible,metrics});
function publish() { if(control&&!control.isDestroyed()) control.webContents.send('state',snapshot()); }
function overlayEvent(type:string,extra:Record<string,unknown>={}) { if(overlay&&!overlay.isDestroyed()) overlay.webContents.send('overlay',{type,settings,visible,paused,cardRect:cardVisible?cardRect:undefined,...extra}); }
function cardEvent(){if(cardWindow&&!cardWindow.isDestroyed())cardWindow.webContents.send('overlay',{type:'card',settings,cardVisible,cardData});}
function hideCard(){cardRequest++;cardVisible=false;cardWindow?.hide();cardEvent();overlayEvent('obstacle');publish();}
async function showCard(){
  const config=settings.joinCards[settings.source.groupId];if(!config?.imageId)throw Error('请先为当前群导入二维码并保存');
  if(!target())throw Error('请先选择显示器');
  const ticket=++cardRequest,group=settings.source.groupId,display=settings.display.targetId;
  const data=await mediaStore.card(config.imageId);
  if(ticket!==cardRequest||settings.source.groupId!==group||settings.display.targetId!==display||settings.joinCards[group]?.imageId!==config.imageId) return;
  cardData=data;cardVisible=true;place();positionCard();cardEvent();cardWindow.showInactive();overlayEvent('obstacle');publish();
}
function target() { return displays().find(d=>d.id===settings.display.targetId); }
function adaptDisplay(){
  clearTimeout(displayTimer);displayTimer=setTimeout(()=>{
    const selected=chooseDisplay(displays(),preferredDisplay||settings.display);if(!selected){overlay.hide();cardWindow.hide();return;}
    settings.display.targetId=selected.id;settings.display.targetHint={label:selected.label,width:selected.bounds.width,height:selected.bounds.height};
    place();positionCard();if(visible)overlay.showInactive();if(cardVisible)cardWindow.showInactive();
    overlayEvent('state');cardEvent();publish();
  },600);
}
function place() {
  const d=target(); if(!d){hide(); return false;}
  overlay.setBounds({...d.bounds,height:Math.max(1,Math.round(d.bounds.height*settings.display.topRatio))}); return true;
}
function positionCard(){
  const d=target(),c=settings.joinCards[settings.source.groupId];if(!d||!c||!cardVisible)return;
  const width=Math.min(c.widthDip,d.bounds.width-16),lines=(text:string,size:number)=>text?text.split('\n').reduce((n,s)=>n+Math.max(1,Math.ceil(s.length/Math.max(1,Math.floor((width-36)/size)))),0):0;
  const height=Math.min(Math.ceil(width+42+lines(c.title,17)*24+lines(c.description,13)*20),d.bounds.height-16),margin=Math.min(c.marginDip,Math.max(8,(d.bounds.height-height)/2),Math.max(8,(d.bounds.width-width)/2));
  const x=c.position.endsWith('Right')?d.bounds.width-width-margin:margin,y=c.position.startsWith('bottom')?d.bounds.height-height-margin:margin;
  cardRect={x,y,width,height};cardWindow.setBounds({x:d.bounds.x+x,y:d.bounds.y+y,width,height});cardWindow.setIgnoreMouseEvents(true);cardWindow.setAlwaysOnTop(true,'screen-saver');
}
function hide() { visible=false; paused=false;hideCard(); if(overlay&&!overlay.isDestroyed()){overlayEvent('clear');overlay.hide();} publish(); }
function show() {
  if(!settings.source.groupId) throw new Error('请先保存目标群号');
  if(!place()) throw new Error('请选择当前连接的显示器');
  visible=true; overlay.setIgnoreMouseEvents(true); overlay.setAlwaysOnTop(true,'screen-saver'); overlay.showInactive(); overlayEvent('state'); publish();
}
function registerShortcut(next:string) {
  if(next===shortcut) return;
  if(!globalShortcut.register(next,()=>{try { visible||cardVisible?hide():show(); }catch{control.show();}})) throw new Error('快捷键已被占用，请更换组合');
  if(shortcut) globalShortcut.unregister(shortcut); shortcut=next;shortcutError='';
}
async function save(value:unknown) {
  if(saving) throw new Error('设置正在保存，请稍后重试'); saving=true;
  try {
    const next=validateSettings(value);
    if(next.source.groupId) next.source.recentGroups=[next.source.groupId,...next.source.recentGroups.filter(g=>g!==next.source.groupId)].slice(0,10);
    const display=displays().find(d=>d.id===next.display.targetId);
    if(display) next.display.targetHint={label:display.label,width:display.bounds.width,height:display.bounds.height};
    const previous=shortcut;if(shortcut||next.behavior.toggleShortcut!==settings.behavior.toggleShortcut)registerShortcut(next.behavior.toggleShortcut);
    try { await writeFile(`${settingsPath}.tmp`,JSON.stringify(next,null,2)); await rename(`${settingsPath}.tmp`,settingsPath); }
    catch(e){if(shortcut!==previous){if(previous)registerShortcut(previous);else {globalShortcut.unregister(shortcut);shortcut='';}}throw e;}
    const reset=next.source.groupId!==settings.source.groupId||next.display.targetId!==settings.display.targetId;
    const cardChanged=JSON.stringify(next.joinCards[next.source.groupId])!==JSON.stringify(settings.joinCards[settings.source.groupId]);
    if(next.display.targetId!==settings.display.targetId)preferredDisplay=structuredClone(next.display);
    settings=next; if(reset){hideCard();overlayEvent('clear');}else if(cardChanged)hideCard();place();positionCard();overlayEvent('state');publish();
  } finally {saving=false;}
}
function assertSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, onlyControl=false) {
  const trusted=event.sender===control?.webContents||(!onlyControl&&event.sender===overlay?.webContents);
  if(!trusted||event.senderFrame!==event.sender.mainFrame) throw new Error('不允许的窗口请求');
}
const commands=new Set<Command>(['show','hide','toggle','pause','clear','test','start','build','stop','qr','refreshLogin','identify','quit','showCard','hideCard','test66','test100','testMedia']);
async function command(name:Command) {
  if(!commands.has(name))throw new Error('未知操作');
  switch(name){
    case 'show':show();break;
    case 'hide':hide();break;
    case 'toggle':visible||cardVisible?hide():show();break;
    case 'pause':paused=!paused;overlayEvent('pause');publish();break;
    case 'clear':overlayEvent('clear');break;
    case 'test':if(!visible)throw new Error('请先开始投屏');overlayEvent('test',{packet:{text:'本地测试 · 欢迎来到wander弹幕',sender:'本地测试'}});break;
    case 'test66':case 'test100':if(!visible)throw Error('请先开始投屏');overlayEvent('test',{packet:{text:'本地测试 · 好耶！'},count:name==='test66'?66:100});break;
    case 'testMedia':if(!visible)throw Error('请先开始投屏');{const data=await control.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#006534';x.fillRect(0,0,100,100);x.fillStyle='white';x.font='bold 42px sans-serif';x.fillText('Hi!',18,65);return c.toDataURL()})()`);overlayEvent('test',{packet:{text:'本地图文测试',segments:[{type:'text',text:'本地图文测试 '},{type:'image',mediaId:'local-preview',url:''}]},media:decodeMedia(Buffer.from(data.split(',')[1],'base64'))});}break;
    case 'showCard':return showCard();
    case 'hideCard':hideCard();break;
    case 'identify':if(!place())throw new Error('请先选择显示器');overlay.showInactive();overlayEvent('identify',{label:`${target()?.label} · 顶部 ${Math.round(settings.display.topRatio*100)}%`});setTimeout(()=>{overlayEvent('clear');if(!visible)overlay.hide();},1800);break;
    case 'start':case 'build':await runtime.configureAccount(settings.source.account,settings.aggregation.enabled);await runtime.operation(name==='build');break;
    case 'stop':hide();await runtime.stop();break;
    case 'qr':return runtime.qr(path.join(app.getPath('temp'),'danmaku-login.png'));
    case 'refreshLogin':return runtime.refreshLogin(path.join(app.getPath('temp'),'danmaku-login.png'));
    case 'quit':quitting=true;app.quit();break;
  }
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{control?.show();control?.focus();});
  app.whenReady().then(async()=>{
    smokeStep('ready');
    settingsPath=path.join(app.getPath('userData'),'settings.json');
    mediaStore=new MediaStore(path.join(app.getPath('userData'),'join-cards'));
    // Copy only settings on the first branded launch; leave the old profile intact.
    const legacySettings=path.join(app.getPath('appData'),'元火弹幕投屏','settings.json');
    if(!existsSync(settingsPath)&&existsSync(legacySettings))await copyFile(legacySettings,settingsPath);
    const bundledProject=path.join(process.resourcesPath,'server');
    const validProject=(directory:string)=>['Cargo.toml','docker-compose.yml'].every(file=>existsSync(path.join(directory,file)));
    // A portable distribution launched with electron.exe may report isPackaged=false.
    // Detect the bundled server itself instead of relying on that flag.
    let project=process.env.DANMAKU_PROJECT_DIR||(validProject(bundledProject)?bundledProject:path.resolve(__dirname,'../../danmaku-server-master/danmaku-server-master'));
    if(!validProject(project)) {
      const chosen=await dialog.showOpenDialog({title:'选择包含 docker-compose.yml 的弹幕服务目录',properties:['openDirectory']});
      if(chosen.canceled){app.quit();return;} project=chosen.filePaths[0];
      if(!validProject(project)){dialog.showErrorBox('服务目录不完整','所选目录必须同时包含 Cargo.toml 和 docker-compose.yml。请完整解压便携包，或选择工程中的 danmaku-server-master\\danmaku-server-master。');app.quit();return;}
    }
    try{const loaded=JSON.parse(await readFile(settingsPath,'utf8'));settings=validateSettings(loaded);if(loaded.schemaVersion===1&&!existsSync(`${settingsPath}.v1-backup`))await copyFile(settingsPath,`${settingsPath}.v1-backup`);}catch(e){
      if(existsSync(settingsPath))await copyFile(settingsPath,`${settingsPath}.invalid-${Date.now()}`).catch(()=>{});
      const env=await readFile(path.join(project,'.env'),'utf8').catch(()=>'');
      settings.source.account=env.match(/^ACCOUNT=(\d+)/m)?.[1]||'';
      try{settings.source.groupId=JSON.parse(readFileSync(path.join(project,'napcat/.deploy.json'),'utf8')).group||'';}catch{}
      const second=displays().find(d=>!d.primary);if(second)settings.display.targetId=second.id;
    }
    preferredDisplay=structuredClone(settings.display);
    const initialDisplay=chooseDisplay(displays(),settings.display);if(initialDisplay)settings.display.targetId=initialDisplay.id;
    runtime=new Runtime(project,publish);
    await runtime.reuseActiveProject();
    smokeStep('runtime ready');
    const webPreferences={preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true};
    const work=screen.getPrimaryDisplay().workArea,cw=Math.min(1120,work.width),ch=Math.min(850,work.height);
    control=new BrowserWindow({x:Math.round(work.x+(work.width-cw)/2),y:Math.round(work.y+(work.height-ch)/2),width:cw,height:ch,minWidth:Math.min(840,cw),minHeight:Math.min(650,ch),title:'wander · 弹幕投屏',backgroundColor:'#f5f6f0',webPreferences});
    overlay=new BrowserWindow({width:800,height:200,show:false,frame:false,transparent:true,focusable:false,skipTaskbar:true,resizable:false,hasShadow:false,webPreferences:{...webPreferences,backgroundThrottling:false}});
    cardWindow=new BrowserWindow({width:240,height:392,show:false,frame:false,transparent:true,focusable:false,skipTaskbar:true,resizable:false,hasShadow:false,webPreferences});
    cardWindow.setIgnoreMouseEvents(true);cardWindow.setAlwaysOnTop(true,'screen-saver');
    overlay.setIgnoreMouseEvents(true);overlay.setAlwaysOnTop(true,'screen-saver');
    for(const window of [control,overlay,cardWindow]){
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      window.webContents.on('will-navigate',event=>event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    }
    control.on('close',e=>{if(!quitting){e.preventDefault();control.hide();}});
    ipcMain.handle('snapshot',event=>{assertSender(event);return snapshot();});
    ipcMain.handle('save',(event,value)=>{assertSender(event,true);return save(value);});
    ipcMain.handle('command',(event,value)=>{assertSender(event,true);return command(value);});
    ipcMain.handle('importCard',async event=>{assertSender(event,true);const picked=await dialog.showOpenDialog(control,{title:'导入 QQ 群二维码图片',filters:[{name:'静态图片',extensions:['png','jpg','jpeg','webp']}],properties:['openFile']});return picked.canceled?null:mediaStore.importFile(picked.filePaths[0]);});
    ipcMain.handle('cardImage',(event,id)=>{assertSender(event,true);return mediaStore.card(id);});
    ipcMain.handle('media',(event,segment)=>{assertSender(event);if(event.sender!==overlay.webContents)throw Error('仅投影层可读取消息媒体');return mediaStore.get(segment);});
    ipcMain.on('metrics',(event,value)=>{assertSender(event);if(event.sender!==overlay.webContents)return;if(value&&JSON.stringify(value).length<20000){metrics={...value,mediaTransport:{...mediaStore.stats}};publish();}});
    await control.loadFile(path.join(__dirname,'control.html'));
    smokeStep('control loaded');
    await overlay.loadFile(path.join(__dirname,'overlay.html'));overlayEvent('state');
    await cardWindow.loadFile(path.join(__dirname,'card.html'));cardEvent();
    smokeStep('overlays loaded');
    try{registerShortcut(settings.behavior.toggleShortcut);}catch(e){shortcutError=`显示/隐藏快捷键不可用：${String(e)}。可以更换组合，或使用托盘紧急隐藏。`;publish();}
    // Windows tray uses a PNG generated from Chromium, avoiding external icon dependencies.
    const icon=await control.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');x.fillStyle='#006534';x.fillRect(0,0,32,32);x.fillStyle='white';x.font='bold 28px sans-serif';x.fillText('w',4,25);return c.toDataURL()})()`);
    const brandIcon=nativeImage.createFromDataURL(icon);control.setIcon(brandIcon);
    tray=new Tray(brandIcon);tray.setToolTip('wander · 弹幕投屏');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'打开控制面板',click:()=>control.show()},{label:'隐藏弹幕',click:hide},{label:'清空弹幕',click:()=>overlayEvent('clear')},{type:'separator'},{label:'退出客户端（保留服务）',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',()=>control.show());
    screen.on('display-removed',adaptDisplay);
    screen.on('display-added',adaptDisplay);screen.on('display-metrics-changed',adaptDisplay);
    powerMonitor.on('suspend',hide);powerMonitor.on('resume',()=>{overlayEvent('clear');void runtime.refresh();});
    timer=setInterval(()=>void runtime.refresh(),4000);void runtime.refresh();
    if(!settings.behavior.startHidden&&target()&&settings.source.groupId)show();
    if(isSmoke){
      smokeStep('smoke scheduled');
      setTimeout(async()=>{
        const out=process.env.DANMAKU_SMOKE_OUTPUT||path.join(app.getPath('temp'),'danmaku-smoke.json');
        const {runSmoke}=await import('./smoke');
        smokeStep('smoke started');
        try{await runSmoke({control,overlay,cardWindow,mediaStore,settings,runtime,save,command,snapshot,out});}catch(e){await writeFile(out,JSON.stringify({error:String(e),stack:e instanceof Error?e.stack:undefined},null,2));process.exitCode=1;}finally{quitting=true;app.quit();}
      },10000);
    }
    if(isBenchmark){
      setTimeout(async()=>{
        const out=process.env.DANMAKU_BENCHMARK_OUTPUT||path.join(app.getPath('temp'),'danmaku-benchmark.json');
        try{const {runBenchmark}=await import('./benchmark');await runBenchmark({overlay,settings,runtime,save,command,snapshot,out});}
        catch(e){await writeFile(out,JSON.stringify({error:String(e)},null,2));process.exitCode=1;}
        finally{quitting=true;app.quit();}
      },10000);
    }
  }).catch(err=>{dialog.showErrorBox('客户端启动失败',String(err));app.quit();});
}
app.on('before-quit',()=>{quitting=true;clearInterval(timer);globalShortcut.unregisterAll();if(overlay&&!overlay.isDestroyed())overlay.destroy();if(cardWindow&&!cardWindow.isDestroyed())cardWindow.destroy();tray?.destroy();});
