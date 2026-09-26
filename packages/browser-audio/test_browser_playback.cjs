const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
function setup(){const workers=[],sources=[],events=[],gains=[];class Worker{constructor(){workers.push(this)}postMessage(d){this.last=d}terminate(){this.terminated=true}}
class AudioContext{constructor(){this.currentTime=0;this.state='running';this.destination={id:'context destination'}}async resume(){}async decodeAudioData(){return {duration:1}}createBuffer(c,n,r){return {duration:n/r,copyToChannel(data){this.data=data}}}createBufferSource(){const s={connect(){},start(at){this.startedAt=at},stop(at){this.stopped=true;this.stoppedAt=at}};sources.push(s);return s}createGain(){const g={gain:{value:0,setValueAtTime(v,at){g.gain.value=v;g.ramps.push(['set',v,at])},linearRampToValueAtTime(v,at){g.gain.value=v;g.ramps.push(['ramp',v,at])},cancelScheduledValues(){}},ramps:[],connect(target){g.connectedTo=target},disconnect(){g.disconnected=true}};gains.push(g);return g}}
const context=vm.createContext({window:{dispatchEvent:e=>events.push(e.detail)},CustomEvent:class{constructor(name,options){this.detail=options.detail}},Worker,AudioContext,DOMException,Uint8Array,atob,setTimeout,clearTimeout,Error,Set,Math});vm.runInContext(fs.readFileSync(__dirname+'/room-client.js','utf8'),context);return {voice:context.window.roomVoice,workers,sources,events,gains,context}}
test('Completion waits for the last audio source, not synthesis done',async()=>{const s=setup();await s.voice.unlock();let finished=false;const p=s.voice.speak({text:'hello'}).then(()=>finished=true);const w=s.workers[0],id=w.last.id;w.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});w.onmessage({data:{type:'done',id}});await Promise.resolve();assert.equal(finished,false);s.sources[0].onended();await p;assert.equal(finished,true)});
test('Cancellation stops scheduled sources and ignores late worker results',async()=>{const s=setup();await s.voice.unlock();const p=s.voice.speak({text:'hello'});const rejection=assert.rejects(p,{name:'AbortError'});const w=s.workers[0],id=w.last.id;w.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});s.voice.cancel();await rejection;assert.equal(s.sources[0].stopped,true);const afterCancel=s.sources.length;/* the voice source plus the silent tail that follows a cut */assert.equal(afterCancel,2);w.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});assert.equal(s.sources.length,afterCancel,'late worker audio schedules nothing')});

test('Output selection delegates to AudioContext when supported',async()=>{const s=setup();await s.voice.unlock();let sink;s.voice.context.setSinkId=async id=>{sink=id};await s.voice.setOutputDevice('headset');assert.equal(sink,'headset');assert.equal(s.voice.outputDeviceId,'headset')});
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

