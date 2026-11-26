import { contextBridge, ipcRenderer } from 'electron';
const subscribe = (name: string, callback: (v: any) => void) => {
  const fn = (_event: unknown, value: unknown) => callback(value);
  ipcRenderer.on(name, fn); return () => ipcRenderer.removeListener(name, fn);
};
contextBridge.exposeInMainWorld('desktop', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  save: (value: unknown) => ipcRenderer.invoke('save', value),
  command: (value: unknown) => ipcRenderer.invoke('command', value),
  importCard: () => ipcRenderer.invoke('importCard'),
  cardImage: (id:string) => ipcRenderer.invoke('cardImage',id),
  media: (segment:unknown) => ipcRenderer.invoke('media',segment),
  onState: (fn: (v: unknown) => void) => subscribe('state',fn),
  onOverlay: (fn: (v: unknown) => void) => subscribe('overlay',fn),
  metrics: (value: unknown) => ipcRenderer.send('metrics',value)
});
