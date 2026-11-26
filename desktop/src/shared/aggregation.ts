import type { Packet } from './api';
export function contentKey(packet:Packet):string {
  const normalize=(s:string)=>s.replace(/\r\n?/g,'\n').trim();
  return JSON.stringify(packet.segments?.length?packet.segments.map(s=>s.type==='text'?['text',normalize(s.text)]:s.type==='face'?['face',s.faceId]:['image',s.mediaId]):[['text',normalize(packet.text)]]);
}
export function crossed(previous:number,next:number,thresholds:number[]):number {
  return thresholds.filter(n=>previous<n&&n<=next).at(-1)||0;
}
export class RepeatWindow {
  private counts=new Map<string,{at:number;count:number}>();
  count(key:string,now:number,windowMs:number){
    for(const [k,v] of this.counts)if(now-v.at>=windowMs)this.counts.delete(k);
    let entry=this.counts.get(key);if(!entry){if(this.counts.size>=4096)this.counts.delete(this.counts.keys().next().value!);entry={at:now,count:0};this.counts.set(key,entry);}
    return ++entry.count;
  }
  clear(){this.counts.clear();}
}
export class Aggregates<T extends {at:number;count:number;key:string}> {
  private index=new Map<string,T>();
  private ids=new Map<string,number>();
  duplicate(id:string|undefined,now:number){
    for(const [key,at] of this.ids)if(now-at>60000)this.ids.delete(key);
    if(!id)return false;if(this.ids.has(id))return true;
    this.ids.set(id,now);if(this.ids.size>4096)this.ids.delete(this.ids.keys().next().value!);return false;
  }
  find(key:string,now:number,windowMs:number){const entity=this.index.get(key);return entity&&now-entity.at<windowMs?entity:undefined;}
  add(entity:T){this.index.set(entity.key,entity);}
  remove(entity:T){if(this.index.get(entity.key)===entity)this.index.delete(entity.key);}
  clear(){this.index.clear();this.ids.clear();}
}