function animationClock(s){
 const frames=new Map();let serial=0;
 s.context.requestAnimationFrame=fn=>{const id=++serial;frames.set(id,fn);return id};
 s.context.cancelAnimationFrame=id=>frames.delete(id);
 return time=>{s.voice.context.currentTime=time;const batch=[...frames.values()];frames.clear();for(const fn of batch)fn()};
}
function alignment(text,step=.05){return {characters:[...text],character_start_times_seconds:[...text].map((_,i)=>i*step),character_end_times_seconds:[...text].map((_,i)=>(i+1)*step)}}
test('Cloud karaoke follows audio time and clears on cancellation, never late callbacks',async()=>{
 const s=setup();await s.voice.unlock();const tick=animationClock(s),cues=[];
 const speech=s.voice.playEncoded({audio_base64:'SUQz',text:'Hola tú',alignment:alignment('Hola tú')},()=>{},()=>{},cue=>cues.push(cue));
 const rejected=assert.rejects(speech,{name:'AbortError'});
 await new Promise(resolve=>setImmediate(resolve));
 tick(.1);assert.equal(cues.at(-1).from,0);assert.equal(cues.at(-1).to,4);assert.equal(cues.at(-1).mode,'word');
 tick(.3);assert.equal(cues.at(-1).from,5);assert.equal(cues.at(-1).to,7);
 const pending=[...cues];s.voice.cancel();assert.equal(cues.at(-1),null);
 tick(.4);assert.equal(cues.length,pending.length+1);await rejected;
});
test('Cloud karaoke does not invent word timing when alignment is absent or mismatched',async()=>{
 for(const a of [null,alignment('Another text')]){
  const s=setup();await s.voice.unlock();const tick=animationClock(s),cues=[];
  const speech=s.voice.playEncoded({audio_base64:'SUQz',text:'Hola',alignment:a},()=>{},()=>{},cue=>cues.push(cue));
  await new Promise(resolve=>setImmediate(resolve));tick(.2);
  assert.equal(cues.at(-1).mode,'utterance');assert.equal(cues.at(-1).to,4);
  s.sources[0].onended();await speech;assert.equal(cues.at(-1),null);
 }
});
test('Local karaoke follows queued chunks and preserves source whitespace offsets',async()=>{
 const s=setup();await s.voice.unlock();const tick=animationClock(s),cues=[];
 const speech=s.voice.speak({text:'Hola.  Otra frase.'},()=>{},()=>{},cue=>cues.push(cue));
 const worker=s.workers[0],id=worker.last.id;
 worker.onmessage({data:{type:'audio',id,text:'Hola.',samples:new Float32Array(24),sampleRate:24}});
 worker.onmessage({data:{type:'audio',id,text:'Otra frase.',samples:new Float32Array(24),sampleRate:24}});
 worker.onmessage({data:{type:'done',id}});
 tick(.1);assert.equal(cues.at(-1).from,0);assert.equal(cues.at(-1).to,5);
 tick(1.2);assert.equal(cues.at(-1).from,7);assert.equal(cues.at(-1).to,18);assert.equal(cues.at(-1).mode,'chunk');
 s.sources[0].onended();s.sources[1].onended();await speech;assert.equal(cues.at(-1),null);
});
test('Alignment validates Unicode offsets, timing bounds, and regex punctuation safely',()=>{
 const s=setup();s.context.a=alignment('👋 tú');
 const cues=vm.runInContext("alignedWordCues('👋 tú',a,1)",s.context);
 assert.equal(cues[0].to,2);assert.equal(cues[1].from,3);assert.equal(cues[1].to,5);
 s.context.a.character_start_times_seconds[1]=-1;
 assert.equal(vm.runInContext("alignedWordCues('👋 tú',a,1).length",s.context),0);
 const range=vm.runInContext("chunkTextRange('Hola (sí).  Hola (sí).','Hola (sí).',10)",s.context);
 assert.equal(range.from,12);assert.equal(range.to,22);
});

test('Speech leaves through a media element when the context can feed one, so echo cancellation hears it',async()=>{
 const s=setup();const sink={stream:{id:'sink'}};let played=0,elementSink;
 s.context.Audio=class{constructor(){this.srcObject=null}async play(){played++}async setSinkId(id){elementSink=id}};
 s.voice.context=new s.context.AudioContext();s.voice.context.createMediaStreamDestination=()=>sink;
 await s.voice.unlock();
 assert.equal(played,1);assert.equal(s.voice.output.element.srcObject,sink.stream);assert.equal(s.voice.destination,sink);
 let connected;s.voice.context.createBufferSource=()=>{const src={connect(target){connected=target},start(){},stop(){}};return src};
 const p=s.voice.speak({text:'hello'});const w=s.workers[0],id=w.last.id;
 w.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});
 assert.equal(connected,s.voice.job.gain,'the voice goes through a gain of its own, so cutting it can fade');
 assert.equal(s.voice.job.gain.connectedTo,sink,'and that gain leaves through the media element, not the context');
 assert.equal(s.voice.supportsOutputSelection,true);await s.voice.setOutputDevice('headset');assert.equal(elementSink,'headset');
 s.voice.cancel();await assert.rejects(p);
});
test('Off the iPhone the voice plays straight through the context, never through a media element (#80)',async()=>{
 const s=setup();let elements=0;
 s.context.Audio=class{constructor(){elements++}async play(){}pause(){}};
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>({stream:{}});s.voice.context=context;
 s.voice.outputStrategy='context';
 await s.voice.unlock();
 assert.equal(elements,0,'no element, so no second clock for the browser to keep in step by resampling');
 assert.equal(s.voice.output,null);
 assert.equal(s.voice.destination,s.voice.master,'everything leaves through one gain the engine owns');
 assert.equal(s.voice.master.connectedTo,context.destination);
 assert.equal(s.voice.health().output,'context');
 assert.ok(s.sources.length>=1,'the join is still greeted with its two notes');
 s.voice.setAudible(false);assert.equal(s.voice.master.gain.value,0,'a tab that is not the one sounding is muted at that gain');
 s.voice.setAudible(true);assert.equal(s.voice.master.gain.value,1);
 let sink;context.setSinkId=async id=>{sink=id};await s.voice.setOutputDevice('headset');
 assert.equal(sink,'headset','and choosing an output moves the context itself: one device, one clock');
});
test('The iPhone keeps its media-element output, which its echo cancellation needs',async()=>{
 const s=setup();s.voice.outputStrategy='element';const {context}=mediaOutput(s);await s.voice.unlock();
 assert.ok(s.voice.output?.element,'the element path is untouched on iOS');
 assert.equal(s.voice.master,null);
});
test('Without media-element output the context destination is used, as before',async()=>{
 const s=setup();await s.voice.unlock();assert.equal(s.voice.output,null);assert.equal(s.voice.destination,s.voice.context.destination);
});

