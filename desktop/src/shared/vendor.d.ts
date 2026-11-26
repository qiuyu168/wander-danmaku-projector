declare module 'omggif' {
  export class GifReader {constructor(buffer:Buffer);width:number;height:number;numFrames():number;decodeAndBlitFrameRGBA(frame:number,buffer:Uint8Array):void;frameInfo(frame:number):{x:number;y:number;width:number;height:number;delay:number;disposal:number};}
  export class GifWriter {constructor(buffer:Buffer,width:number,height:number,options:{palette:number[];loop:number});addFrame(x:number,y:number,width:number,height:number,data:Uint8Array,options:{delay:number;transparent?:number;disposal?:number}):void;end():number;}
}
declare module 'pngjs' {export const PNG:{sync:{write(image:{width:number;height:number;data:Buffer}):Buffer}};}
