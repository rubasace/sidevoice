// Provider alignment is mapped to original UTF-16 text offsets. Never guess word timing.
function alignedWordCues(text,alignment,duration){
 if(typeof text!=='string'||!alignment)return [];
 const chars=alignment.characters,starts=alignment.character_start_times_seconds,ends=alignment.character_end_times_seconds;
 if(!Array.isArray(chars)||!Array.isArray(starts)||!Array.isArray(ends)||chars.length!==starts.length||chars.length!==ends.length)return [];
 if(!chars.every(c=>typeof c==='string'&&c.length>0)||chars.join('')!==text)return [];
 const startAt=[],endAt=[];let previous=0;
 for(let i=0;i<chars.length;i++){
  const start=starts[i],end=ends[i];
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<previous||end<start||end>duration+.25)return [];
  for(let j=0;j<chars[i].length;j++){startAt.push(start);endAt.push(end)}
  previous=start;
 }
 const cues=[];
 for(const word of text.matchAll(/\S+/gu)){
  const first=word.index,last=first+word[0].length;
  if(endAt[last-1]>startAt[first])cues.push({from:first,to:last,start:startAt[first],end:endAt[last-1],mode:'word'});
 }
 return cues;
}
function chunkTextRange(text,chunk,from=0){
 if(typeof text!=='string'||typeof chunk!=='string'||!chunk.trim())return null;
 const words=chunk.trim().split(/\s+/u).map(word=>word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const match=new RegExp(words.join('\\s+'),'u').exec(text.slice(from));
 return match?{from:from+match.index,to:from+match.index+match[0].length}:null;
}
/* Local synthesis and playout. A canceled job can never emit late audio. */
class RoomVoice {
 constructor(){this.worker=null;this.context=null;this.output=null;this.job=null;this.serial=0;this.device=null;this.ready=false;this.outputDeviceId='default';this.resuming=null;
  // What the output did lately, for the stats dialog: a stuck buzz on a phone is otherwise invisible from here.
  this.events=[];this.stalls=0;this.stallCheckMs=500;this.stallAfterMs=700;this.stallLimit=3;this.tailSeconds=.5;
  // The ambient bed (#42) is a loop of its own, and never the first thing a fresh output renders.
  this.greetSeconds=1.8;this.greetedAt=0;this.rendered=false;
  this.presence=null;this.presenceSeconds=2.4;this.presencePulseSeconds=1.2;this.presenceFadeSeconds=.25;this.presenceMaxVolume=.12}
 note(kind,detail){const event={at:Date.now(),kind,...(detail?{detail}:{})};this.events.push(event);if(this.events.length>24)this.events.shift();
  // The event list is bounded, so what it proves is kept apart from it: a voice has already left this output.
  if(kind==='play-encoded'||kind==='complete')this.rendered=true;
  if(typeof window!=='undefined'&&window.dispatchEvent&&typeof CustomEvent==='function'){try{window.dispatchEvent(new CustomEvent('voice-output',{detail:event}))}catch{}}}
 /* The output as it is right now, and what happened to it lately. */
 health(){
  const element=this.output?.element;
  return {context:this.context?.state||'none',clock:this.context?Math.round(this.context.currentTime*1000)/1000:null,
   output:element?'element':(this.context?'context':'none'),
   element:element?{paused:!!element.paused,readyState:element.readyState??null}:null,
   playing:!!this.job?.playing,presence:this.presence?this.presence.volume:null,stalls:this.stalls,resuming:!!this.resuming,events:this.events.slice(-12)};
 }
 announce(text,phase='loading',progress=null){if(window.dispatchEvent)window.dispatchEvent(new CustomEvent('voice-preparation',{detail:{text,phase,progress}}))}
 async unlock(){this.context??=new AudioContext();await this.context.resume();if(this.context.state!=='running'){this.note('unlock-refused',this.context.state);throw Error('Permite reproducir audio en este navegador.')}await this.ensureOutput();this.greet()}
 /* A fresh output is greeted once: two soft notes, then a second and a half of silence, in one buffer.
  * The notes tell the person they are in and, being audible, keep the media element in the phone's echo
  * reference (half a second of silence alone took it out for the whole session, 2026-09-19). The silence
  * after them keeps the sink fed until the element has actually started: a bare quarter-second chime ended
  * before that and the element looped its last instant, the same failure as a cut without a tail. */
 greet(){
  if(!this.context||!this.output||this.greeted||typeof this.context.createBufferSource!=='function')return;
  this.greeted=true;this.greetedAt=Date.now();
  try{
   const rate=this.context.sampleRate||48000,notes=[[660,0,.11],[880,.12,.13]],length=Math.round(rate*(this.greetSeconds||1.8));
   const buffer=this.context.createBuffer(1,length,rate),samples=new Float32Array(length);
   for(const [hz,at,dur] of notes){const from=Math.round(at*rate),n=Math.round(dur*rate);
    for(let i=0;i<n&&from+i<length;i++){const env=.5-.5*Math.cos(2*Math.PI*i/n);samples[from+i]+=.12*env*Math.sin(2*Math.PI*hz*i/rate)}}
   buffer.copyToChannel(samples,0);
   const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.destination);
   source.start(this.context.currentTime+.02);this.note('chime');
  }catch(error){this.note('chime-failed',error?.message||'chime')}
 }
 /* The room's voice leaves through a media element, not the context's own output: on iOS Safari only
  * media-element playback is part of the echo-cancellation reference, so this is what lets the
  * microphone subtract our own voice instead of opening a turn with it. Falls back to the context. */
 async ensureOutput(){
  if(this.output||typeof this.context.createMediaStreamDestination!=='function'||typeof Audio==='undefined')return;
  const sink=this.context.createMediaStreamDestination(),element=new Audio();
  element.srcObject=sink.stream;element.playsInline=true;element.autoplay=true;
  try{await element.play()}catch(error){this.note('element-refused',error?.message||'play');return}
  this.output={sink,element};this.note('element-ready');
  // iOS interrupts the page's audio when the user pulls down notifications, switches apps, or the
  // microphone takes the audio route over — which is what an interruption while we speak looks
  // like in a car. An element left playing through that comes back as a stuck buzz, so it is
  // paused while the page is away, and everything is put back together when it returns.
  const settle=event=>{
   const hidden=typeof document!=='undefined'&&document.hidden;
   this.note(event?.type||'settle',(hidden?'hidden':'visible')+' · '+this.context.state);
   if(hidden||this.context.state!=='running')element.pause();
   if(!hidden)this.resumeOutput();
  };
  if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('visibilitychange',settle);
  if(typeof window!=='undefined'&&window.addEventListener){window.addEventListener('pagehide',settle);window.addEventListener('pageshow',settle)}
  if(this.context.addEventListener)this.context.addEventListener('statechange',settle);
  this.output.settle=settle;
 }
 /* An interrupted context does not start itself again: its clock stays on the instant it stopped,
  * so everything scheduled afterwards is queued against a frozen time and never sounds. Nor does a
  * media element fed by a MediaStream always come back from pause — the stream has to be handed to
  * it again. Both are asked for together, because either one alone leaves the room silent. */
 resumeOutput(){
  if(!this.context)return Promise.resolve();
  if(this.context.state==='running')return this.attachOutput();
  // One ask at a time: a statechange and a visibility change arriving together used to start two
  // attempts, and the element was handed the stream twice for nothing.
  this.resuming??=(async()=>{
   try{await this.context.resume()}catch(error){this.note('resume-refused',error?.message||'resume')}
   this.resuming=null;
   this.note('resume',this.context.state);
   if(this.context.state==='running')await this.attachOutput();
  })();
  return this.resuming;
 }
 attachOutput(){
  const output=this.output;
  if(!output)return Promise.resolve();
  try{output.element.srcObject=output.sink.stream;this.note('attach');return Promise.resolve(output.element.play()).catch(error=>{this.note('attach-refused',error?.message||'play')})}
  catch(error){this.note('attach-refused',error?.message||'attach');return Promise.resolve()}
 }
 get destination(){return this.output?.sink||this.context.destination}
 /* Where a job's sources connect: a gain of its own when the context has one, so cancelling fades it out
  * over a few milliseconds instead of stopping the sink's last input dead. */
 outlet(job){
  if(job.gain!==undefined)return job.gain||this.destination;
  job.gain=null;
  if(typeof this.context.createGain==='function'){try{job.gain=this.context.createGain();job.gain.connect(this.destination)}catch{job.gain=null}}
  return job.gain||this.destination;
 }
 /* The media element is handed its stream again: the same repair the page applies after an iOS
  * interruption. Used after a voice is cut mid-utterance, when the graph goes on and the element does not. */
 reattachOutput(reason){
  const output=this.output;
  if(!output)return Promise.resolve();
  this.note('reattach',reason);
  try{output.element.pause()}catch{}
  return this.attachOutput();
 }
 /* Stop a job's sources softly: gain to zero over 30 ms, sources stopped just after, the gain released later. */
 silence(job){
  const now=this.context?.currentTime||0,gain=job.gain;
  if(gain&&gain.gain&&typeof gain.gain.setValueAtTime==='function'){
   try{gain.gain.setValueAtTime(gain.gain.value,now);gain.gain.linearRampToValueAtTime(0,now+.03)}catch{}
   for(const source of job.sources){source.onended=null;try{source.stop(now+.04)}catch{try{source.stop()}catch{}}}
   setTimeout(()=>{try{gain.disconnect()}catch{}},200);
  }else for(const source of job.sources){source.onended=null;try{source.stop()}catch{}}
  job.sources.clear();
  if(job.playing)this.tail();
 }
 /* Seen on iPhone Safari (2026-09-19): a voice cut mid-utterance left the media element stuck on its last
  * instant while the graph went on, and the next utterance's first source unstuck it. So a cut is followed
  * by what the next utterance would do: half a second of silence into the same sink. (A permanent silent
  * source was tried first and the phone's echo cancellation stopped covering the voice while it ran.) */
 tail(kind='tail'){
  if(!this.context||typeof this.context.createBufferSource!=='function')return;
  try{
   const rate=this.context.sampleRate||48000,buffer=this.context.createBuffer(1,Math.round(rate*this.tailSeconds),rate);
   const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.destination);
   source.start(this.context.currentTime+.05);this.note(kind);
  }catch(error){this.note(kind+'-failed',error?.message||kind)}
 }
 /* ----- the ambient bed: the conversation is working on the turn this browser sent (#42) -----
  * One loop, generated here, no asset: a band of noise between roughly 110 and 420 Hz mixed with two
  * quiet partials a fifth apart (220 and 330 Hz), the whole thing breathing once every two seconds.
  * The loop is four seconds long so both partials close a whole number of cycles at the seam, and the
  * noise is crossfaded into its own head so the join has no click.
  *
  * Its level is what keeps it out of the microphone's way: the buffer is normalized to peak 1 and the
  * gain *is* the peak amplitude, so 0.035 means -29 dBFS and nothing has to be guessed about it. It
  * leaves through the same media element as the voice (see ensureOutput), so a phone's echo
  * cancellation subtracts it instead of the detector hearing it as speech. */
 presenceBuffer(){
  /* A pulse, not a bed of noise. The first attempt (2026-09-19) mixed a filtered noise band under two
   * partials and the operator's verdict was "horrible": on a phone speaker a hiss reads as a fault, not
   * as company. What reads as thinking is a warm tone that breathes — soft attack, long decay, silence
   * between beats — the way a voice assistant's waiting sound does. Two beats per loop, and the loop
   * joins itself at zero because the second beat has decayed by the seam. */
  const rate=this.context.sampleRate||48000,length=Math.round(rate*this.presenceSeconds);
  const samples=new Float32Array(length),beat=this.presencePulseSeconds;
  const attack=.05,decay=.55,partials=[[330,1],[495,.34],[660,.12]];
  for(let at=0;at+beat<=this.presenceSeconds+1e-9;at+=beat){
   const from=Math.round(at*rate),span=Math.round((attack+decay)*rate);
   for(let i=0;i<span&&from+i<length;i++){
    const t=i/rate;
    // Raised-cosine attack into an exponential decay: no click at the onset, nothing left at the seam.
    const envelope=t<attack?(.5-.5*Math.cos(Math.PI*t/attack)):Math.exp(-(t-attack)*4.2);
    let value=0;for(const [hz,weight] of partials)value+=weight*Math.sin(2*Math.PI*hz*t);
    samples[from+i]+=envelope*value;
   }
  }
  let peak=0;for(let i=0;i<length;i++)peak=Math.max(peak,Math.abs(samples[i]));
  if(peak>0)for(let i=0;i<length;i++)samples[i]/=peak;
  const buffer=this.context.createBuffer(1,length,rate);buffer.copyToChannel(samples,0);return buffer;
 }
 /* One short, soft note, for the moment a message is read by the conversation: the second tick, made
  * audible. It is a one-shot through the same sink as everything else, never over speech, and it leaves
  * the usual silent tail behind so the sink is not emptied when it ends. It is deliberately shorter than
  * the detector's onset (`vad_start_secs`, 200 ms by default): a sound of this app's own that lasts
  * longer than that can be heard back through a phone speaker and open a turn, which on 2026-09-19 is
  * exactly how the room started interrupting itself. */
 chime(kind='read',{volume=.05}={}){
  if(!this.context||this.context.state!=='running'||this.job)return false;
  if(typeof this.context.createBufferSource!=='function')return false;
  if(!this.presenceReady()){this.note('chime-refused','output not yet rendering');return false}
  try{
   const rate=this.context.sampleRate||48000,seconds=.12,length=Math.round(rate*seconds);
   const samples=new Float32Array(length),level=Math.min(.12,Math.max(0,Number(volume)||0));
   const notes=kind==='read'?[[587.33,0],[880,.04]]:[[440,0]];
   for(const [hz,at] of notes){
    const from=Math.round(at*rate);
    for(let i=0;from+i<length;i++){
     const t=i/rate,envelope=t<.006?t/.006:Math.exp(-(t-.006)*34);
     if(t>.006&&envelope<1e-4)break;   // only the decay ends the note; the attack starts at zero by design
     samples[from+i]+=envelope*Math.sin(2*Math.PI*hz*t);
    }
   }
   let peak=0;for(let i=0;i<length;i++)peak=Math.max(peak,Math.abs(samples[i]));
   if(peak>0)for(let i=0;i<length;i++)samples[i]*=level/peak;
   const buffer=this.context.createBuffer(1,length,rate);buffer.copyToChannel(samples,0);
   const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.destination);
   source.start(this.context.currentTime+.01);
   source.onended=()=>{if(!this.presence&&!this.job)this.tail('chime-tail')};
   this.note('chime',kind);
   return true;
  }catch(error){this.note('chime-failed',error?.message||'chime');return false}
 }
 /* True once something audible has already left this output. A fresh sink must never be opened with the
  * bed: the greeting is what puts the media element in the phone's echo reference, and until it has
  * been through, a quiet loop is exactly the silent-first-source failure of 2026-09-19 again. */
 presenceReady(){return this.rendered||(!!this.greetedAt&&Date.now()-this.greetedAt>=this.greetSeconds*1000)}
 /* Returns whether the bed is now sounding. Refuses rather than queueing: a caller that cannot have it
  * yet asks again on the next turn. Never starts over speech — a job in flight owns the output. */
 startPresence({volume=.035,reason='working'}={}){
  if(this.presence)return true;
  if(!this.context||this.context.state!=='running'||this.job)return false;
  if(typeof this.context.createBufferSource!=='function'||typeof this.context.createGain!=='function')return false;
  const level=Math.min(this.presenceMaxVolume,Math.max(0,Number(volume)||0));
  if(!level)return false;
  if(!this.presenceReady()){this.note('presence-refused','output not yet rendering');return false}
  try{
   const gain=this.context.createGain(),source=this.context.createBufferSource();
   source.buffer=this.presenceBuffer();source.loop=true;source.connect(gain);gain.connect(this.destination);
   const now=this.context.currentTime,fade=this.presenceFadeSeconds;
   gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(level,now+fade);
   source.start(now);
   this.presence={source,gain,volume:level};this.note('presence-start',reason+' · '+level.toFixed(3));
   return true;
  }catch(error){this.note('presence-failed',error?.message||'presence');return false}
 }
 stopPresence(reason='stop'){
  const presence=this.presence;if(!presence)return false;
  this.presence=null;
  const now=this.context?.currentTime||0,fade=this.presenceFadeSeconds;
  try{
   presence.gain.gain.cancelScheduledValues?.(now);
   presence.gain.gain.setValueAtTime(presence.gain.gain.value,now);
   presence.gain.gain.linearRampToValueAtTime(0,now+fade);
  }catch{}
  presence.source.onended=null;
  try{presence.source.stop(now+fade+.02)}catch{try{presence.source.stop()}catch{}}
  setTimeout(()=>{try{presence.gain.disconnect()}catch{}},(fade+.3)*1000);
  this.note('presence-stop',reason);
  // The bed may have been this sink's only input, and a sink left with nothing is the stuck-last-instant
  // failure on iPhone Safari. It gets the same silent tail a cut voice gets.
  this.tail('presence-tail');
  return true;
 }
 get supportsOutputSelection(){return typeof this.output?.element?.setSinkId==='function'||typeof (this.context||AudioContext.prototype).setSinkId==='function'}
 async setOutputDevice(id){
  await this.unlock();
  if(!this.supportsOutputSelection)throw Error('Este navegador no permite elegir la salida de audio.');
  const selected=id||'default';
  if(typeof this.output?.element?.setSinkId==='function')await this.output.element.setSinkId(selected==='default'?'':selected);
  else await this.context.setSinkId(selected==='default'?'':selected);
  this.outputDeviceId=selected;return true;
 }
 stopProgress(job){
  if(job.raf!=null)globalThis.cancelAnimationFrame?.(job.raf);
  job.raf=null;
  if(job.onProgress){try{job.onProgress(null)}catch{}}
 }
 watchProgress(job){
  if(!job.onProgress||job.raf!=null||!globalThis.requestAnimationFrame)return;
  const tick=()=>{
   job.raf=null;if(this.job!==job)return;
   const now=this.context.currentTime;
   const cue=(job.cues||[]).find(c=>now>=c.start&&now<c.end)||null;
   if(cue!==job.lastCue){job.lastCue=cue;try{job.onProgress(cue)}catch{}}
   if(this.job===job)job.raf=globalThis.requestAnimationFrame(tick);
  };
  tick();
 }
 /* Playout is watched on the wall clock: audio time that stops advancing while an utterance plays is an
  * interrupted context or a starved media element, which on iOS sounds like the last instant on a loop.
  * The output is asked back once; a clock that stays frozen fails the utterance, so the room shows it. */
 watchClock(job){
  if(job.clock!=null||!this.context)return;
  const wall=()=>Date.now();
  job.clock={wallAt:wall(),timeAt:this.context.currentTime,stalls:0};
  const check=()=>{
   if(this.job!==job)return;
   const now=wall(),elapsed=now-job.clock.wallAt,advanced=this.context.currentTime-job.clock.timeAt;
   if(elapsed>=this.stallAfterMs){
    if(advanced<.05){
     job.clock.stalls++;this.stalls++;
     this.note('stall',this.context.state+' · '+(this.output?.element?.paused?'element paused':'element playing')+' · '+job.clock.stalls);
     if(job.clock.stalls>=this.stallLimit){this.fail(Error('La reproducción se detuvo en este dispositivo; la locución se da por fallida.'));return}
     if(this.output?.element){try{this.output.element.pause()}catch{}}
     this.resumeOutput();
    }else job.clock.stalls=0;
    job.clock.wallAt=now;job.clock.timeAt=this.context.currentTime;
   }
   job.clock.timer=setTimeout(check,this.stallCheckMs);
  };
  job.clock.timer=setTimeout(check,this.stallCheckMs);
 }
 stopClock(job){if(job.clock?.timer)clearTimeout(job.clock.timer);if(job.clock)job.clock.timer=null}
 cancel(){this.announce('','hidden');this.stopPresence('speech');const job=this.job;this.job=null;this.worker?.postMessage({type:'cancel'});if(!job)return;this.note('cancel',job.playing?'playing':'pending');this.stopProgress(job);this.stopClock(job);clearTimeout(job.timer);this.silence(job);
  // Seen on iPhone Safari (2026-09-19): after a voice is cut mid-utterance the graph keeps running and
  // reporting playback, while what leaves the element is stuck. The element gets its stream back once
  // the fade is over; a cancel while the context is stopped pauses it at once so it cannot loop.
  if(this.output?.element&&this.context?.state!=='running'){try{this.output.element.pause()}catch{}}
  job.reject(new DOMException('Audio cancelado','AbortError'))}
 ensure(device){if(this.worker&&this.device===device)return;this.worker?.terminate();this.ready=false;this.device=device;this.worker=new Worker('/voice-browser/worker.js?v='+encodeURIComponent(globalThis.sidevoiceBuildId||'dev'),{type:'module'});this.worker.onmessage=({data})=>this.receive(data);this.worker.onerror=e=>this.fail(Error(e.message||'No se pudo iniciar el motor de voz'))}
 fail(error){this.announce(error.message,this.ready?'inline':'error');this.ready=false;const job=this.job;this.note('fail',error?.message||'error');if(!job)return;this.job=null;this.stopProgress(job);this.stopClock(job);clearTimeout(job.timer);this.silence(job);this.worker?.terminate();this.worker=null;job.reject(error)}
 receive(d){const job=this.job;if(!job||d.id!==job.id)return;
  clearTimeout(job.timer);job.timer=setTimeout(()=>this.fail(Error('El modelo tardó demasiado. Vuelve a prepararlo.')),180000);
  if(d.type==='progress'){const p=d.progress;const text=p.status==='voice'?'Cargando la voz seleccionada…':p.status==='generating'?'Preparando el primer audio…':'Cargando modelo'+(p.file?' · '+p.file:'')+(p.progress!=null?' · '+Math.round(p.progress)+'%':'');job.status(text);if(!this.ready&&!job.playing)this.announce(text,'loading',p.progress??null)}
  if(d.type==='fallback'){job.status('GPU no disponible · Preparando CPU');this.announce('GPU no disponible · Preparando CPU')}
  if(d.type==='ready'){this.ready=true;this.announce('','hidden');job.status('Modelo listo · '+(d.device==='webgpu'?'GPU':'CPU'));if(job.load)this.complete(job)}
  if(d.type==='error')this.fail(Error(d.error));
  if(d.type==='audio'){this.announce('','hidden');if(this.context.state!=='running'){this.note('audio-while-stopped',this.context.state);this.resumeOutput()}
   const buffer=this.context.createBuffer(1,d.samples.length,d.sampleRate);buffer.copyToChannel(d.samples,0);
   const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.outlet(job));
   const start=Math.max(this.context.currentTime+.03,job.end);job.end=start+buffer.duration;job.sources.add(source);
   source.onended=()=>{job.sources.delete(source);if(this.job===job&&job.done&&!job.sources.size)this.complete(job)};
   const range=chunkTextRange(job.text,d.text,job.textCursor);
   if(range){job.textCursor=range.to;job.cues.push({...range,start,end:start+buffer.duration,mode:'chunk'})}
   source.start(start);this.watchProgress(job);if(!job.playing){job.playing=true;job.onPlaying()}this.watchClock(job);
   job.status('Voz en tu navegador · '+(d.device==='webgpu'?'GPU':'CPU'));
  }
  if(d.type==='done'){clearTimeout(job.timer);job.done=true;if(!job.sources.size)this.complete(job)}
 }
 complete(job){if(this.job!==job)return;this.stopProgress(job);this.stopClock(job);this.note('complete');this.announce('','hidden');clearTimeout(job.timer);this.job=null;if(job.gain){const gain=job.gain;setTimeout(()=>{try{gain.disconnect()}catch{}},200)}job.resolve()}
 run(type,options={},status=()=>{},onPlaying=()=>{},onProgress){
  this.cancel();const device=options.device||'auto';this.ensure(device);const message=type==='load'?'Cargando modelo…':'Preparando voz…';status(message);if(!this.ready)this.announce(message);
  return new Promise((resolve,reject)=>{const id=++this.serial;this.job={id,resolve,reject,status,onPlaying,onProgress,text:options.text||'',textCursor:0,cues:[],load:type==='load',sources:new Set(),end:0,done:false};this.job.timer=setTimeout(()=>this.fail(Error('No se pudo preparar el modelo a tiempo.')),180000);this.worker.postMessage({type,id,...options,device})})
 }
 playEncoded({audio_base64,text='',alignment},status=()=>{},onPlaying=()=>{},onProgress){
  this.cancel();
  return new Promise((resolve,reject)=>{
   const job=this.job={id:++this.serial,resolve,reject,status,onPlaying,onProgress,cues:[],sources:new Set(),done:true};
   job.timer=setTimeout(()=>{if(this.job===job)this.fail(Error('No se pudo preparar el audio a tiempo.'))},30000);
   (async()=>{
    await this.unlock();
    if(this.job!==job)return;
    const bytes=Uint8Array.from(atob(audio_base64),c=>c.charCodeAt(0));
    const buffer=await this.context.decodeAudioData(bytes.buffer);
    if(this.job!==job)return;
    clearTimeout(job.timer);
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.outlet(job));job.sources.add(source);
    source.onended=()=>{job.sources.delete(source);if(this.job===job)this.complete(job)};
    const start=this.context.currentTime;
    const aligned=alignedWordCues(text,alignment,buffer.duration);
    job.cues=(aligned.length?aligned:(text?[{from:0,to:text.length,start:0,end:buffer.duration,mode:'utterance'}]:[]))
     .map(cue=>({...cue,start:cue.start+start,end:cue.end+start}));
    source.start(start);job.playing=true;onPlaying();this.note('play-encoded',this.context.state);this.watchProgress(job);this.watchClock(job);status('Reproduciendo voz de ElevenLabs');
   })().catch(error=>{if(this.job===job)this.fail(error)});
  });
 }
 prepare(options,status){return this.run('load',options,status)}
 speak(options,status,onPlaying,onProgress){return this.run('speak',options,status,onPlaying,onProgress)}
}
window.roomVoice=new RoomVoice();
