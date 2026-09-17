/* Local synthesis and playout. A canceled job can never emit late audio. */
class RoomVoice {
 constructor(){this.worker=null;this.context=null;this.job=null;this.serial=0;this.device=null;this.ready=false}
 announce(text,phase='loading',progress=null){if(window.dispatchEvent)window.dispatchEvent(new CustomEvent('voice-preparation',{detail:{text,phase,progress}}))}
 async unlock(){this.context??=new AudioContext();await this.context.resume();if(this.context.state!=='running')throw Error('Permite reproducir audio en este navegador.')}
 cancel(){this.announce('','hidden');const job=this.job;this.job=null;this.worker?.postMessage({type:'cancel'});if(!job)return;clearTimeout(job.timer);for(const source of job.sources){source.onended=null;try{source.stop()}catch{}}job.reject(new DOMException('Audio cancelado','AbortError'))}
 ensure(device){if(this.worker&&this.device===device)return;this.worker?.terminate();this.ready=false;this.device=device;this.worker=new Worker('/voice-browser/worker.js',{type:'module'});this.worker.onmessage=({data})=>this.receive(data);this.worker.onerror=e=>this.fail(Error(e.message||'No se pudo iniciar el motor de voz'))}
 fail(error){this.announce(error.message,this.ready?'inline':'error');this.ready=false;const job=this.job;if(!job)return;this.job=null;clearTimeout(job.timer);for(const source of job.sources){source.onended=null;try{source.stop()}catch{}}this.worker?.terminate();this.worker=null;job.reject(error)}
 receive(d){const job=this.job;if(!job||d.id!==job.id)return;
  clearTimeout(job.timer);job.timer=setTimeout(()=>this.fail(Error('El modelo tardó demasiado. Vuelve a prepararlo.')),180000);
  if(d.type==='progress'){const p=d.progress;const text=p.status==='voice'?'Cargando la voz seleccionada…':p.status==='generating'?'Preparando el primer audio…':'Cargando modelo'+(p.file?' · '+p.file:'')+(p.progress!=null?' · '+Math.round(p.progress)+'%':'');job.status(text);if(!this.ready&&!job.playing)this.announce(text,'loading',p.progress??null)}
  if(d.type==='fallback'){job.status('GPU no disponible · Preparando CPU');this.announce('GPU no disponible · Preparando CPU')}
  if(d.type==='ready'){this.ready=true;this.announce('','hidden');job.status('Modelo listo · '+(d.device==='webgpu'?'GPU':'CPU'));if(job.load)this.complete(job)}
  if(d.type==='error')this.fail(Error(d.error));
  if(d.type==='audio'){this.announce('','hidden');
   const buffer=this.context.createBuffer(1,d.samples.length,d.sampleRate);buffer.copyToChannel(d.samples,0);
   const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);
   const start=Math.max(this.context.currentTime+.03,job.end);job.end=start+buffer.duration;job.sources.add(source);
   source.onended=()=>{job.sources.delete(source);if(this.job===job&&job.done&&!job.sources.size)this.complete(job)};
   source.start(start);if(!job.playing){job.playing=true;job.onPlaying()}
   job.status('Voz en tu navegador · '+(d.device==='webgpu'?'GPU':'CPU'));
  }
  if(d.type==='done'){clearTimeout(job.timer);job.done=true;if(!job.sources.size)this.complete(job)}
 }
 complete(job){if(this.job!==job)return;this.announce('','hidden');clearTimeout(job.timer);this.job=null;job.resolve()}
 run(type,options={},status=()=>{},onPlaying=()=>{}){
  this.cancel();const device=options.device||'auto';this.ensure(device);const message=type==='load'?'Cargando modelo…':'Preparando voz…';status(message);if(!this.ready)this.announce(message);
  return new Promise((resolve,reject)=>{const id=++this.serial;this.job={id,resolve,reject,status,onPlaying,load:type==='load',sources:new Set(),end:0,done:false};this.job.timer=setTimeout(()=>this.fail(Error('No se pudo preparar el modelo a tiempo.')),180000);this.worker.postMessage({type,id,...options,device})})
 }
 playEncoded({audio_base64},status=()=>{},onPlaying=()=>{}){
  this.cancel();
  return new Promise((resolve,reject)=>{
   const job=this.job={id:++this.serial,resolve,reject,status,onPlaying,sources:new Set(),done:true};
   job.timer=setTimeout(()=>{if(this.job===job)this.fail(Error('No se pudo preparar el audio a tiempo.'))},30000);
   (async()=>{
    await this.unlock();
    if(this.job!==job)return;
    const bytes=Uint8Array.from(atob(audio_base64),c=>c.charCodeAt(0));
    const buffer=await this.context.decodeAudioData(bytes.buffer);
    if(this.job!==job)return;
    clearTimeout(job.timer);
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);job.sources.add(source);
    source.onended=()=>{job.sources.delete(source);if(this.job===job)this.complete(job)};
    source.start();job.playing=true;onPlaying();status('Reproduciendo voz de ElevenLabs');
   })().catch(error=>{if(this.job===job)this.fail(error)});
  });
 }
 prepare(options,status){return this.run('load',options,status)}
 speak(options,status,onPlaying){return this.run('speak',options,status,onPlaying)}
}
window.roomVoice=new RoomVoice();
