import type { Settings } from './settings';
export type DisplayInfo = { id: string; label: string; primary: boolean; scaleFactor: number; bounds: { x: number; y: number; width: number; height: number } };
export type Segment = {type:'text';text:string}|{type:'image';mediaId:string;url:string;alt?:string}|{type:'face';faceId:string;alt:string};
export type MediaResult = {data:string;still:string;width:number;height:number;animated:boolean};
export type Packet = { text: string; segments?:Segment[];sender?: string; trace?: { id?: string; serverProcessingMs?: number; sourceTimestampSec?: number; serverReceivedAtMs?: number } };
export type Status = { docker: string; server: string; onebotConnected: boolean; qqOnline: boolean | null; account: string; error: string; busy: boolean; logs: string[]; backend?: Record<string,unknown> };
export type Snapshot = { settings: Settings; displays: DisplayInfo[]; status: Status; visible: boolean; paused: boolean; cardVisible:boolean;metrics: Record<string,unknown> };
export type Command = 'show'|'hide'|'toggle'|'pause'|'clear'|'test'|'start'|'build'|'stop'|'qr'|'refreshLogin'|'identify'|'quit'|'showCard'|'hideCard'|'test66'|'test100'|'testMedia';
export interface DesktopAPI {
  snapshot(): Promise<Snapshot>;
  save(settings: Settings): Promise<void>;
  importCard():Promise<{id:string;data:string}|null>;
  cardImage(id:string):Promise<string>;
  media(segment:Segment):Promise<MediaResult>;
  command(command: Command): Promise<unknown>;
  onState(callback: (state: Snapshot) => void): () => void;
  onOverlay(callback: (event: { type: string; settings?: Settings; visible?: boolean; paused?: boolean; packet?: Packet; label?: string;count?:number;cardVisible?:boolean;cardData?:string;cardRect?:{x:number;y:number;width:number;height:number};media?:MediaResult }) => void): () => void;
  metrics(value: Record<string,unknown>): void;
}
declare global { interface Window { desktop: DesktopAPI } }
