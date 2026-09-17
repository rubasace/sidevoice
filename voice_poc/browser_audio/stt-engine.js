import {env,pipeline} from '@huggingface/transformers';

export const MODELS={
 'onnx-community/whisper-tiny':{revision:'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',label:'Whisper tiny'},
 'onnx-community/whisper-base':{revision:'1846881b6b3a3024392c1eea3ad983695bc23925',label:'Whisper base'},
};
env.allowLocalModels=false;
env.backends.onnx.wasm.wasmPaths='/voice-browser/assets/';
env.backends.onnx.wasm.numThreads=1;
let transcriber=null,active=null;

export async function capabilities(){
 const wasm=typeof WebAssembly==='object'&&typeof WebAssembly.validate==='function';
 let webgpu=false;
 try{webgpu=!!(navigator.gpu&&await navigator.gpu.requestAdapter())}catch{}
 return {webgpu,wasm,models:Object.keys(MODELS)};
}
async function dispose(){try{await transcriber?.dispose?.()}catch{}transcriber=null;active=null}
export async function initialize(model,preference,progress){
 if(!MODELS[model])throw Error('Modelo de transcripcion no compatible');
 const available=await capabilities();let device=preference;
 if(device==='auto')device=available.webgpu?'webgpu':available.wasm?'wasm':null;
 if(!device||!available[device])throw Error(device==='webgpu'?'WebGPU no esta disponible en este navegador':'WebAssembly no esta disponible en este navegador');
 const key=model+':'+device;
 if(transcriber&&active===key)return {device,model,cached:true};
 await dispose();
 transcriber=await pipeline('automatic-speech-recognition',model,{device,dtype:device==='webgpu'?'fp32':'q8',revision:MODELS[model].revision,progress_callback:progress});
 active=key;
 return {device,model,cached:false};
}
export async function transcribe(audio,{model,device,language},progress){
 const runtime=await initialize(model,device,progress),options={task:'transcribe',chunk_length_s:30,stride_length_s:5};
 if(language&&language!=='auto')options.language=language;
 const result=await transcriber(audio,options);
 return {text:String(result?.text||'').trim(),...runtime};
}
