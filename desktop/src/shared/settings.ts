export type JoinCard = { imageId: string | null; title: string; description: string; position: 'topLeft'|'topRight'|'bottomLeft'|'bottomRight'; widthDip: number; marginDip: number };
export const defaultCard: JoinCard = {imageId:null,title:'扫码加入互动',description:'',position:'bottomRight',widthDip:240,marginDip:24};
export type Settings = {
  schemaVersion: 2;
  source: { account: string; groupId: string; recentGroups: string[] };
  display: { targetId: string | null; topRatio: number; targetHint?: { label: string; width: number; height: number } };
  style: { colorMode: 'uniform' | 'palette'; color: string; palette: string[]; fontFamily: string; fontSize: number; speed: number; textOpacity: number; shadowEnabled: boolean };
  behavior: { startHidden: boolean; toggleShortcut: string; lowLatency: boolean };
  joinCards: Record<string,JoinCard>;
  media: {enabled:boolean;animated:boolean;maxAnimatedOnScreen:number};
  moderation: {keywords:string[]};
  aggregation: {enabled:boolean;windowMs:number;startCount:number;milestones:number[];effectsEnabled:boolean;reducedMotion:boolean};
};
export const defaults: Settings = {
  schemaVersion: 2, source: { account: '', groupId: '', recentGroups: [] },
  display: { targetId: null, topRatio: .25 },
  style: { colorMode: 'uniform', color: '#FFFFFF', palette: ['#FFFFFF','#FFE082','#80DEEA','#FFABCF','#B9F6CA'], fontFamily: 'Microsoft YaHei', fontSize: 40, speed: 144, textOpacity: 1, shadowEnabled: true },
  behavior: { startHidden: true, toggleShortcut: 'Ctrl+Alt+D', lowLatency: true },
  joinCards:{},media:{enabled:true,animated:true,maxAnimatedOnScreen:8},moderation:{keywords:[]},
  aggregation:{enabled:true,windowMs:10000,startCount:6,milestones:[66,100],effectsEnabled:true,reducedMotion:false}
};
export function validateSettings(value: unknown): Settings {
  const s = structuredClone(value) as Settings;
  if(s&&(s as any).schemaVersion===1){s.schemaVersion=2;s.joinCards={};s.media=structuredClone(defaults.media);s.aggregation=structuredClone(defaults.aggregation);}
  const fail = () => { throw new Error('设置格式或范围无效'); };
  const number = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const color = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  if (!s || s.schemaVersion !== 2 || !s.source || !s.display || !s.style || !s.behavior) return fail();
  if(s.moderation===undefined)s.moderation=structuredClone(defaults.moderation);
  if(!s.moderation||!Array.isArray(s.moderation.keywords)||s.moderation.keywords.length>500||!s.moderation.keywords.every(k=>typeof k==='string'&&k.length<=80))return fail();
  s.moderation.keywords=[...new Set(s.moderation.keywords.map(k=>k.trim()).filter(Boolean))];
  if (typeof s.source.account!=='string' || typeof s.source.groupId!=='string' || !/^\d{0,20}$/.test(s.source.account) || !/^\d{0,20}$/.test(s.source.groupId)) return fail();
  if (!Array.isArray(s.source.recentGroups) || s.source.recentGroups.length > 10 || !s.source.recentGroups.every(g => typeof g === 'string' && /^\d{1,20}$/.test(g))) return fail();
  if (s.display.targetId !== null && (typeof s.display.targetId !== 'string' || s.display.targetId.length > 100)) return fail();
  if (!number(s.display.topRatio,.1,.5) || !number(s.style.fontSize,16,96) || !number(s.style.speed,60,600) || !number(s.style.textOpacity,.1,1)) return fail();
  if (!['uniform','palette'].includes(s.style.colorMode) || !color(s.style.color) || !Array.isArray(s.style.palette) || !s.style.palette.length || s.style.palette.length > 12 || !s.style.palette.every(color)) return fail();
  if (typeof s.style.fontFamily !== 'string' || !s.style.fontFamily.trim() || s.style.fontFamily.length > 100 || /[<>;{}]/.test(s.style.fontFamily)) return fail();
  if (typeof s.style.shadowEnabled !== 'boolean' || typeof s.behavior.startHidden !== 'boolean' || typeof s.behavior.lowLatency !== 'boolean') return fail();
  if (typeof s.behavior.toggleShortcut !== 'string' || s.behavior.toggleShortcut.length > 80 || !/^(Ctrl|Control|Alt|Shift|Super|CommandOrControl)(\+[A-Za-z0-9]+)+$/.test(s.behavior.toggleShortcut)) return fail();
  if(!s.joinCards||typeof s.joinCards!=='object'||Array.isArray(s.joinCards)||Object.keys(s.joinCards).length>50)return fail();
  for(const [group,c] of Object.entries(s.joinCards)){
    if(!/^\d{1,20}$/.test(group)||!c||!(c.imageId===null||typeof c.imageId==='string'&&/^[a-f0-9]{64}$/.test(c.imageId))||typeof c.title!=='string'||c.title.length>40||typeof c.description!=='string'||c.description.length>160||!['topLeft','topRight','bottomLeft','bottomRight'].includes(c.position)||!number(c.widthDip,180,360)||!number(c.marginDip,8,100))return fail();
  }
  const m=s.media,a=s.aggregation;
  if(a&&a.startCount===undefined)a.startCount=6;
  if(!m||typeof m.enabled!=='boolean'||typeof m.animated!=='boolean'||!Number.isInteger(m.maxAnimatedOnScreen)||!number(m.maxAnimatedOnScreen,0,16))return fail();
  if(!a||!Number.isInteger(a.startCount)||!number(a.startCount,2,100))return fail();
  if(!a||typeof a.enabled!=='boolean'||typeof a.effectsEnabled!=='boolean'||typeof a.reducedMotion!=='boolean'||!number(a.windowMs,1000,30000)||!Array.isArray(a.milestones)||a.milestones.length>8||!a.milestones.every((n,i)=>Number.isInteger(n)&&number(n,2,9999)&&(i===0||n>a.milestones[i-1])))return fail();
  return s;
}
