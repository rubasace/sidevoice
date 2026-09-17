const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
function setup(){const workers=[],sources=[],events=[];class Worker{constructor(){workers.push(this)}postMessage(d){this.last=d}terminate(){this.terminated=true}}
class AudioContext{constructor(){this.currentTime=0;this.state='running'}async resume(){}async decodeAudioData(){return {duration:1}}createBuffer(c,n,r){return {duration:n/r,copyToChannel(){}}}createBufferSource(){const s={connect(){},start(){},stop(){this.stopped=true}};sources.push(s);return s}}
const context=vm.createContext({window:{dispatchEvent:e=>events.push(e.detail)},CustomEvent:class{constructor(name,options){this.detail=options.detail}},Worker,AudioContext,DOMException,Uint8Array,atob,setTimeout,clearTimeout,Error,Set,Math});vm.runInContext(fs.readFileSync(__dirname+'/browser_audio/room-client.js','utf8'),context);return {voice:context.window.roomVoice,workers,sources,events}}
test('Completion waits for the last audio source, not synthesis done',async()=>{const s=setup();await s.voice.unlock();let finished=false;const p=s.voice.speak({text:'hello'}).then(()=>finished=true);const w=s.workers[0],id=w.last.id;w.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});w.onmessage({data:{type:'done',id}});await Promise.resolve();assert.equal(finished,false);s.sources[0].onended();await p;assert.equal(finished,true)});
test('Cancellation stops scheduled sources and ignores late worker results',async()=>{const s=setup();await s.voice.unlock();const p=s.voice.speak({text:'hello'});const rejection=assert.rejects(p,{name:'AbortError'});const w=s.workers[0],id=w.last.id;w.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});s.voice.cancel();await rejection;assert.equal(s.sources[0].stopped,true);w.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});assert.equal(s.sources.length,1)});

test('Preparation reports progress and closes automatically on readiness',async()=>{const s=setup();const ready=s.voice.prepare({device:'auto'});const w=s.workers[0],id=w.last.id;assert.equal(s.events.at(-1).phase,'loading');w.onmessage({data:{type:'progress',id,progress:{file:'model.onnx',progress:42}}});assert.equal(s.events.at(-1).progress,42);w.onmessage({data:{type:'ready',id,device:'webgpu'}});await ready;assert.equal(s.events.at(-1).phase,'hidden')});

test('A ready model keeps per-utterance voice preparation inline without flashing a dialog',async()=>{
 const s=setup();const preparation=s.voice.prepare({device:'auto'});const worker=s.workers[0];
 worker.onmessage({data:{type:'ready',id:worker.last.id,device:'webgpu'}});await preparation;
 s.events.length=0;
 const statuses=[],speech=s.voice.speak({text:'hello',device:'auto'},text=>statuses.push(text));const id=worker.last.id;
 worker.onmessage({data:{type:'progress',id,progress:{status:'voice'}}});
 worker.onmessage({data:{type:'progress',id,progress:{status:'generating'}}});
 assert.equal(s.events.some(e=>e.phase==='loading'),false);
 assert.ok(statuses.some(text=>text.includes('primer audio')));
 worker.onmessage({data:{type:'done',id}});await speech;
});
test('Cloud audio uses the unlocked context and finishes only after playout',async()=>{
 const s=setup();await s.voice.unlock();const context=s.voice.context;let playing=0,finished=false;
 const p=s.voice.playEncoded({audio_base64:'SUQz'},()=>{},()=>playing++).then(()=>finished=true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.voice.context,context);assert.equal(s.workers.length,0);
 assert.equal(s.sources.length,1);assert.equal(playing,1);assert.equal(finished,false);
 s.sources[0].onended();await p;assert.equal(finished,true);
});
test('Cancelling cloud audio while it decodes prevents late playback',async()=>{
 const s=setup();await s.voice.unlock();let decode;
 s.voice.context.decodeAudioData=()=>new Promise(resolve=>{decode=resolve});
 const p=s.voice.playEncoded({audio_base64:'SUQz'});
 const rejected=assert.rejects(p,{name:'AbortError'});
 await new Promise(resolve=>setImmediate(resolve));s.voice.cancel();await rejected;
 decode({duration:1});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.sources.length,0);
});
test('Cancelling cloud playout stops the source and decoding errors are reported',async()=>{
 const s=setup();await s.voice.unlock();
 const p=s.voice.playEncoded({audio_base64:'SUQz'}),rejected=assert.rejects(p,{name:'AbortError'});
 await new Promise(resolve=>setImmediate(resolve));s.voice.cancel();await rejected;
 assert.equal(s.sources[0].stopped,true);
 s.voice.context.decodeAudioData=async()=>{throw Error('Invalid audio')};
 await assert.rejects(s.voice.playEncoded({audio_base64:'SUQz'}),/Invalid audio/);
 assert.equal(s.voice.job,null);
});
