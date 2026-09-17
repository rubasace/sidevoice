import {env,pipeline} from '@huggingface/transformers';

export const MODELS={
 'onnx-community/whisper-tiny':{revision:'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',label:'Whisper tiny',devices:['webgpu','wasm'],dtype:{webgpu:'fp32',wasm:'q8'}},
 'onnx-community/whisper-base':{revision:'1846881b6b3a3024392c1eea3ad983695bc23925',label:'Whisper base',devices:['webgpu','wasm'],dtype:{webgpu:'fp32',wasm:'q8'}},
 'onnx-community/whisper-small':{revision:'36050c46d777d46dc4b5f43f6d90574fc38f8732',label:'Whisper small',devices:['webgpu'],dtype:{webgpu:'fp16'},requiresFp16:true},
 'onnx-community/whisper-large-v3-turbo':{revision:'360ebcde2559d60bb474678be3c1de9ef347d01a',label:'Whisper large v3 turbo',devices:['webgpu'],dtype:{webgpu:'q4f16'},requiresFp16:true},
};
env.allowLocalModels=false;
env.backends.onnx.wasm.wasmPaths='/voice-browser/assets/';
env.backends.onnx.wasm.numThreads=1;
let transcriber=null,active=null;

export async function capabilities(){
 const wasm=typeof WebAssembly==='object'&&typeof WebAssembly.validate==='function';
 let adapter=null;
 try{adapter=navigator.gpu?await navigator.gpu.requestAdapter():null}catch{}
 const webgpu=!!adapter,webgpuFp16=!!adapter?.features?.has?.('shader-f16');
 const models=Object.entries(MODELS).filter(([,entry])=>entry.devices.includes('wasm')&&wasm||entry.devices.includes('webgpu')&&webgpu&&(!entry.requiresFp16||webgpuFp16)).map(([id])=>id);
 return {webgpu,webgpuFp16,wasm,models};
}
async function dispose(){try{await transcriber?.dispose?.()}catch{}transcriber=null;active=null}
export async function initialize(model,preference,progress){
 if(!MODELS[model])throw Error('Modelo de transcripcion no compatible');
 const available=await capabilities();let device=preference;
 if(device==='auto')device=available.webgpu?'webgpu':available.wasm?'wasm':null;
 if(!device||!available[device])throw Error(device==='webgpu'?'WebGPU no esta disponible en este navegador':'WebAssembly no esta disponible en este navegador');
 const metadata=MODELS[model];
 if(!available.models.includes(model)||!metadata.devices.includes(device))throw Error('Este modelo no es compatible con el motor seleccionado');
 const key=model+':'+device;
 if(transcriber&&active===key)return {device,model,cached:true};
 await dispose();
 transcriber=await pipeline('automatic-speech-recognition',model,{device,dtype:metadata.dtype[device],revision:metadata.revision,progress_callback:progress});
 active=key;
 return {device,model,cached:false};
}
export async function transcribe(audio,{model,device,language},progress){
 const runtime=await initialize(model,device,progress),options={task:'transcribe',chunk_length_s:30,stride_length_s:5};
 if(language&&language!=='auto')options.language=language;
 const result=await transcriber(audio,options);
 return {text:String(result?.text||'').trim(),...runtime};
}