test('Output pauses while the page is hidden or the context is interrupted, and resumes after',async()=>{
 const s=setup();const sink={stream:{}};let paused=0,played=0;const listeners={};
 s.context.Audio=class{async play(){played++}pause(){paused++}};
 s.context.document={hidden:false,addEventListener(name,fn){listeners[name]=fn}};
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>sink;context.addEventListener=(name,fn)=>{listeners[name]=fn};s.voice.context=context;
 await s.voice.unlock();assert.equal(played,1);
 s.context.document.hidden=true;listeners.visibilitychange();assert.equal(paused,1);
 s.context.document.hidden=false;context.state='interrupted';listeners.statechange();assert.equal(paused,2);
 context.state='running';listeners.statechange();assert.equal(played,2);
});
test('A desktop tab in the background keeps its output playing; only an interrupted context pauses it (#96)',async()=>{
 const s=setup();const sink={stream:{}};let paused=0;const listeners={};
 s.context.Audio=class{async play(){}pause(){paused++}};
 s.context.document={hidden:false,addEventListener(name,fn){listeners[name]=fn}};
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>sink;context.addEventListener=(name,fn)=>{listeners[name]=fn};s.voice.context=context;
 s.voice.pauseWhileHidden=false;
 await s.voice.unlock();
 s.context.document.hidden=true;listeners.visibilitychange();assert.equal(paused,0,'another tab in front is not an interruption');
 context.state='interrupted';listeners.statechange();assert.equal(paused,1);
});
test('An interrupted context is started again and the stream handed back, instead of leaving the room mute',async()=>{
 const s=setup();const sink={stream:{}};let paused=0,played=0,attached=0,resumes=0;const listeners={};
 s.context.Audio=class{async play(){played++}pause(){paused++}set srcObject(value){attached++}};
 s.context.document={hidden:false,addEventListener(name,fn){listeners[name]=fn}};
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>sink;context.addEventListener=(name,fn)=>{listeners[name]=fn};s.voice.context=context;
 await s.voice.unlock();assert.equal(attached,1);assert.equal(played,1);
 context.resume=async()=>{resumes++;context.state='running'};
 // The microphone taking the audio route is what an interruption looks like from a car: the
 // context stops, and its clock with it, while the page is still on screen.
 context.state='interrupted';listeners.statechange();
 assert.equal(paused,1,'the element is paused while the context is not running');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(resumes,1,'nobody else starts the context again');
 assert.equal(attached,2,'a paused media element needs the stream handed to it again');
 assert.equal(played,2);
});
test('A context that refuses to start again leaves the element paused rather than pretending',async()=>{
 const s=setup();const sink={stream:{}};let paused=0,played=0,attached=0;const listeners={};
 s.context.Audio=class{async play(){played++}pause(){paused++}set srcObject(value){attached++}};
 s.context.document={hidden:false,addEventListener(name,fn){listeners[name]=fn}};
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>sink;context.addEventListener=(name,fn)=>{listeners[name]=fn};s.voice.context=context;
 await s.voice.unlock();
 context.resume=async()=>{throw Error('not allowed without a gesture')};
 context.state='interrupted';listeners.statechange();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(attached,1);assert.equal(played,1);assert.equal(paused,1);
 assert.equal(s.voice.resuming,null,'a refused attempt does not block the next one');
});
test('Audio arriving while the context is stopped asks for it back instead of scheduling against a frozen clock',async()=>{
 const s=setup();await s.voice.unlock();
 const speech=s.voice.speak({text:'hola'}),worker=s.workers[0],id=worker.last.id;
 let resumes=0;const context=s.voice.context;
 context.state='suspended';context.resume=async()=>{resumes++;context.state='running'};
 worker.onmessage({data:{type:'audio',id,samples:new Float32Array(24),sampleRate:24}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(resumes,1);
 const rejected=assert.rejects(speech,{name:'AbortError'});s.voice.cancel();await rejected;
});

function mediaOutput(s){
 const sink={stream:{}};const counters={paused:0,played:0,attached:0,resumes:0};const listeners={};
 s.context.Audio=class{constructor(){this.paused=false}async play(){counters.played++;this.paused=false}pause(){counters.paused++;this.paused=true}set srcObject(value){counters.attached++}};
 s.context.document={hidden:false,addEventListener(name,fn){listeners[name]=fn}};
 s.context.Date=Date;
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>sink;context.addEventListener=(name,fn)=>{listeners[name]=fn};
 context.resume=async()=>{counters.resumes++;context.state='running'};s.voice.context=context;
 return {context,counters,listeners};
}
const settle=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('A frozen audio clock during playout asks the output back, and one that stays frozen fails the utterance instead of buzzing',async()=>{
 const s=setup();const {context,counters}=mediaOutput(s);await s.voice.unlock();
 s.voice.stallCheckMs=4;s.voice.stallAfterMs=6;s.voice.stallLimit=3;
 const statuses=[];const speech=s.voice.playEncoded({audio_base64:'SUQz'},text=>statuses.push(text));
 const rejected=assert.rejects(speech,/se detuvo en este dispositivo/);
 await settle(15);
 // The clock did not move: the element was paused and the context asked to run again, once per check.
 assert.ok(counters.resumes>=1||counters.attached>=2,'the output was asked back');
 assert.ok(s.voice.health().stalls>=1);
 assert.equal(s.voice.health().events.some(e=>e.kind==='stall'),true);
 await rejected;
 assert.equal(s.voice.job,null);
 assert.equal(JSON.stringify(s.voice.health().events.slice(-2).map(e=>e.kind)),JSON.stringify(['fail','tail']),'a failed voice is followed by the same silent tail as a cut one');
 assert.ok(s.voice.health().stalls>=3);
});
test('A phone whose screen locks mid-utterance is not a stuck device',async()=>{
 // We pause the element ourselves while the page is hidden, so the clock stands still on purpose: counting
 // that as a stall declared good replies failed when the screen locked (2026-09-20, from the room's reports).
 const s=setup();const {context}=mediaOutput(s);await s.voice.unlock();
 s.voice.stallCheckMs=3;s.voice.stallAfterMs=5;s.voice.stallLimit=3;
 s.context.document={hidden:true,addEventListener(){}};
 context.state='suspended';
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});
 const rejected=assert.rejects(speech,/se detuvo en este dispositivo/);
 await settle(30);
 assert.equal(s.voice.health().stalls,0,'a page that went away is not a device that froze');
 assert.ok(s.voice.job?.clock?.away>0);
 assert.equal(s.voice.health().events.some(e=>e.kind==='clock-away'),true,'and the room can read that it happened');
 // Back on screen and running: the watchdog counts again.
 s.context.document.hidden=false;context.state='running';
 await settle(40);
 await rejected;
 assert.ok(s.voice.health().stalls>=3);
});

