import type { DisplayInfo } from './api';
import type { Settings } from './settings';
export function chooseDisplay(list:DisplayInfo[],selected:Settings['display']):DisplayInfo|undefined{
  const exact=list.find(d=>d.id===selected.targetId);if(exact)return exact;
  const hint=selected.targetHint;
  if(hint){const same=list.filter(d=>d.label===hint.label&&d.bounds.width===hint.width&&d.bounds.height===hint.height);if(same.length===1)return same[0];}
  return list.find(d=>!d.primary)||list.find(d=>d.primary)||list[0];
}
