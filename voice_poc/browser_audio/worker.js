import {initialize,synthesize,splitText} from './engine.js';
let epoch=0;let activeDevice=null;let chain=Promise.resolve();
self.onmessage=({data})=>{
 if(data.type==='cancel'){epoch++;return}
 const generation=epoch;
 chain=chain.then(async()=>{
  const send=(type,extra={})=>self.postMessage({type,id:data.id,...extra});
  try{
   const requested=data.device==='auto'?(navigator.gpu?'webgpu':'wasm'):data.device;
   if(!activeDevice||data.type==='load'){
    try{activeDevice=await initialize(requested,p=>send('progress',{progress:p}))}
    catch(error){if(data.device!=='auto'||requested==='wasm')throw error;send('fallback',{reason:String(error)});activeDevice=await initialize('wasm',p=>send('progress',{progress:p}))}
    send('ready',{device:activeDevice});
   }
   if(data.type==='load')return;
   for(const text of splitText(data.text)){
    if(epoch!==generation)return;
    const started=performance.now();const output=await synthesize(text,data.voice,data.speed,p=>send('progress',{progress:p}));
    if(epoch!==generation)return;
    self.postMessage({type:'audio',id:data.id,text,...output,elapsedMs:performance.now()-started,device:activeDevice},[output.samples.buffer]);
   }
   if(epoch===generation)send('done');
  }catch(error){activeDevice=null;send('error',{error:String(error?.message||error)})}
 });
};