test('A page that never comes back stops the room waiting for it',async()=>{
 // The room holds every later reply behind the one being played: a receipt that never arrives is a queue
 // that never moves (2026-09-20). The utterance is given up, and the room replays it on return.
 const s=setup();const {context}=mediaOutput(s);await s.voice.unlock();
 s.voice.stallCheckMs=3;s.voice.stallAfterMs=5;s.voice.awayLimitMs=20;
 s.context.document={hidden:true,addEventListener(){}};
 context.state='suspended';
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});
 const rejected=assert.rejects(speech,/segundo plano/);
 await settle(60);
 await rejected;
 assert.equal(s.voice.job,null,'the engine is free for what comes next');
});

test('A device that asked to keep the call with the screen locked keeps its output playing on hide (#59)',async()=>{
 const s=setup();const sink={stream:{}};let paused=0;const listeners={};
 s.context.Audio=class{async play(){}pause(){paused++}};
 s.context.document={hidden:false,addEventListener(name,fn){listeners[name]=fn}};
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>sink;context.addEventListener=(name,fn)=>{listeners[name]=fn};s.voice.context=context;
 await s.voice.unlock();
 assert.equal(s.voice.pauseWhileHidden,true,'this stand-in has no navigator, so it is treated as an iPhone');
 assert.equal(s.voice.keepPlayingWhileHidden(true),true);
 s.context.document.hidden=true;listeners.visibilitychange();assert.equal(paused,0,'locking the screen no longer silences the call');
 context.state='interrupted';listeners.statechange();assert.equal(paused,1,'a real interruption still pauses it: the stuck buzz rule stands');
 s.voice.keepPlayingWhileHidden(false);assert.equal(s.voice.pauseWhileHidden,true,'off, the platform does what it always did');
 assert.equal(s.voice.health().events.filter(e=>e.kind==='locked-call').map(e=>e.detail).join(),'on,off');
});
test('A phone call hung up with the screen locked gives the call its sound back without unlocking (#59)',async()=>{
 const s=setup();const sink={stream:{}};let paused=0,played=0;const listeners={};
 s.context.Audio=class{async play(){played++}pause(){paused++}};
 s.context.document={hidden:false,addEventListener(name,fn){listeners[name]=fn}};
 const context=new s.context.AudioContext();context.createMediaStreamDestination=()=>sink;context.addEventListener=(name,fn)=>{listeners[name]=fn};s.voice.context=context;
 await s.voice.unlock();s.voice.keepPlayingWhileHidden(true);const before=played;
 s.context.document.hidden=true;listeners.visibilitychange();
 context.state='interrupted';listeners.statechange();assert.equal(paused,1,'the interruption still pauses the element');
 context.state='running';listeners.statechange();
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(played>before,'and hanging up hands it back while the phone is still locked');
 // Without the locked call, a hidden page waits to be shown, as it always did.
 s.voice.keepPlayingWhileHidden(false);const settled=played;
 context.state='interrupted';listeners.statechange();context.state='running';listeners.statechange();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(played,settled);
});
test('The locked call keeps a faint floor sounding, never before the output has rendered, and stops it when off (#59)',async()=>{
 const s=setup();const {context}=mediaOutput(s);await s.voice.unlock();
 const sourcesBefore=s.sources.length;
 s.voice.presenceReady=()=>false;
 s.voice.keepPlayingWhileHidden(true);
 assert.equal(s.voice.keepAlive,null,'a fresh sink is never opened with it');
 s.voice.presenceReady=()=>true;
 assert.equal(s.voice.ensureKeepAlive(),true);
 const floor=s.voice.keepAlive;
 assert.equal(floor.loop,true);
 assert.ok(Math.max(...Array.from(floor.buffer.data).map(Math.abs))<=s.voice.keepAliveLevel,'far below the bed and the detector');
 assert.ok(s.voice.keepAliveLevel<.001);
 assert.equal(s.voice.ensureKeepAlive(),true);assert.equal(s.sources.length,sourcesBefore+1,'asking twice does not stack a second one');
 s.voice.keepPlayingWhileHidden(false);
 assert.equal(s.voice.keepAlive,null);assert.equal(floor.stopped,true);
});
test('A tab that is not the one sounding is muted, never paused, and gets its sound back at once (#96)',async()=>{
 const s=setup();const {context,counters}=mediaOutput(s);
 s.voice.setAudible(false);await s.voice.unlock();
 assert.equal(s.voice.output.element.muted,true,'an element created after the decision starts muted');
 const pausedBefore=counters.paused;
 s.voice.setAudible(true);assert.equal(s.voice.output.element.muted,false);
 s.voice.setAudible(false);assert.equal(s.voice.output.element.muted,true);
 assert.equal(counters.paused,pausedBefore,'muting never pauses the element');
});
test('A background tab that is still playing is not given up after the away limit (#96)',async()=>{
 const s=setup();const {context}=mediaOutput(s);s.voice.pauseWhileHidden=false;await s.voice.unlock();
 s.voice.stallCheckMs=3;s.voice.stallAfterMs=5;s.voice.awayLimitMs=10;
 s.context.document={hidden:true,addEventListener(){}};
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});const rejected=assert.rejects(speech,{name:'AbortError'});
 const ticker=setInterval(()=>{context.currentTime+=.1},1);
 await settle(40);clearInterval(ticker);
 assert.equal(s.voice.health().playing,true,'the reply is still sounding in the background');
 assert.equal(s.voice.health().events.some(e=>e.kind==='clock-away'),false);
 s.voice.cancel();await rejected;
});
test('A background tab whose clock froze is still given up, so the room is not left waiting',async()=>{
 const s=setup();const {context}=mediaOutput(s);s.voice.pauseWhileHidden=false;await s.voice.unlock();
 s.voice.stallCheckMs=3;s.voice.stallAfterMs=5;s.voice.awayLimitMs=20;
 s.context.document={hidden:true,addEventListener(){}};
 context.state='suspended';
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});
 await assert.rejects(speech,/segundo plano/);
});
test('A clock that advances raises no alarm, and cancelling while the context is stopped pauses the element',async()=>{
 const s=setup();const {context,counters}=mediaOutput(s);await s.voice.unlock();
 s.voice.stallCheckMs=3;s.voice.stallAfterMs=5;
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});const rejected=assert.rejects(speech,{name:'AbortError'});
 const ticker=setInterval(()=>{context.currentTime+=.1},1);
 await settle(25);clearInterval(ticker);
 assert.equal(s.voice.health().stalls,0);
 assert.equal(s.voice.health().playing,true);
 context.state='interrupted';const pausedBefore=counters.paused;
 s.voice.cancel();await rejected;
 assert.equal(counters.paused,pausedBefore+1,'a cancel while the context is stopped pauses the element so it cannot loop');
 assert.equal(JSON.stringify(s.voice.health().events.slice(-2).map(e=>e.kind)),JSON.stringify(['cancel','tail']));
 const health=s.voice.health();
 assert.deepEqual(Object.keys(health).sort(),['buffer_rate','clock','context','element','events','output','playing','presence','rate','resuming','stalls','strategy']);
});

