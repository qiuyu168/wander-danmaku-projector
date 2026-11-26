import '../shared/api';
window.desktop.onOverlay(event=>{
  if(event.type!=='card')return;
  const config=event.settings?.joinCards[event.settings.source.groupId];
  document.body.style.visibility=event.cardVisible?'visible':'hidden';
  document.getElementById('title')!.textContent=config?.title||'';
  document.getElementById('description')!.textContent=config?.description||'';
  const image=document.getElementById('qr') as HTMLImageElement;
  if(event.cardVisible&&event.cardData)image.src=event.cardData;else image.removeAttribute('src');
});
