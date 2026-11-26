import {cp,mkdir,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const source=path.resolve(process.env.WANDER_PACKAGE_DIR||'release/wander-0.3.0');
const target=path.resolve('release/wander-update-0.3.0'),payload=path.join(target,'payload');
await mkdir(payload,{recursive:true});
for(const name of ['resources/app','resources/server','docs','installer','README.md','使用说明.md','启动弹幕投屏.bat','首次安装.bat','版本信息.json','wander-server-0.3.0.tar']){
  await cp(path.join(source,name),path.join(payload,name),{recursive:true,filter:src=>!['.env','napcat','settings.json','join-cards'].includes(path.basename(src))});
}
for(const [src,dest] of [['scripts/update.ps1','update.ps1'],['scripts/update.bat','升级旧版.bat']]){
  const text=(await readFile(src,'utf8')).replace(/^\uFEFF/,'').replace(/\r?\n/g,'\r\n');
  await writeFile(path.join(target,dest),(dest.endsWith('.ps1')?'\uFEFF':'')+text);
}
const files=[];
async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const name=path.join(dir,item.name);if(item.isDirectory())await walk(name);else files.push({path:path.relative(payload,name).split(path.sep).join('/'),sha256:createHash('sha256').update(await readFile(name)).digest('hex').toUpperCase()});}}
await walk(payload);await writeFile(path.join(target,'manifest.json'),JSON.stringify({version:'0.3.0',electron:'45.3.1',files},null,2));
await writeFile(path.join(target,'升级说明.txt'),'1. 完整解压升级目录。\r\n2. 先从旧客户端系统托盘退出，再双击“升级旧版.bat”。\r\n3. 选择包含 electron.exe 的旧 wander 目录，保持 Docker 运行。\r\n4. 等待更新完成。无需重新下载 Docker、Electron 或 QQ 依赖；不删除登录数据和设置。\r\n5. 首次启用自身消息上报时 QQ 接入会重启一次，手机若要求认证请本人完成。\r\n升级包不含完整安装器；新电脑请用完整便携包。\r\n');
console.log(`Update payload: ${files.length} files, ${((await Promise.all(files.map(f=>stat(path.join(payload,f.path))))).reduce((n,s)=>n+s.size,0)/1024/1024).toFixed(1)} MiB`);