test('A barge-in fades the voice out through its own gain instead of cutting the sink last input dead',async()=>{
 const s=setup();const {context}=mediaOutput(s);
 const connections=[];const gains=[];
 // No silent keep-alive on the sink: one was tried on 2026-09-19 and the phone's echo cancellation stopped
 // covering the room's voice while it ran (the agent's own replies opened turns). The sink only ever
 // carries the voice.
 context.createConstantSource=()=>{throw Error('must not be used')};
 context.createGain=()=>{const ramps=[];const gain={gain:{value:1,setValueAtTime(v,t){ramps.push(['set',v,t])},linearRampToValueAtTime(v,t){ramps.push(['ramp',v,t])}},ramps,connect(target){connections.push(['gain',target])},disconnect(){gain.disconnected=true}};gains.push(gain);return gain};
 const stops=[];context.createBufferSource=()=>{const src={connect(target){connections.push(['source',target])},start(){},stop(when){stops.push(when);src.stopped=true}};s.sources.push(src);return src};
 await s.voice.unlock();
 assert.equal(s.voice.output.keepalive,undefined);
 assert.deepEqual(connections,[['source',s.voice.output.sink]],'the greeting is the first thing through the sink');connections.length=0;
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});const rejected=assert.rejects(speech,{name:'AbortError'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(connections,[['gain',s.voice.output.sink],['source',gains[0]]],'the voice goes through its own gain into the sink');
 context.currentTime=2;
 s.voice.cancel();await rejected;
 assert.deepEqual(gains[0].ramps,[['set',1,2],['ramp',0,2.03]],'a cancel fades the gain to zero over 30 ms');
 assert.deepEqual(stops,[2.04],'the source stops just after the fade');
 assert.equal(JSON.stringify(s.voice.health().events.slice(-2).map(e=>e.kind)),JSON.stringify(['cancel','tail']));
});

