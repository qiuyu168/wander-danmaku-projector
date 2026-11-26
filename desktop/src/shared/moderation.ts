import type { Packet } from './api';

// Literal substring matching. Never evaluate user input as a regular expression.
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase();
export function keywordFilter(keywords:readonly string[]){
  const words=keywords.map(word=>normalize(word.trim())).filter(Boolean);
  return (packet:Packet)=>{
    if(!words.length)return false;
    const texts=[packet.text,packet.segments?.filter(s=>s.type==='text').map(s=>s.text).join('')||''].map(normalize);
    return words.some(word=>texts.some(text=>text.includes(word)));
  };
}
