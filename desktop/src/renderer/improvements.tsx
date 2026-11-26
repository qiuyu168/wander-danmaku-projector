import { useEffect,useState } from 'preact/hooks';
import { defaultCard,type Settings } from '../shared/settings';
import type { Snapshot,Command } from '../shared/api';

export function Improvements({draft,state,change,command}:{draft:Settings;state:Snapshot;change:(s:Settings)=>void;command:(c:Command)=>Promise<void>}){
  const group=draft.source.groupId,card=draft.joinCards[group]||defaultCard;
  const [image,setImage]=useState(''),[error,setError]=useState(''),[preview,setPreview]=useState(0),[threshold,setThreshold]=useState(draft.aggregation.milestones.join(', '));
  useEffect(()=>{let alive=true;setImage('');if(card.imageId)window.desktop.cardImage(card.imageId).then(data=>{if(alive)setImage(data);}).catch(()=>{if(alive)setError('二维码图片丢失，请重新导入');});return()=>{alive=false;};},[group,card.imageId]);
  useEffect(()=>setThreshold(draft.aggregation.milestones.join(', ')),[draft.aggregation.milestones.join(',')]);
  function update(section:'media'|'aggregation'|'moderation',key:string,value:unknown){const next=structuredClone(draft);(next[section] as any)[key]=value;change(next);}
  function updateCard(key:string,value:unknown){if(!/^\d{1,20}$/.test(group)){setError('请先填写目标 QQ 群号');return;}const next=structuredClone(draft);next.joinCards[group]={...card,[key]:value};change(next);}
  async function importImage(){setError('');if(!/^\d{1,20}$/.test(group)){setError('请先填写目标 QQ 群号');return;}try{const result=await window.desktop.importCard();if(result){updateCard('imageId',result.id);setImage(result.data);}}catch(e){setError(String(e));}}
  function applyThresholds(){const list=threshold.split(/[,，\s]+/).filter(Boolean).map(Number);if(list.length>8||list.some(n=>!Number.isInteger(n)||n<2||n>9999)||new Set(list).size!==list.length){setError('阈值需为 2～9999 的不重复整数，最多 8 个');return;}list.sort((a,b)=>a-b);setError('');update('aggregation','milestones',list);}
  return <>
    <section class="card improvements"><h2><b>04</b> 入群展示卡 <small>图片与文字按群保存</small></h2>
      {error&&<div class="error" role="alert">{error}</div>}
      <div class="join-grid"><div>
        <div class="buttons"><button onClick={()=>void importImage()}>导入 / 更换二维码图片</button><button disabled={!card.imageId} onClick={()=>updateCard('imageId',null)}>移除图片</button></div>
        <p class="hint">从 QQ 保存加群二维码后导入 PNG、JPEG 或 WebP。此处与账号登录二维码不同。</p>
        <label>自定义标题<input maxLength={40} value={card.title} onInput={e=>updateCard('title',e.currentTarget.value)}/></label>
        <label>自定义说明<textarea rows={3} maxLength={160} value={card.description} onInput={e=>updateCard('description',e.currentTarget.value)}/></label>
        <div class="style-grid"><label>位置<select value={card.position} onChange={e=>updateCard('position',e.currentTarget.value)}><option value="bottomRight">右下角</option><option value="bottomLeft">左下角</option><option value="topRight">右上角</option><option value="topLeft">左上角</option></select></label><label>卡片宽度 <em>{card.widthDip} DIP</em><input type="range" min="180" max="360" value={card.widthDip} onInput={e=>updateCard('widthDip',+e.currentTarget.value)}/></label><label>屏幕边距 <em>{card.marginDip} DIP</em><input type="range" min="8" max="100" value={card.marginDip} onInput={e=>updateCard('marginDip',+e.currentTarget.value)}/></label></div>
        <div class="buttons"><button class="primary" disabled={!card.imageId} onClick={()=>void command('showCard')}>显示到投屏</button><button onClick={()=>void command('hideCard')}>隐藏展示卡</button><span class="hint">{state.cardVisible?'展示卡已显示':'展示卡已隐藏'}</span></div>
        <p class="hint">导入后不会自动上屏。快捷键紧急隐藏会同时关闭弹幕和展示卡。切群后需重新展示；二维码有效性与入群审批以 QQ 为准。</p>
      </div><div class="join-preview"><h3>{card.title}</h3>{image?<img src={image} alt="入群二维码本地预览"/>:<div class="qr-placeholder">导入你的群二维码</div>}<p>{card.description}</p><small>本地预览 · 不会自动投屏</small></div></div>
    </section>
    <section class="card"><h2><b>05</b> 表情包与图文弹幕</h2><div class="style-grid"><label class="check"><input type="checkbox" checked={draft.media.enabled} onChange={e=>update('media','enabled',e.currentTarget.checked)}/> 显示图片与 QQ 表情</label><label class="check"><input type="checkbox" checked={draft.media.animated} onChange={e=>update('media','animated',e.currentTarget.checked)}/> 播放 GIF 动画</label><label>同时播放动画上限<select value={draft.media.maxAnimatedOnScreen} onChange={e=>update('media','maxAnimatedOnScreen',+e.currentTarget.value)}>{[0,1,2,3,4,6,8,12,16].map(n=><option value={n}>{n} 个</option>)}</select></label></div><p class="hint">图片与文字按原消息顺序滚动，共用防碰撞轨道。超出动画上限显示静态首帧；加载失败显示替代文字。特殊 QQ 超级表情可能降级。</p><button onClick={()=>void command('testMedia')}>在投影上测试图文（不发送 QQ）</button></section>
    <section class="card"><h2><b>06</b> 重复聚合与互动</h2><div class="style-grid"><label class="check"><input type="checkbox" checked={draft.aggregation.enabled} onChange={e=>update('aggregation','enabled',e.currentTarget.checked)}/> 相同内容聚合为 ×N</label><label class="check"><input type="checkbox" checked={draft.aggregation.effectsEnabled} onChange={e=>update('aggregation','effectsEnabled',e.currentTarget.checked)}/> 启用里程碑炫彩</label><label class="check"><input type="checkbox" checked={draft.aggregation.reducedMotion} onChange={e=>update('aggregation','reducedMotion',e.currentTarget.checked)}/> 减少动态效果</label><label>聚合匹配窗口 <em>{draft.aggregation.windowMs/1000} 秒</em><input type="range" min="1" max="30" value={draft.aggregation.windowMs/1000} onInput={e=>update('aggregation','windowMs',+e.currentTarget.value*1000)}/></label><label>互动阈值（逗号分隔）<input value={threshold} onInput={e=>setThreshold(e.currentTarget.value)} onBlur={applyThresholds}/></label><div class="buttons"><button onClick={applyThresholds}>应用阈值</button></div></div><p class="hint">同群相同内容合并，计数代表消息条数，不代表人数。第一条立即发射，重复消息不延长等待期限或滚动时间。队列最多 50 个实体，准备后等待超过 500 ms 就丢弃。</p>
      <label>同内容开始合并的条数（2～100）<input type="number" min="2" max="100" value={draft.aggregation.startCount} onInput={e=>update('aggregation','startCount',+e.currentTarget.value)}/></label>
      <div class={'effect-preview '+(draft.aggregation.effectsEnabled&&preview&&!draft.aggregation.reducedMotion?'rainbow-preview':'')} key={preview}><span>好耶！</span><b>×{preview||1}</b></div><div class="buttons"><button onClick={()=>setPreview(66)}>本地预览 ×66</button><button onClick={()=>setPreview(100)}>本地预览 ×100</button><button onClick={()=>void command('test66')}>投影测试 ×66</button><button onClick={()=>void command('test100')}>投影测试 ×100</button></div>
      <p class="hint">同内容达到设定条数且轨道开始拥挤时，才合并后续消息。已上屏的独立弹幕继续滚动，×N 只统计本条实际合并的消息，避免重复计数；轨道空闲时优先独立显示。不同内容仍可能过期丢弃。</p>
      <details><summary>聚合与媒体诊断</summary><p>原始接收 {String(state.metrics.received??0)} · 新建实体 {String(state.metrics.created??0)} · 合并 {String(state.metrics.merged??0)} · 重投去重 {String(state.metrics.retried??0)} · 已代表消息 {String(state.metrics.represented??0)}</p><p>过期实体 {String(state.metrics.expired??0)} · 溢出实体 {String(state.metrics.overflow??0)} · 对应未展示消息 {String(state.metrics.droppedMessages??0)} · 媒体准备中 {String(state.metrics.preparing??0)} · 媒体就绪 {String(state.metrics.mediaReady??0)} · 加载失败/超时 {String(state.metrics.mediaFailed??0)}</p><p>特效播放 {String(state.metrics.effects??0)} · 静态降级 {String(state.metrics.effectDegraded??0)}</p><pre>{JSON.stringify(state.metrics.mediaTransport,null,2)}</pre></details>
    </section>
    <section class="card"><h2><b>07</b> 屏蔽关键词</h2>
      <label>关键词列表（一行一个）<textarea rows={7} value={draft.moderation.keywords.join('\n')} onInput={e=>update('moderation','keywords',e.currentTarget.value.split('\n'))} placeholder={'一行填写一个需要屏蔽的词\n例如：广告链接'}/></label>
      <p class="hint">点击底部“保存并应用”后立即生效，无需重启服务。消息包含任意关键词就整条屏蔽，图文消息中的文字也会检查；屏幕上及等待中的匹配弹幕会立即移除。清空列表并保存即可取消屏蔽。</p>
      <p class="hint">所有群共用此列表，重启后保留。按字面包含匹配，英文不区分大小写，全角英文也会匹配；不使用正则表达式。最多 500 个词，每词最多 80 字。不识别图片里的文字。</p>
      <p>本次连接已拦截新消息：<strong>{String(state.metrics.blocked??0)}</strong> 条</p>
    </section>
  </>;
}