test('Every noted output event is announced on the window, so the page can report it to the room',async()=>{
 const s=setup();const announced=[];
 s.context.window.dispatchEvent=e=>{if(e.detail?.kind)announced.push(e.detail.kind);else s.events.push(e.detail)};
 await s.voice.unlock();
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});const rejected=assert.rejects(speech,{name:'AbortError'});
 await new Promise(resolve=>setImmediate(resolve));
 s.voice.cancel();await rejected;
 assert.deepEqual(announced.filter(k=>['play-encoded','cancel'].includes(k)),['play-encoded','cancel']);
});

test('Cutting a voice mid-utterance leaves half a second of silence in the sink, as the next utterance would; an unplayed cancel does not',async()=>{
 const s=setup();const {context,counters}=mediaOutput(s);await s.voice.unlock();
 const made=[];context.createBufferSource=()=>{const src={connect(target){src.target=target},start(when){src.startedAt=when},stop(){src.stopped=true}};made.push(src);s.sources.push(src);return src};
 context.createBuffer=(channels,frames,rate)=>({duration:frames/rate,channels,frames,rate,copyToChannel(){}});
 context.sampleRate=48000;
 // Cancelled before it played: nothing to repair, no tail.
 const pending=s.voice.playEncoded({audio_base64:'SUQz'});const rejectedPending=assert.rejects(pending,{name:'AbortError'});
 s.voice.cancel();await rejectedPending;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(made.length,0);
 // Cancelled while playing (a barge-in): the voice source stops and a silent one follows it into the sink.
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});const rejected=assert.rejects(speech,{name:'AbortError'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(made.length,1);assert.equal(s.voice.job.playing,true);
 context.currentTime=3;
 s.voice.cancel();await rejected;
 assert.equal(made.length,2,'a silent tail follows the cut');
 const tail=made[1];
 assert.equal(tail.target,s.voice.output.sink);
 assert.equal(tail.buffer.duration,1.5);assert.equal(tail.buffer.frames,72000);
 assert.equal(tail.startedAt,3.05);
 assert.equal(counters.paused,0,'the element is left alone while the context runs');
 assert.equal(JSON.stringify(s.voice.health().events.slice(-2).map(e=>e.kind)),JSON.stringify(['cancel','tail']));
});

