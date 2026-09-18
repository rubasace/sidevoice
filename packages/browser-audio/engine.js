import {StyleTextToSpeech2Model,AutoTokenizer,Tensor,env} from '@huggingface/transformers';
import ESpeakNG from '/voice-browser/assets/espeak-ng.js';
const MODEL='onnx-community/Kokoro-82M-v1.0-ONNX';
const REVISION='1939ad2a8e416c0acfeecc08a694d14ef25f2231';
env.allowLocalModels=false;
env.backends.onnx.wasm.wasmPaths='/voice-browser/assets/';
env.backends.onnx.wasm.numThreads=1;
import catalog from './catalog.json';
const allowed=new Set(catalog.languages.flatMap(l=>l.voices.map(v=>v[0])));
const voiceCache=new Map();
let model,tokenizer,device;
export async function initialize(preference,progress){
 if(model&&device===preference)return device;
 await model?.dispose();model=null;
 device=preference;
 tokenizer=await AutoTokenizer.from_pretrained(MODEL,{revision:REVISION,progress_callback:progress});
 model=await StyleTextToSpeech2Model.from_pretrained(MODEL,{revision:REVISION,device,dtype:device==='webgpu'?'fp32':'q8',progress_callback:progress});
 return device;
}
async function voiceData(voice,progress){
 if(voiceCache.has(voice))return voiceCache.get(voice);
 progress?.({status:'voice',file:voice+'.bin'});
 const url=`https://huggingface.co/${MODEL}/resolve/${REVISION}/voices/${voice}.bin`;
 let cache;try{cache=await caches.open('voice-room-kokoro-v1')}catch{}
 let response=await cache?.match(url);
 if(!response){response=await fetch(url);if(!response.ok)throw Error(`Voice download failed: ${response.status}`);try{await cache?.put(url,response.clone())}catch{}}
 const data=new Float32Array(await response.arrayBuffer());voiceCache.set(voice,data);return data;
}
const punctuation=/([;:,.!?¡¿—…“”"()]+)/u;
export async function phonemes(text,voice){
 const language=voice.startsWith('b')?'en-gb':catalog.languages.find(l=>l.voices.some(v=>v[0]===voice)).espeak;
 const parts=text.split(punctuation);let result='';
 for(const part of parts){
  if(!part)continue;
  if(punctuation.test(part)){result+=part;continue}
  if(!part.trim()){result+=part;continue}
  const instance=await ESpeakNG({locateFile:file=>'/voice-browser/assets/'+file,arguments:['--phonout','/phonemes','-q','-b','1','--ipa=3','-v',language,part],print:()=>{},printErr:()=>{}});
  result+=instance.FS.readFile('/phonemes',{encoding:'utf8'}).trim();
 }
 result=result.replace(/[\u200d\u0361]/g,'^').replace(/\((?:en|es|fr|it|pt|hi)(?:-[a-z]+)?\)/g,'');
 const mapping={'a^ɪ':'I','a^ʊ':'W','d^z':'ʣ','d^ʒ':'ʤ','e^ɪ':'A','o^ʊ':'O','ə^ʊ':'Q','s^s':'S','t^s':'ʦ','t^ʃ':'ʧ','ɔ^ɪ':'Y'};
 if(!language.startsWith('en')){for(const [from,to] of Object.entries(mapping))result=result.replaceAll(from,to);result=result.replaceAll('^','').replaceAll('-','')}
 else{result=result.replaceAll('^','').replaceAll('ʲ','j').replaceAll('r','ɹ').replaceAll('x','k').replaceAll('ɬ','l')}
 return result.trim();
}
export function splitText(text,limit=160){
 const chunks=[];let current='';for(const word of text.trim().split(/\s+/)){if(current&&(current.length+word.length+1)>limit){chunks.push(current);current=''}current+=(current?' ':'')+word;if(/[.!?;:]$/.test(word)){chunks.push(current);current=''}}if(current)chunks.push(current);return chunks;
}
export async function synthesize(text,voice,speed,progress){
 if(!allowed.has(voice))throw Error('Unsupported voice');
 const ps=await phonemes(text,voice);
 const {input_ids}=tokenizer(ps,{truncation:false});
 const tokens=input_ids.dims.at(-1)-2;
 if(tokens>509)throw Error('Text chunk exceeds model limit; no silent truncation');
 const styles=await voiceData(voice,progress);const style=styles.slice(Math.max(0,tokens)*256,(Math.max(0,tokens)+1)*256);
 if(style.length!==256)throw Error('Invalid voice data');
 progress?.({status:'generating'});
 const {waveform}=await model({input_ids,style:new Tensor('float32',style,[1,256]),speed:new Tensor('float32',[speed],[1])});
 return {samples:new Float32Array(waveform.data),phonemes:ps,sampleRate:24000};
}
