import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require=createRequire(import.meta.url);
const electronPath=require('electron');
const root=path.resolve(process.env.WANDER_PACKAGE_DIR||'release/wander');
if(process.platform==='win32'){
  const running=execFileSync('powershell.exe',['-NoProfile','-Command',"$target=$env:WANDER_PACKAGE_EXE; @(Get-CimInstance Win32_Process -Filter \"name='electron.exe'\" | Where-Object { $_.ExecutablePath -eq $target }).Count"],{windowsHide:true,encoding:'utf8',env:{...process.env,WANDER_PACKAGE_EXE:path.join(root,'electron.exe')}}).trim();
  if(Number(running)>0){console.error('wander 正在运行，Windows 会锁定运行库。请在系统托盘选择“退出客户端（保留服务）”，然后重新运行 npm.cmd run package。关闭面板不会退出客户端。');process.exit(1);}
}
await mkdir(root,{recursive:true});
await cp(path.dirname(electronPath),root,{recursive:true});
const app=path.join(root,'resources/app');await mkdir(app,{recursive:true});
await cp('dist',path.join(app,'dist'),{recursive:true});
const pkg=JSON.parse(await readFile('package.json','utf8'));
await writeFile(path.join(app,'package.json'),JSON.stringify({name:pkg.name,productName:pkg.productName,version:pkg.version,main:'dist/main.cjs'}));
const server=path.join(root,'resources/server');await mkdir(server,{recursive:true});
try {await access(path.join(server,'napcat'));throw new Error('打包目录含运行数据，请先选择未使用的干净分发目录。');}catch(e){if(e.code!=='ENOENT')throw e;}
const source=path.resolve('../danmaku-server-master/danmaku-server-master');
// Explicit allowlist. Never copy napcat runtime data, .env, credentials or node_modules.
for(const item of ['src','assets','Cargo.toml','Cargo.lock','build.rs','Dockerfile','.dockerignore','onebot.template.json','README.md','LICENSE'])await cp(path.join(source,item),path.join(server,item),{recursive:true});
await mkdir(path.join(server,'frontend'),{recursive:true});
for(const item of ['package.json','yarn.lock','index.html','client.html','.dockerignore','.yarnrc.yml'])await cp(path.join(source,'frontend',item),path.join(server,'frontend',item));
await cp(path.join(source,'docker-compose.yml'),path.join(server,'docker-compose.yml'));
await writeFile(path.join(server,'.env'),'ACCOUNT=\nRUST_LOG=info\nDANMAKU_DEDUP_WINDOW=-1\n');
await writeFile(path.join(root,'启动弹幕投屏.bat'),'@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\nstart "" "%~dp0electron.exe"\r\n','utf8');
await mkdir(path.join(root,'installer'),{recursive:true});
// Windows PowerShell 5.1 requires a BOM for UTF-8 Chinese source files.
await writeFile(path.join(root,'installer/first-install.ps1'),'\uFEFF'+(await readFile('scripts/first-install.ps1','utf8')).replace(/^\uFEFF/,'').replace(/\r?\n/g,'\r\n'));
await writeFile(path.join(root,'首次安装.bat'),(await readFile('scripts/first-install.bat','utf8')).replace(/\r?\n/g,'\r\n'));
await cp('../README.md',path.join(root,'README.md'));
await cp('../README.md',path.join(root,'使用说明.md'));
await cp('docs',path.join(root,'docs'),{recursive:true});
await cp('node_modules/preact/LICENSE',path.join(root,'PREACT-LICENSE'));
await cp('node_modules/omggif/README',path.join(root,'OMGGIF-LICENSE-AND-README'));
await cp('node_modules/pngjs/LICENSE',path.join(root,'PNGJS-LICENSE'));
const installerAssets=process.env.WANDER_INSTALLERS_DIR;
if(installerAssets)await cp(installerAssets,path.join(root,'installers'),{recursive:true});
try{await access('artifacts/wander-server-0.3.0.tar');await cp('artifacts/wander-server-0.3.0.tar',path.join(root,'wander-server-0.3.0.tar'));}catch(e){if(e.code!=='ENOENT')throw e;}
const manifest={version:pkg.version,electron:pkg.devDependencies.electron,createdAt:new Date().toISOString(),serverDataIncluded:false};
await writeFile(path.join(root,'版本信息.json'),JSON.stringify(manifest,null,2));
console.log(`Portable Windows app: ${root}`);