test('A voice that ends on its own leaves the same silence behind as one that is cut',async()=>{
 // An empty sink loops its last instant on iPhone Safari: that is the crackle under a quiet room.
 const s=setup();const {context}=mediaOutput(s);await s.voice.unlock();
 const made=[];context.createBufferSource=()=>{const src={connect(target){src.target=target},start(when){src.startedAt=when},stop(){src.stopped=true}};made.push(src);s.sources.push(src);return src};
 context.createBuffer=(channels,frames,rate)=>({duration:frames/rate,channels,frames,rate,copyToChannel(){}});
 context.sampleRate=48000;
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(made.length,1);assert.equal(s.voice.job.playing,true);
 context.currentTime=4;
 made[0].onended();
 await speech;
 assert.equal(made.length,2,'the end of the voice is followed into the sink');
 assert.equal(made[1].target,s.voice.output.sink);
 assert.equal(made[1].buffer.duration,1.5);
 assert.equal(JSON.stringify(s.voice.health().events.slice(-2).map(e=>e.kind)),JSON.stringify(['complete','tail']));
});

test('A fresh output is greeted once: audible notes first, then silence long enough for the element to start',async()=>{
 const s=setup();const {context}=mediaOutput(s);
 const made=[];let written=null;
 context.createBuffer=(channels,frames,rate)=>({duration:frames/rate,frames,rate,copyToChannel(data){written=data}});
 context.createBufferSource=()=>{const src={connect(target){src.target=target},start(when){src.startedAt=when},stop(){}};made.push(src);return src};
 context.sampleRate=48000;
 await s.voice.unlock();await s.voice.unlock();
 assert.equal(made.length,1,'one greeting per output');
 assert.equal(made[0].target,s.voice.output.sink);
 assert.equal(written.length,Math.round(48000*1.8),'notes plus a silent tail in one buffer');
 const notes=Array.from(written.slice(0,Math.round(48000*.4))),tail=Array.from(written.slice(Math.round(48000*.45)));
 const peak=Math.max(...notes.map(Math.abs));
 assert.ok(peak>.3&&peak<=.45,'loud enough for a phone speaker in a car: '+peak);
 assert.equal(written[0],0,'starts from zero, no click');
 assert.equal(tail.every(v=>v===0),true,'silence keeps the sink fed after the notes');
 assert.equal(s.voice.health().events.at(-1).kind,'chime');
});

