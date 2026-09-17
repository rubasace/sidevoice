class BrowserTranscription{
 constructor(){
  this.worker=null;this.pending=new Map();this.nextId=0;this.runtime=null;this.socket=null;
  this.turn=null;this.preRoll=[];this.voiceRun=0;this.noise=.002;this.silenceMs=2500;
  this.language='auto';this.enabled=false;this.generation=0;
 }
 _ensureWorker(){
  if(this.worker)return;
  this.worker=new Worker('/voice-browser/stt-worker.js?v=browser-stt-2',{type:'module'});
  this.worker.onmessage=({data})=>{
   const request=this.pending.get(data.id);if(!request)return;
   if(data.type==='progress'){request.progress?.(data.progress);return}
   this.pending.delete(data.id);
   if(data.type==='error')request.reject(Error(data.error));
   else request.resolve(data.capabilities||data.runtime||data.result);
  };
  this.worker.onerror=error=>{
   for(const request of this.pending.values())request.reject(Error(error.message||'Fallo el worker de transcripcion'));
   this.pending.clear();
  };
 }
 _request(type,data={},progress,transfer=[]){
  this._ensureWorker();const id=++this.nextId;
  return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,progress});this.worker.postMessage({id,type,...data},transfer)});
 }
 async capabilities(){return this._request('capabilities')}
 _preparation(data){window.dispatchEvent(new CustomEvent('voice-preparation',{detail:{kind:'transcription',...data}}))}
 _progress(value){
  const numeric=Number(value?.progress),file=String(value?.file||'').split('/').pop();
  const downloading=value?.status==='progress'||value?.status==='download';
  this._preparation({phase:'loading',title:'Preparando transcripcion',text:(downloading?'Descargando':'Preparando')+(file?' - '+file:''),progress:Number.isFinite(numeric)?numeric:null});
 }
 async prepare({model,device}){
  this._preparation({phase:'loading',title:'Preparando transcripcion',text:'Comprobando el motor local...',progress:null});
  try{this.runtime=await this._request('load',{model,device},value=>this._progress(value));this._preparation({phase:'ready'});return this.runtime}
  catch(error){this._preparation({phase:'error',title:'No se pudo preparar la transcripcion',text:error.message,progress:null});throw error}
 }
 start({socket,silenceSeconds=2.5,language='auto'}){
  this.socket=socket;this.silenceMs=Math.max(500,Number(silenceSeconds||2.5)*1000);this.language=language;
  this.enabled=true;this.turn=null;this.preRoll=[];this.voiceRun=0;this.noise=.002;this.generation++;
 }
 stop(){
  this.enabled=false;this.socket=null;this.turn=null;this.preRoll=[];this.voiceRun=0;this.generation++;
  const error=new DOMException('Transcripción cancelada','AbortError');
  for(const request of this.pending.values())request.reject(error);this.pending.clear();
  this.worker?.postMessage({type:'cancel'});
 }
 _send(type,data){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type,data}))}
 _begin(){
  const id=crypto.randomUUID(),chunks=this.preRoll.splice(0);
  this.turn={id,chunks,samples:chunks.reduce((n,c)=>n+c.length,0),lastVoice:performance.now(),voiceRevision:0,transcribing:false,sequence:0};
  this._send('voice-input-start',{session_id:window.sidevoiceSessionId?.(),turn_id:id});
 }
 ingest(buffer){
  if(!this.enabled||!this.socket)return;
  const source=new Int16Array(buffer),samples=new Float32Array(source.length);let squares=0;
  for(let i=0;i<source.length;i++){const value=source[i]/32768;samples[i]=value;squares+=value*value}
  const rms=Math.sqrt(squares/Math.max(1,source.length)),threshold=Math.max(.012,this.noise*3),voiced=rms>threshold;
  if(!this.turn){
   if(!voiced)this.noise=this.noise*.97+rms*.03;
   this.preRoll.push(samples);if(this.preRoll.length>15)this.preRoll.shift();
   this.voiceRun=voiced?this.voiceRun+1:0;if(this.voiceRun>=4)this._begin();return;
  }
  this.turn.chunks.push(samples);this.turn.samples+=samples.length;if(voiced){this.turn.lastVoice=performance.now();this.turn.voiceRevision++}
  if(!this.turn.transcribing&&performance.now()-this.turn.lastVoice>=this.silenceMs)this._finish();
 }
 async _finish(){
  const turn=this.turn;if(!turn||turn.transcribing||!this.runtime)return;
  turn.transcribing=true;
  const snapshotSamples=turn.samples,snapshotVoiceRevision=turn.voiceRevision,sequence=++turn.sequence,audio=new Float32Array(snapshotSamples);
  let offset=0;for(const chunk of turn.chunks){audio.set(chunk,offset);offset+=chunk.length}
  const generation=this.generation;this._preparation({phase:'inline',text:'Transcribiendo en este navegador...'});
  try{
   const result=await this._request('transcribe',{audio:audio.buffer,model:this.runtime.model,device:this.runtime.device,language:this.language},null,[audio.buffer]);
   if(generation!==this.generation||this.turn!==turn)return;
   turn.transcribing=false;
   if(turn.voiceRevision!==snapshotVoiceRevision||performance.now()-turn.lastVoice<this.silenceMs){
    if(performance.now()-turn.lastVoice>=this.silenceMs)this._finish();
    return;
   }
   this._send('voice-input-transcript',{session_id:window.sidevoiceSessionId?.(),turn_id:turn.id,sequence,text:result.text,metrics:{audio_ms:Math.round(snapshotSamples/16),recognition_ms:Math.round(result.elapsed_ms),device:result.device,model:result.model}});
   this._send('voice-input-end',{session_id:window.sidevoiceSessionId?.(),turn_id:turn.id,sequence});
   this.turn=null;this.preRoll=[];this.voiceRun=0;this._preparation({phase:'hidden'});
  }catch(error){
   if(generation!==this.generation||this.turn!==turn)return;
   turn.transcribing=false;this._send('voice-input-error',{session_id:window.sidevoiceSessionId?.(),turn_id:turn.id,error:error.message});
   this.turn=null;this._preparation({phase:'error',title:'No se pudo transcribir',text:error.message,progress:null});
  }
 }
}
window.roomTranscription=new BrowserTranscription();
