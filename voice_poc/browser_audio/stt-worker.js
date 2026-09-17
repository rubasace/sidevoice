import {capabilities,initialize,transcribe} from './stt-engine.js';
let chain=Promise.resolve(),epoch=0;
self.onmessage=({data})=>{
 if(data.type==='cancel'){epoch++;return}
 const generation=epoch;
 chain=chain.then(async()=>{
  const send=(type,extra={})=>self.postMessage({id:data.id,type,...extra});
  const progress=value=>send('progress',{progress:value});
  try{
   if(data.type==='capabilities'){send('capabilities',{capabilities:await capabilities()});return}
   if(data.type==='load'){const runtime=await initialize(data.model,data.device,progress);if(epoch===generation)send('ready',{runtime});return}
   if(data.type==='transcribe'){
    const started=performance.now(),audio=new Float32Array(data.audio);
    const result=await transcribe(audio,data,progress);
    if(epoch===generation)send('result',{result:{...result,elapsed_ms:performance.now()-started}});
    return;
   }
   throw Error('Mensaje de transcripcion desconocido');
  }catch(error){if(epoch===generation)send('error',{error:String(error?.message||error)})}
 });
};