// ----- the ambient bed while a conversation works on a turn (#42) -----
test('The bed is never the first thing a fresh output renders: it waits for the greeting or a voice',async()=>{
 const s=setup();
 assert.equal(s.voice.startPresence({volume:.035}),false,'no context, nothing to play into');
 await s.voice.unlock();
 assert.equal(s.voice.presenceReady(),false);
 assert.equal(s.voice.startPresence({volume:.035}),false);
 assert.equal(s.voice.events.at(-1).kind,'presence-refused');
 assert.equal(s.sources.length,0,'and it scheduled nothing at all');
 // A silent first source took the media element out of the phone's echo reference for the whole session.
 s.voice.greetedAt=Date.now()-s.voice.greetSeconds*1000;
 assert.equal(s.voice.presenceReady(),true);
});
test('A voice that already played keeps the bed allowed even after the event list has rolled over',async()=>{
 const s=setup();await s.voice.unlock();
 const speech=s.voice.playEncoded({audio_base64:'SUQz'});
 await new Promise(resolve=>setImmediate(resolve));
 s.sources[0].onended();await speech;
 for(let i=0;i<30;i++)s.voice.note('settle');
 assert.equal(s.voice.health().events.some(event=>['play-encoded','complete'].includes(event.kind)),false);
 assert.equal(s.voice.presenceReady(),true,'what the bounded list forgets, the output still knows');
});
test('The bed loops, fades in and out over at least 200 ms and leaves the sink fed when it goes',async()=>{
 const s=setup();await s.voice.unlock();s.voice.rendered=true;
 assert.equal(s.voice.startPresence({volume:.035,reason:'read'}),true);
 assert.equal(s.voice.startPresence({volume:.035}),true,'asking twice does not stack a second loop');
 assert.equal(s.sources.length,1);
 const [bed]=s.sources,[gain]=s.gains;
 assert.equal(bed.loop,true);
 assert.deepEqual(gain.ramps,[['set',0,0],['ramp',.035,s.voice.presenceFadeSeconds]]);
 assert.ok(s.voice.presenceFadeSeconds>=.2,'a bed that appears abruptly is worse than no bed');
 assert.equal(gain.connectedTo,s.voice.destination,'through the same output as the voice');
 assert.equal(s.voice.health().presence,.035);

 s.voice.context.currentTime=10;
 assert.equal(s.voice.stopPresence('reply'),true);
 assert.deepEqual(gain.ramps.slice(-2),[['set',.035,10],['ramp',0,10+s.voice.presenceFadeSeconds]]);
 assert.equal(bed.stopped,true);
 assert.ok(bed.stoppedAt>10+s.voice.presenceFadeSeconds,'the source outlives its own fade');
 assert.equal(s.sources.length,2);
 assert.equal(s.voice.events.at(-1).kind,'tail','a sink left with nothing loops its last instant on iOS');
 assert.equal(s.voice.health().presence,null);
 assert.equal(s.voice.stopPresence('reply'),false);
});
test('Speech always owns the output: a voice silences the bed and the bed never starts over one',async()=>{
 const s=setup();await s.voice.unlock();s.voice.rendered=true;
 assert.equal(s.voice.startPresence({volume:.035}),true);
 const speech=s.voice.speak({text:'hola'});
 assert.equal(s.voice.presence,null,'cancelling for a new utterance takes the bed with it');
 assert.equal(s.voice.startPresence({volume:.035}),false,'and a job in flight owns the output');
 s.voice.cancel();await assert.rejects(speech,{name:'AbortError'});
});
test('The bed refuses a volume of nothing and bounds one that is too much',async()=>{
 const s=setup();await s.voice.unlock();s.voice.rendered=true;
 assert.equal(s.voice.startPresence({volume:0}),false);
 assert.equal(s.voice.startPresence({volume:'nonsense'}),false);
 assert.equal(s.sources.length,0);
 assert.equal(s.voice.startPresence({volume:5}),true);
 assert.equal(s.voice.presence.volume,s.voice.presenceMaxVolume);
});
test('The bed is a slow breath in phrases: swells, then silence, quietest at the seam, normalized so its gain is its peak',()=>{
 const s=setup();s.voice.context=new s.context.AudioContext();
 const buffer=s.voice.presenceBuffer(),rate=48000,data=buffer.data;
 assert.equal(buffer.duration,34,'phrases of 3.6 s breaths with 5, 7 and 4 s of silence between them');
 let peak=0;for(const value of data)peak=Math.max(peak,Math.abs(value));
 assert.ok(Math.abs(peak-1)<1e-9,'peak 1, so the gain asked for is the peak amplitude in full scale');
 const rms=(from,to)=>{from=Math.round(from);to=Math.round(to);let squares=0;for(let i=from;i<to;i++)squares+=data[i]*data[i];return Math.sqrt(squares/(to-from))};
 const swell=rms(rate*1.6,rate*2),seam=rms(0,rate*.15),join=rms(rate*3.5,rate*3.7);
 assert.ok(swell>8*seam,'it swells and recedes: '+swell+' vs '+seam);
 assert.ok(swell>8*join,'twice per loop, and quiet where the breaths meet');
 assert.ok(Math.abs(data[0])<.01&&Math.abs(data[data.length-1])<.01,'the loop joins itself without a step');
 const gap=Array.from(data.slice(rate*7.3,rate*12.1));
 assert.ok(gap.every(v=>v===0),'after two breaths, seconds of silence: a long turn is not a continuous hum (#91)');
 assert.ok(rms(rate*14,rate*14.4)>8*seam,'and then the next phrase');
});

test('Hanging up has its own descending pair, and it too leaves the element with something to render',()=>{
 const s=setup();const {context}=mediaOutput(s);
 const made=[];let written=null;
 context.createBuffer=(channels,frames,rate)=>({duration:frames/rate,frames,rate,copyToChannel(data){written=data}});
 context.createBufferSource=()=>{const src={connect(target){src.target=target},start(when){src.startedAt=when},stop(){}};made.push(src);return src};
 context.sampleRate=48000;
 s.voice.output={sink:{stream:{}},element:{paused:false}};
 assert.equal(s.voice.signal('hangup'),true);
 assert.equal(made.at(-1).target,s.voice.output.sink);
 assert.equal(written.length,Math.round(48000*1.2));
 const tail=Array.from(written.slice(Math.round(48000*.5)));
 assert.equal(tail.every(v=>v===0),true,'silence after the notes, in the same buffer');
 assert.equal(s.voice.health().events.at(-1).kind,'hangup');
});
