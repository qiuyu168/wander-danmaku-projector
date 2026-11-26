import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, copyFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Status } from '../shared/api';

export class Runtime {
  docker = ''; project: string;
  state: Status = { docker: '检查中', server: '检查中', onebotConnected: false, qqOnline: null, account: '', error: '', busy: false, logs: [] };
  private polling = false;
  private configChanged=false;
  private accountChanged=false;
  private lastLoginRefresh=0;
  constructor(project: string, private changed: () => void) { this.project = project; }
  async reuseActiveProject(){
    try{
      if(!this.docker)await this.locate();
      const [container]=JSON.parse(await this.run(['inspect','danmaku-server'],5000));
      const labels=container.Config?.Labels||{},directory=labels['com.docker.compose.project.working_dir'];
      if(labels['com.docker.compose.project']==='danmaku-server'&&typeof directory==='string'&&['Cargo.toml','docker-compose.yml','onebot.template.json'].every(file=>existsSync(path.join(directory,file)))){
        if(path.resolve(directory)!==path.resolve(this.project)){this.project=directory;this.log('复用已部署的后台目录，避免切换 QQ 数据目录导致重新登录');}
      }
    }catch{/* No existing deployment: use the bundled/default service. */}
  }
  log(text: string) { this.state.logs.push(`${new Date().toLocaleTimeString()} ${text.slice(0,1600)}`); this.state.logs = this.state.logs.slice(-30); this.changed(); }
  run(args: string[], timeout = 15000): Promise<string> {
    return new Promise((resolve,reject) => execFile(this.docker,args,{ cwd: this.project, windowsHide: true, timeout, maxBuffer: 2*1024*1024 },(err,stdout,stderr) => err ? reject(new Error((stderr || err.message).slice(0,1200))) : resolve(stdout.trim())));
  }
  async locate() {
    const candidates = ['docker.exe', path.join(process.env.ProgramFiles || '', 'Docker/Docker/resources/bin/docker.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs/DockerDesktop/resources/bin/docker.exe')];
    const registry = await new Promise<string>(resolve => execFile('reg.exe',['query','HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop','/v','InstallLocation'],{windowsHide:true},(_e,out) => resolve(out || '')));
    const install = registry.match(/InstallLocation\s+REG_SZ\s+(.+)/)?.[1]?.trim();
    if (install) candidates.unshift(path.join(install,'resources/bin/docker.exe'));
    for (const candidate of candidates) {
      this.docker = candidate;
      try { await this.run(['--version'],5000); return; } catch { /* next location */ }
    }
    this.docker = ''; throw new Error('没有找到 Docker Desktop，请先安装或修复 Docker。');
  }
  async refresh() {
    if (this.polling || this.state.busy) return;
    this.polling = true;
    try {
      if (!this.docker) await this.locate();
      try { await this.run(['info','--format','{{.ServerVersion}}'],6000); } catch { this.state.docker = '未运行'; this.state.server='未连接'; this.state.onebotConnected=false; this.state.qqOnline=null; this.changed(); return; }
      this.state.docker = '运行中';
      this.state.error = '';
      const running = await this.run(['compose','ps','--format','json'],8000);
      const containers = running.startsWith('[') ? JSON.parse(running) : running.split('\n').filter(Boolean).map(v=>JSON.parse(v));
      this.state.server = containers.some((v: any)=>v.Service==='danmaku-server' && v.State==='running') ? '运行中' : '未启动';
      this.state.onebotConnected=false; this.state.qqOnline=null; this.state.account=''; this.state.backend=undefined;
      if (this.state.server==='运行中') {
        try {
          const status=JSON.parse(await this.run(['compose','exec','-T','danmaku-server','wget','-qO-','http://127.0.0.1:5099/status'],6000));
          this.state.backend=status; this.state.onebotConnected=!!status.onebotConnected;
          this.state.qqOnline=status.qqOnline ?? null; this.state.account=status.account || '';
          if(status.qqOnline===false)this.state.error='QQ 已掉线，请先在手机 QQ 完成安全认证。程序不会自动反复重启 QQ；认证完成后等待连接恢复，必要时再刷新登录。';
          else if(!status.onebotConnected)this.state.error='QQ 接入尚未连接：可能正在登录或重连。已登录时请先等待，避免连续刷新登录。';
        } catch { this.state.error='服务缺少诊断接口或尚未就绪；可使用“构建 / 更新服务”。'; }
      }
    } catch(err) { this.state.error=String(err); this.state.docker=this.docker?'连接失败':'未安装'; this.state.server='未连接'; this.state.onebotConnected=false;this.state.qqOnline=null;this.state.account='';this.state.backend=undefined; }
    finally { this.polling=false; this.changed(); }
  }
  async operation(build = false) {
    if(this.state.busy) throw new Error('已有服务操作正在执行');
    this.state.busy=true; this.state.error=''; this.changed();
    let failure='';
    try {
      if (!this.docker) await this.locate();
      try { await this.run(['info'],5000); } catch {
        this.log('正在启动 Docker Desktop');
        await this.run(['desktop','start'],180000);
        await this.run(['info'],15000);
      }
      const runLive=(args:string[])=>new Promise<void>((resolve,reject)=>{
        const child=spawn(this.docker,args,{cwd:this.project,windowsHide:true});
        let tail='';
        const record=(chunk: Buffer)=>{ tail=(tail+chunk.toString()).slice(-2000); this.log(chunk.toString().replace(/\x1b\[[0-9;]*m/g,'').trim()); };
        child.stdout.on('data',record); child.stderr.on('data',record);
        child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(new Error(`启动失败 (${code})：${tail}`)));
      });
      if(build)await runLive(['compose','build','danmaku-server']);
      await runLive(['compose','up','-d','--no-deps','danmaku-server']);
      await runLive(['compose','up','-d',...(this.accountChanged?[]:['--no-recreate']),'napcat']);
      // Apply OneBot config changes only once, never restart on every Start click.
      if(this.configChanged&&!this.accountChanged)await this.run(['compose','restart','napcat'],30000);
      this.configChanged=false;this.accountChanged=false;
      this.log('本项目服务已启动');
    } catch(err) { failure=String(err); throw err; }
    finally { this.state.busy=false; await this.refresh(); if(failure){this.state.error=failure;this.log(failure);} }
  }
  async stop() { if(this.state.busy) throw new Error('请等待当前操作完成'); await this.run(['compose','stop'],60000); await this.refresh(); }
  async configureAccount(account: string, aggregation=false) {
    if(!/^\d{5,20}$/.test(account)) throw new Error('请输入正确的 QQ 账号');
    const envPath=path.join(this.project,'.env');
    const before=await readFile(envPath,'utf8').catch(()=> 'RUST_LOG=info\nDANMAKU_DEDUP_WINDOW=-1\n');
    this.accountChanged=!!before.match(/^ACCOUNT=(\d+)/m)&&before.match(/^ACCOUNT=(\d+)/m)![1]!==account;
    let after=/^ACCOUNT=/m.test(before)?before.replace(/^ACCOUNT=.*$/m,`ACCOUNT=${account}`):`ACCOUNT=${account}\n${before}`;
    if(aggregation){
      if(/^DANMAKU_DEDUP_WINDOW=(?!-1\s*$)/m.test(after))this.log('启用聚合：关闭服务端按内容丢弃，以保留真实重复消息计数');
      after=/^DANMAKU_DEDUP_WINDOW=/m.test(after)?after.replace(/^DANMAKU_DEDUP_WINDOW=.*$/m,'DANMAKU_DEDUP_WINDOW=-1'):`${after}\nDANMAKU_DEDUP_WINDOW=-1\n`;
    }
    const configPath=path.join(this.project,`napcat/config/onebot11_${account}.json`);
    const { mkdir }=await import('node:fs/promises'); await mkdir(path.dirname(configPath),{recursive:true});
    const original=await readFile(configPath,'utf8').catch(()=>'{"network":{}}');
    const config=JSON.parse(original);
    const template=JSON.parse(await readFile(path.join(this.project,'onebot.template.json'),'utf8'));
    config.network ??= {}; config.network.websocketClients ??= [];
    const target=config.network.websocketClients.find((v:any)=>v.name==='danmaku');
    if(target) Object.assign(target,template.network.websocketClients[0]); else config.network.websocketClients.push(template.network.websocketClients[0]);
    if(JSON.stringify(config)!==JSON.stringify(JSON.parse(original))){
      if(existsSync(configPath)) await copyFile(configPath,`${configPath}.bak`);
      await writeFile(configPath,JSON.stringify(config,null,2));this.configChanged=true;
    }
    if(after!==before) { if(existsSync(envPath)) await copyFile(envPath,`${envPath}.bak`); await writeFile(envPath,after); }
  }
  async refreshLogin(tempPath:string) {
    await this.refresh();
    if(this.state.qqOnline)throw new Error('QQ 已在线，无需刷新登录');
    if(this.state.busy)throw new Error('请等待服务操作完成');
    if(Date.now()-this.lastLoginRefresh<120000)throw new Error('刚刷新过登录，请等待至少 2 分钟；可点击“显示登录二维码”使用现有码，避免频繁登录触发认证。');
    this.lastLoginRefresh=Date.now();
    this.state.busy=true;this.changed();
    try {
      const previous=await this.run(['compose','exec','-T','napcat','stat','-c','%Y','/app/napcat/cache/qrcode.png']).catch(()=>'');
      await this.run(['compose','restart','napcat'],30000);
      this.log('QQ 已重启，正在等待新的登录二维码……');
      const deadline=Date.now()+90000;
      while(Date.now()<deadline){
        await new Promise(r=>setTimeout(r,2000));
        try {
          const stamp=await this.run(['compose','exec','-T','napcat','stat','-c','%Y','/app/napcat/cache/qrcode.png'],5000);
          if(stamp&&stamp!==previous)return await this.qr(tempPath);
        }catch { /* QQ initialization has not produced a readable image yet. */ }
      }
      throw new Error('QQ 尚未生成新二维码。请检查网络及 QQ 启动日志，稍后点击“显示登录二维码”；WSL 正常时无需重复安装环境。');
    }finally{this.state.busy=false;await this.refresh();}
  }
  async qr(tempPath: string) {
    if(this.state.qqOnline) throw new Error('QQ 已在线，无需扫码');
    const seconds=Number(await this.run(['compose','exec','-T','napcat','stat','-c','%Y','/app/napcat/cache/qrcode.png']));
    const remaining=110000-(Date.now()-seconds*1000);
    if(!Number.isFinite(remaining)||remaining<=0) throw new Error('二维码已过期，请刷新登录二维码');
    await this.run(['compose','cp','napcat:/app/napcat/cache/qrcode.png',tempPath]);
    try {
      if((await stat(tempPath)).size>1024*1024) throw new Error('二维码文件异常');
      return { data:`data:image/png;base64,${(await readFile(tempPath)).toString('base64')}`, expiresAt:Date.now()+remaining };
    } finally {await unlink(tempPath).catch(()=>{});}
  }
}
