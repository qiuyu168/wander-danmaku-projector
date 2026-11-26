import { readFile,writeFile } from 'node:fs/promises';
const file=process.argv[2];if(!file)throw Error('Usage: node scripts/summarize-benchmark.mjs <report.json>');
const report=JSON.parse(await readFile(file,'utf8'));
const phases=['regular','burst','recovery','repeat100','repeat80percent'],result=[];
const percentile=(a,p)=>{if(!a.length)return null;const s=[...a].sort((a,b)=>a-b);return Math.round(s[Math.ceil(p*s.length)-1]*100)/100;};
let before=report.samples[0];
for(const phase of phases){
  const end=report.samples.find(s=>s.phase===phase);if(!end)continue;
  for(const key of ['baseline','current']){
    const v=end[key],old=before[key],waits=v.waits.slice(old.waits.length);
    result.push({phase,renderer:key,received:v.received-old.received,shown:v.shown-old.shown,p50:percentile(waits,.5),p95:percentile(waits,.95),p99:percentile(waits,.99),max:waits.length?Math.round(Math.max(...waits)*100)/100:null,...key==='current'?{expired:Number(end.metrics.expired)-Number(before.metrics.expired),overflow:Number(end.metrics.overflow)-Number(before.metrics.overflow)}:{}});
  }
  before=end;
}
const summary={state:report.state,bounds:report.bounds,results:result,final:report.samples.at(-1)};
await writeFile(file.replace(/\.json$/,'-summary.json'),JSON.stringify(summary,null,2));
console.table(result);
