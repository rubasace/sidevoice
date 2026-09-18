// Browser room orchestration. Loaded once after React mounts the stable UI shell.
const $=id=>document.getElementById(id);
function setRoomError(message){const value=message||null;if(window.sidevoiceUI)window.sidevoiceUI.setBootError(value);else $("error").textContent=value||""}
function showPreparation(d){
 const box=$('voice-loading');
 if(d.phase==='inline'){$('live').textContent=d.text;return}
 if(d.phase==='hidden'||d.phase==='ready'){if(box.open)box.close();return}
 const transcription=d.kind==='transcription';
 box.dataset.kind=d.kind||'voice';
 $('loading-title').textContent=d.title||(d.phase==='error'?'No se pudo preparar la voz':'Preparando voz');
 $('loading-note').textContent=transcription
  ?'La primera vez se descarga Whisper en este navegador. Después se reutiliza su caché local.'
  :'La primera vez se descargan el modelo y la voz. Después se reutiliza la caché de este navegador.';
 $('loading-detail').textContent=d.text||'';
 if(d.progress==null){$('loading-progress').removeAttribute('value');$('loading-percent').textContent=''}else{const progress=Math.max(0,Math.min(100,Number(d.progress)||0));$('loading-progress').value=progress;$('loading-percent').textContent=Math.round(progress)+' %'}
 $('loading-cancel').textContent=d.phase==='error'?'Cerrar':'Cancelar';
 if(!box.open)box.showModal();
}
window.addEventListener('voice-preparation',({detail:d})=>showPreparation(d));
function cancelPreparation(){if(activeSpeech){const d=activeSpeech;post('/api/presentation/browser-receipt',{session_id:d.session_id,revision:d.revision,utterance_id:d.utterance_id,status:'failed'}).catch(()=>{});cancelBrowserSpeech()}else if(previewJob)stopPreview();else if(connecting||switchingTranscription)disconnect();else window.roomVoice?.cancel();$('voice-loading').close()}
$('loading-cancel').onclick=cancelPreparation;$('voice-loading').addEventListener('cancel',e=>{e.preventDefault();cancelPreparation()});

// The room holds several browsers at once, so every question this page asks the
// room carries its own session: the answer is about this browser and no other.
function roomQuery(path){return sessionId?path+(path.includes('?')?'&':'?')+'session_id='+encodeURIComponent(sessionId):path}
let ws=null,stream=null,sessionId=null,connecting=false,connectEpoch=0,micEnabled=true,roomBinding=null,people=[],switching=false,switchingTranscription=false;
window.sidevoiceSessionId=()=>sessionId;
let audioContext=null,analyser=null,micSource=null,meterFrame=null,holding=false,spaceDown=false,userLive=false,botLive=false,pendingUser=null,pendingUserText='';
let inputDeviceId='default',outputDeviceId='default',captureNode=null,deviceEpoch=0;
let screenWakeLock=null,wakeRequest=null,wakeEpoch=0,wakeRetries=0;
const waveLevels=Array(3).fill(0);
function micTrack(){return stream?.getAudioTracks?.()[0]||null}
function applyMicState(){const track=micTrack();if(track)track.enabled=micEnabled}
function microphoneConstraints(id=inputDeviceId){
 return {echoCancellation:true,noiseSuppression:true,autoGainControl:true,
  ...(id!=='default'?{deviceId:{exact:id}}:{})};
}
async function acquireMicrophone(id=inputDeviceId){
 const next=await navigator.mediaDevices.getUserMedia({audio:microphoneConstraints(id),video:false});
 const track=next.getAudioTracks()[0];
 // "all" includes local TTS. Older browsers retain their normal AEC.
 try{if(track.getCapabilities?.().echoCancellation?.includes('all'))
  await track.applyConstraints({echoCancellation:{exact:'all'}})}catch{}
 return next;
}
function audioSession(active){try{if(navigator.audioSession)navigator.audioSession.type=active?'play-and-record':'auto'}catch{}}
/* The light by the call controls, because the sentence under them lives in the device
 * panel and a phone in a car never has that panel open. */
function showScreenLock(state,note){
 const light=$('screen-lock'),text=$('screen-lock-text');
 if(light){light.hidden=!state;if(state)light.dataset.state=state}
 if(text)text.textContent=state?note:'';
 $('screen-note').textContent=note;
}
async function keepScreenAwake(){
 // Asked for while connecting too: Safari grants the lock to the tap that started the
 // call, and by the end of the preparation chain that gesture has expired.
 if(!(ws||connecting)||document.hidden||screenWakeLock||wakeRequest)return;
 if(!globalThis.navigator?.wakeLock?.request){showScreenLock('off','Este navegador no permite mantener la pantalla encendida.');return}
 const epoch=wakeEpoch;
 const request=(async()=>{
  try{
   const lock=await navigator.wakeLock.request('screen');
   if(epoch!==wakeEpoch||document.hidden){await lock.release();return}
   screenWakeLock=lock;wakeRetries=0;showScreenLock('on','Pantalla activa durante la llamada.');
   // The system takes the lock back on its own — a screen that locked once, a route
   // change. While the call is up and the room is on screen, ask again.
   lock.addEventListener('release',()=>{
    if(screenWakeLock!==lock)return;
    screenWakeLock=null;showScreenLock('off','La pantalla puede apagarse; vuelve a la sala para mantenerla activa.');
    if(ws&&!document.hidden&&wakeRetries<3){++wakeRetries;setTimeout(()=>{if(ws&&!document.hidden)keepScreenAwake()},1000)}
   });
  }catch{showScreenLock('off','No se pudo mantener la pantalla activa. El móvil podría suspender la llamada.')}
 })();
 wakeRequest=request;
 try{await request}finally{if(wakeRequest===request)wakeRequest=null}
}
function releaseScreenWakeLock(){
 ++wakeEpoch;const lock=screenWakeLock;screenWakeLock=null;wakeRequest=null;wakeRetries=0;
 if(lock)lock.release().catch(()=>{});
 showScreenLock('','');
}
function addAudioOption(select,value,label){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option)}
async function refreshAudioDevices(){
 const input=$('input-device'),output=$('output-device'),note=$('audio-device-note');
 if(!globalThis.navigator?.mediaDevices?.enumerateDevices){input.disabled=output.disabled=true;note.textContent='Selecciona los dispositivos desde los ajustes del sistema.';return}
 try{
  const devices=await navigator.mediaDevices.enumerateDevices();
  for(const [select,kind,id] of [[input,'audioinput',inputDeviceId],[output,'audiooutput',outputDeviceId]]){
   select.replaceChildren();addAudioOption(select,'default','Predeterminado del sistema');
   const listed=devices.filter(d=>d.kind===kind&&d.deviceId&&d.deviceId!=='default');
   for(const [index,device] of listed.entries())addAudioOption(select,device.deviceId,device.label||((kind==='audioinput'?'Micrófono ':'Altavoz ')+(index+1)));
   if(id!=='default'&&!listed.some(d=>d.deviceId===id))addAudioOption(select,id,'Dispositivo seleccionado · desconectado');
   select.value=id;
  }
  output.disabled=!window.roomVoice?.supportsOutputSelection;
  note.textContent=output.disabled?'Cambia la salida desde los ajustes del sistema; este navegador no permite elegirla aquí.':'Los nombres aparecen tras conceder permiso al micrófono.';
 }catch(error){note.textContent=error.message||'No se pudieron enumerar los dispositivos.'}
}
async function replaceMicrophone(id){
 const epoch=++deviceEpoch,socket=ws,callEpoch=connectEpoch;
 if(!socket||!captureNode){inputDeviceId=id;return}
 const next=await acquireMicrophone(id);
 if(epoch!==deviceEpoch||socket!==ws||callEpoch!==connectEpoch){next.getTracks().forEach(t=>t.stop());return}
 let source;
 try{
  source=audioContext.createMediaStreamSource(next);
  next.getAudioTracks().forEach(t=>t.enabled=micEnabled);
  source.connect(analyser);source.connect(captureNode);
 }catch(error){source?.disconnect();next.getTracks().forEach(t=>t.stop());throw error}
 const previous=stream;micSource.disconnect();micSource=source;stream=next;inputDeviceId=id;
 previous.getTracks().forEach(t=>t.stop());
 await window.roomVoice.unlock();updateMic();
}
function updateWave(value){
 waveLevels.shift();waveLevels.push(value);
 const bars=$('mic-control').querySelectorAll?.('.mic-wave i')||[];
 for(const [i,bar] of [...bars].entries())bar.style.height=Math.max(3,Math.round(waveLevels[i]*.28))+'px';
}
function setDevicesOpen(open){
 $('audio-device-panel').hidden=!open;$('audio-devices').setAttribute('aria-expanded',String(open));
 $('call-controls').classList[open?'add':'remove']('devices-open');
 if(open){$('call-menu').open=false;refreshAudioDevices()}
}
function setupAudioControls(){
 $('audio-devices').onclick=()=>setDevicesOpen($('audio-device-panel').hidden);
 $('audio-settings-open').onclick=()=>{setDevicesOpen(false);$('settings-open').click()};
 $('call-settings-open').onclick=()=>{$('call-menu').open=false;$('settings-open').click()};
 $('refresh-devices').onclick=refreshAudioDevices;
 $('input-device').onchange=async()=>{const select=$('input-device');select.disabled=true;try{await replaceMicrophone(select.value);$('audio-device-note').textContent='Micrófono seleccionado.'}catch(error){select.value=inputDeviceId;$('audio-device-note').textContent=error.message}finally{select.disabled=false}};
 $('output-device').onchange=async()=>{const select=$('output-device');select.disabled=true;try{await window.roomVoice.unlock();await window.roomVoice.setOutputDevice(select.value);outputDeviceId=select.value;$('audio-device-note').textContent='Salida de audio seleccionada.'}catch(error){select.value=outputDeviceId;$('audio-device-note').textContent=error.message}finally{select.disabled=false}};
 globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange',refreshAudioDevices);
}
let pendingPhase='';let voiceCatalog=null;let voiceDraft={};let editingLanguage=null;let voicePreferences=null;let activeSpeech=null;let callExecution='browser';let roomRevision=0;let previewJob=null;let elevenCredentials={};let sttCredentials={};let rosterSignature='';let pendingBotText=[];let userTurn=null;
let cancelledInput=false;let textSending=false;let textAttempt=null;const inputReceipts=new Map();
const SHOW_ALL_VOICES='__show_all_voices__';let defaultVoicesExpanded=false;const expandedVoiceLanguages=new Set();
let viewedThread=null;let roomSeen={};try{roomSeen=JSON.parse(sessionStorage.getItem('voice-room-seen')||'{}')}catch{}
let history=[];try{history=JSON.parse(sessionStorage.getItem('voice-room-transcript')||'[]');if(!Array.isArray(history))history=[]}catch{}
function save(){try{sessionStorage.setItem('voice-room-transcript',JSON.stringify(history.slice(-1000)))}catch{}}
function targetId(){return roomBinding?.thread_id||null}
function historyThreadId(){return viewedThread||targetId()}
function unseen(id){return history.filter(r=>r.thread===id&&r.role==='assistant'&&r.seq>(roomSeen[id]||0)).length}
async function api(path,options){const r=await fetch(path,options),d=await r.json();if(!r.ok)throw Error(d.detail||'No se pudo completar la operación');return d}
const post=(path,body)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function orderedHistory(id){
 return history.filter(r=>r.thread===id).slice().sort((a,b)=>
  Number(!!a.draft)-Number(!!b.draft)||a.time-b.time||(a.seq||0)-(b.seq||0));
}
function audioNote(r){
 const reasons={newer_turn:'Empezaste otra intervención',user_speaking:'Estabas hablando',focus_changed:'Cambiaste de conversación',call_ended:'Llamada desconectada',session_changed:'La llamada había cambiado',expired_audio_turn:'El turno de audio había caducado',queue_full:'Cola de audio llena',user_interrupted:'Interrumpiste el audio',playback_failed:'Falló la reproducción',service_restarted:'Se reinició el servicio',channel_closed:'Canal de voz cerrado'};
 const reason=reasons[r.audio_reason];
 if(r.audio==='waiting_for_pause')return 'Audio pendiente · Breve pausa antes de hablar';
 if(r.audio==='waiting_for_turn')return 'Audio pendiente · Esperando a que termines de hablar';
 if(r.audio==='text_only')return 'Sin audio'+(reason?' · '+reason:' · Motivo no registrado');
 if(r.audio==='interrupted'||r.audio==='disconnected'||r.interrupted)return 'Audio interrumpido'+(reason?' · '+reason:'')+' · El texto puede incluir partes que no sonaron';
 if(r.audio==='failed')return 'Audio no reproducido · Falló la reproducción';
 return '';
}
function playbackState(r){
 if(r.role!=='assistant')return undefined;
 const active=activeSpeech&&r.segment===speechSegment(activeSpeech);
 if(active)return activeSpeech.started?'playing':'pending';
 if(['queued','synthesizing','waiting_for_turn','waiting_for_pause'].includes(r.audio))return 'pending';
 if(r.audio==='playing')return 'playing';
 return 'complete';
}
const karaokeNodes=new Map();
let karaokeState=null;
function speechSegment(speech){return speech.history_id||speech.session_id+':voice:'+speech.utterance_id}
function paintKaraoke(node,text,range,playback='complete'){
 node.className='karaoke-text';node.setAttribute('aria-live','off');
 node.removeAttribute('title');node.removeAttribute('data-progress');
 const valid=range&&Number.isInteger(range.from)&&Number.isInteger(range.to)&&range.from>=0&&range.to>range.from&&range.to<=text.length;
 node.dataset.playback=valid?'playing':playback;
 if(!valid){node.textContent=text;return}
 // Only what has been said is coloured; no mark on the current word.
 const played=document.createElement('span'),upcoming=document.createElement('span');
 played.textContent=text.slice(0,range.to);upcoming.textContent=text.slice(range.to);
 played.className='karaoke-played';upcoming.className='karaoke-upcoming';node.dataset.progress='true';
 node.title=range.mode==='word'?'Siguiendo la voz · palabras':range.mode==='chunk'?'Siguiendo la voz · fragmentos':'Reproduciendo esta respuesta';
 node.replaceChildren(played,upcoming);
}
function clearKaraoke(speech){
 const segment=speechSegment(speech);
 if(karaokeState?.segment!==segment)return;
 karaokeState=null;if(window.sidevoiceUI){renderHistory();return}const saved=karaokeNodes.get(segment);
 if(saved)paintKaraoke(saved.node,saved.text,null);
}
function updateKaraoke(speech,range){
 if(activeSpeech!==speech||speech.session_id!==sessionId)return;
 if(!range){clearKaraoke(speech);return}
 const segment=speechSegment(speech);
 karaokeState={segment,...range};
 if(window.sidevoiceUI){if(window.sidevoiceUI.updateKaraoke)window.sidevoiceUI.updateKaraoke(segment,{...range});else renderHistory();return}
 const saved=karaokeNodes.get(segment);if(saved)paintKaraoke(saved.node,saved.text,range,'playing');
}
function renderHistory(){karaokeNodes.clear();const id=historyThreadId();roomSeen[id]=Math.max(roomSeen[id]||0,...history.filter(r=>r.thread===id).map(r=>r.seq||0));try{sessionStorage.setItem('voice-room-seen',JSON.stringify(roomSeen))}catch{};const records=orderedHistory(historyThreadId());if(window.sidevoiceUI){const activeDraft=userTurn&&userTurn.thread===id?sessionId+':'+userTurn.key:null;window.sidevoiceUI.setConversation({messages:records.map(r=>({...r,cancellable:!!activeDraft&&!cancelledInput&&r.draft===true&&r.segment===activeDraft,audioNote:audioNote(r),playback:playbackState(r),karaoke:karaokeState?.segment===r.segment?karaokeState:null})),pendingText:userTurn?.thread===id?pendingUserText:'',pendingPhase:userTurn?.thread===id&&!cancelledInput?pendingPhase:'',pendingCancellable:!!userTurn&&!cancelledInput});return}if(!records.length&&!pendingUserText&&!pendingPhase){$('messages').innerHTML='<div class="empty"><b>Hablemos de lo que sigue.</b><span>Tu voz y la respuesta aparecerán aquí.<br>El historial de la sala se conserva al reconectar.</span></div>';return}const box=$('messages');box.replaceChildren();for(const [i,r] of records.entries()){const row=document.createElement('div');row.className='message '+r.role+(i===records.length-1?' latest':'')+(r.interrupted?' interrupted':'');const label=document.createElement('span');label.className='who';label.textContent=r.name;const text=document.createElement('span');karaokeNodes.set(r.segment,{node:text,text:r.text});paintKaraoke(text,r.text,karaokeState?.segment===r.segment?karaokeState:null,playbackState(r));row.append(label,text);const metadata=document.createElement('div');metadata.className='message-meta';if(!r.draft){const time=document.createElement('time');time.className='message-time';time.textContent=new Date(r.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});metadata.append(time)}else if(userTurn&&!cancelledInput){row.append(cancelInputButton())}if(r.role==='user'&&r.delivery){const receipt=document.createElement('span');receipt.className='receipt delivery'+(r.delivery==='unconfirmed'?' unconfirmed':'');receipt.textContent=({pending:'◷',sending:'◷',delivered:'✓',unconfirmed:'✓',uncertain:'!',not_sent:'!'})[r.delivery]||'';receipt.title=({pending:'Enviando',sending:'Enviando',delivered:'Entregado a la conversación; lectura sin confirmar',unconfirmed:'Escrito en la conversación, sin acuse: este harness no confirma la entrega',uncertain:'Entrega sin confirmar',not_sent:'No enviado'})[r.delivery]||'';receipt.setAttribute('aria-label',receipt.title);metadata.append(receipt)}if(metadata.children.length)row.append(metadata);const explanation=audioNote(r);if(explanation){const note=document.createElement('span');note.className='receipt';note.textContent=explanation;row.append(note)}box.append(row)}renderPendingUser();box.scrollTop=box.scrollHeight}
function add(role,text,segment,thread=targetId(),metadata={}){if(!text?.trim())return;const key=metadata.history_id||(segment==null?null:sessionId+':'+segment);const existing=key&&history.find(r=>r.segment===key);if(existing){Object.assign(existing,{text},metadata);save();renderHistory();return}history.push({segment:key,thread,role,text,session:sessionId,revision:segment?.toString().startsWith('user-turn:')?Number(segment.slice(10)):undefined,...metadata,name:role==='user'?'Tú':people.find(p=>p.thread_id===thread)?.title||roomBinding?.title||'Conversación',time:Date.now()});history=history.slice(-1000);save();renderHistory()}
async function cancelCurrentInput(){if(!userTurn||cancelledInput)return;const revision=Number(userTurn.key.slice(10));try{await post("/api/presentation/cancel-input",{session_id:sessionId,revision});cancelDraft(revision)}catch(e){setRoomError(e.message);throw e}}
function cancelInputButton(){const btn=document.createElement("button");btn.className="cancel-input";btn.textContent="Cancelar envío";btn.onclick=async()=>{btn.disabled=true;try{await cancelCurrentInput()}catch{btn.disabled=false}};return btn}
function cancelDraft(revision){cancelledInput=true;history=history.filter(r=>r.segment!==sessionId+':user-turn:'+revision);save();partial('');renderHistory()}
function renderPendingUser(){if(window.sidevoiceUI){renderHistory();return}pendingUser=null;if(!(pendingUserText||pendingPhase)||userTurn?.thread!==historyThreadId())return;$('messages').querySelector('.empty')?.remove();const row=document.createElement('div');row.className='message user partial';row.textContent=pendingUserText||(pendingPhase==='transcribing'?'Transcribiendo…':'Escuchando…');if(userTurn&&!cancelledInput)row.append(cancelInputButton());pendingUser=row;$('messages').append(row)}
function partial(text){pendingUser?.remove();pendingUser=null;pendingUserText=text||'';renderPendingUser();$('messages').scrollTop=$('messages').scrollHeight}
function updateComposer(){const ready=!!ws&&!!sessionId&&!!targetId()&&historyThreadId()===targetId()&&!switching;$('text-message').disabled=!ready;$('text-send').disabled=!ready||textSending;$('text-message').placeholder=ready?'Escribe un mensaje…':'Entra en la sala y selecciona una conversación';}
$('text-composer').onsubmit=async event=>{event.preventDefault();const input=$('text-message'),text=input.value;if(textSending||!text.trim()||!sessionId||!targetId())return;const destination=targetId(),key=JSON.stringify([sessionId,destination,text]);if(textAttempt?.key!==key)textAttempt={key,id:crypto.randomUUID()};const attempt=textAttempt;textSending=true;updateComposer();setRoomError('');try{await post('/api/presentation/text',{text,thread_id:destination,session_id:sessionId,binding_id:roomBinding.binding_id,message_id:attempt.id});if(input.value===text)input.value='';if(textAttempt===attempt)textAttempt=null;await refreshHistory()}catch(e){setRoomError(e.message||'No se pudo confirmar el envío. El texto se conserva.')}finally{textSending=false;updateComposer()}};
$('text-message').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('text-composer').requestSubmit()}});
function updateMic(){const enabled=micTrack()?.enabled??micEnabled;$('mic-control').dataset.muted=String(!enabled);const label=enabled?'Silenciar micrófono':'Activar micrófono';$('mute').setAttribute('aria-label',label);$('mute').setAttribute('title',label+' (⌘D / Ctrl+D). Mantén Espacio para hablar si está silenciado.');$('mute').setAttribute('aria-pressed',String(!enabled));updateComposer();live()}
function setMic(enabled){stopPreview();micEnabled=enabled;applyMicState();updateMic()}
function releaseHold(){spaceDown=false;$('mute').classList.remove('holding');if(holding){holding=false;setMic(false)}}
function live(){const queued=!userLive&&!botLive&&ws&&roomBinding?.thread_id;$('live').textContent=ws&&stream&&!micTrack()?.enabled?'Micrófono silenciado':userLive?'Te estamos escuchando…':botLive?'La conversación está hablando · Puedes interrumpir':queued?'Puedes hablar. La transcripción aparece al completar tu intervención.':ws?'Estás en la sala · Esperando a una conversación':'Entra en la sala para hablar.'}
function renderPeople(){const signature=JSON.stringify([people.map(p=>[p.thread_id,p.title,p.available,p.reach?.state]),roomBinding?.thread_id,roomBinding?.title,switching,history.filter(r=>r.role==='assistant').map(r=>[r.thread,r.seq]),roomSeen]);if(signature===rosterSignature)return;rosterSignature=signature;const box=$("participants");let entries=[...people];for(const r of history)if(r.thread&&!entries.some(p=>p.thread_id===r.thread))entries.push({thread_id:r.thread,title:r.name==='Tú'?'Conversación':r.name,available:false});if(targetId()&&!entries.some(p=>p.thread_id===targetId()))entries.unshift({thread_id:targetId(),title:roomBinding.title,available:true});if(window.sidevoiceUI){window.sidevoiceUI.setParticipants(entries.map(p=>{const selected=p.thread_id===targetId(),unread=unseen(p.thread_id),reach=p.reach?.state||(p.available?"listening":"offline"),base=reach==="listening"?(unread?unread+" nuevas":"Escuchando"):reach==="holding"?"No puede recibir":(p.available?"Sin poder recibir":"Desconectada");return {threadId:p.thread_id,title:p.title,selected,available:!!p.available,switching,unread,reach,stateLabel:unread&&reach!=="listening"?base+" · "+unread+" nuevas":base,detail:p.reach?.detail?(p.reach.detail+(p.reach.remedy?"\n\n"+p.reach.remedy:"")):undefined}}));return}box.replaceChildren();for(const p of entries){const selected=p.thread_id===targetId(),btn=document.createElement('button');btn.className='person'+(selected?' selected':'');btn.disabled=switching;btn.setAttribute('aria-pressed',String(selected));const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent='AI';const info=document.createElement('div'),name=document.createElement('div'),state=document.createElement('div');name.className='person-name';name.textContent=p.title;state.className='person-state';const count=unseen(p.thread_id),reach=p.reach?.state||(p.available?'listening':'offline');
 // "Connected" and "will receive what you say" are different things: never show one as the other.
 if(reach!=='listening')btn.classList.add('unreachable');
 state.dataset.state=reach;
 const label=reach==='listening'?(count?count+' nuevas':'Escuchando')
  :reach==='holding'?'No puede recibir'
  :(p.available?'Sin poder recibir':'Desconectada');
 const dot=document.createElement('span');dot.className='dot';
 state.replaceChildren(dot,document.createTextNode(count&&reach!=='listening'?label+' · '+count+' nuevas':label));
 if(p.reach?.detail)btn.title=p.reach.detail+(p.reach.remedy?'\n\n'+p.reach.remedy:'');
 state.hidden=false;info.append(name,state);btn.append(avatar,info);btn.onclick=()=>{viewedThread=p.thread_id;renderHistory();$('transcript-title').textContent=p.title;renderPeople();if(p.available)select(p.thread_id);updateComposer()};{const row=document.createElement('div');row.className='participant-row'+(selected?' selected':'');const menu=document.createElement('details');menu.className='participant-menu';const more=document.createElement('summary');more.textContent='⋯';more.title='Opciones de conversación';more.setAttribute('aria-label','Opciones de conversación');const close=document.createElement('button');close.className='close-channel';close.textContent='Cerrar conversación';close.title='Cerrar conversación';close.setAttribute('aria-label','Cerrar conversación');close.onclick=async()=>{close.disabled=true;try{await post('/api/presentation/close',{thread_id:p.thread_id});await refresh();await refreshPeople();await refreshHistory()}catch(e){setRoomError(e.message);close.disabled=false}};menu.append(more,close);row.append(btn,menu);box.append(row)}}}
document.addEventListener('click',event=>{if(!$('call-controls').contains(event.target))setDevicesOpen(false);for(const menu of document.querySelectorAll('.participant-menu[open],.call-menu[open]'))if(!menu.contains(event.target))menu.open=false});
document.addEventListener('keydown',event=>{if(event.key==='Escape')setDevicesOpen(false);if(event.key==='Escape')for(const menu of document.querySelectorAll('.participant-menu[open],.call-menu[open]'))menu.open=false});
async function select(id){if(switching||id===targetId())return;switching=true;renderPeople();$('live').textContent='Cambiando de conversación…';try{await post('/api/presentation/select',{thread_id:id});await refresh()}catch(e){setRoomError(e.message)}finally{switching=false;renderPeople()}}
async function refresh(){try{
 const d=await api(roomQuery('/api/presentation'));
 const changed=roomBinding?.binding_id!==d.binding?.binding_id;roomBinding=d.binding;
 if(changed){viewedThread=null;cancelBrowserSpeech();pendingBotText=[];pendingUser=null;pendingUserText='';userLive=botLive=false;renderHistory();live()}
 renderPeople();updateComposer();
 $('transcript-title').textContent=people.find(p=>p.thread_id===historyThreadId())?.title||roomBinding?.title||'Conversación en directo';
 const call=d.call?.id===sessionId?d.call:null;if(call?.error)setRoomError(call.error);
}catch{$('live').textContent='Servidor no disponible'}}
async function refreshHistory(){try{const data=await api('/api/presentation/history');let changed=false;for(const r of data.messages){const marker=':voice:',suffix=r.role==='assistant'&&r.id.includes(marker)?r.id.slice(r.id.lastIndexOf(marker)):null;let row=history.find(h=>h.segment===r.id);const aliases=suffix?history.filter(h=>h!==row&&h.role==='assistant'&&h.segment?.endsWith(suffix)&&h.thread===r.thread&&h.text===r.text):[];if(!row&&aliases.length){row=aliases.shift();changed=true}if(aliases.length){history=history.filter(h=>!aliases.includes(h));changed=true}const patch={segment:r.id,thread:r.thread,role:r.role,text:r.text,name:r.role==='user'?'Tú':people.find(p=>p.thread_id===r.thread)?.title||r.name,time:r.time,seq:r.seq,session:r.session,revision:r.revision,audio_reason:r.audio_reason,interrupted:['interrupted','disconnected'].includes(r.status),draft:false,delivery:r.role==='user'?r.status:undefined,audio:r.role==='assistant'?r.status:undefined};if(!row){history.push(patch);changed=true}else if(JSON.stringify({...row,...patch})!==JSON.stringify(row)){Object.assign(row,patch);changed=true}}if(changed){history=history.slice(-1000);save();renderHistory();renderPeople()}}catch{}}
$('pair-connector').onclick=async()=>{try{const r=await post('/api/connectors/pairing-code',{});$('pair-code').textContent=r.code;$('pair-code').hidden=false;$('pair-help').hidden=false}catch(e){setRoomError(e.message||'No se pudo generar el código')}}
async function selectOnlyListeningConversation(){
 if(targetId()||switching||!ws)return false;
 const listening=people.filter(person=>person.available&&person.reach?.state==='listening');
 if(listening.length!==1)return false;
 await select(listening[0].thread_id);return true;
}
async function refreshPeople(){try{const data=await api('/api/presentation/participants');people=data.participants;renderPeople();await selectOnlyListeningConversation()}catch{}}
// Stats poll only while the modal is open; each opening owns its requests.
let statsEpoch=0,statsTimer=null,statsRequest=null;
const statsNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function statsDuration(value){return statsNumber(value)?(value<1000?Math.round(value)+' ms':(value/1000).toFixed(2)+' s'):'—'}
function statsMedian(values){
 const sorted=values.filter(statsNumber).sort((a,b)=>a-b),n=sorted.length;
 return n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:null;
}
function statsCell(tag,value){const node=document.createElement(tag);node.textContent=String(value??'—');return node}
function renderLatencyStats(snapshot,thread){
 const replies=(Array.isArray(snapshot?.replies)?snapshot.replies:[]).filter(r=>r&&r.thread_id===thread);
 const firstReplies=new Map();
 for(const reply of replies){const key=reply.reply_revision,value=reply.server_ms?.input_queued_to_reply_received_ms;
  if(statsNumber(value)&&(!firstReplies.has(key)||value<firstReplies.get(key)))firstReplies.set(key,value)}
 $('stats-endpoint').textContent=statsDuration(statsMedian(replies.map(r=>r.input_ms?.speech_end_to_transcript_ms)));
 $('stats-response').textContent=statsDuration(statsMedian([...firstReplies.values()]));
 $('stats-synthesis').textContent=statsDuration(statsMedian(replies.map(r=>r.provider_ms?.request_to_complete_ms)));
 $('stats-playout').textContent=statsDuration(statsMedian(replies.map(r=>r.browser_ms?.audio_received_to_playback_scheduled_ms)));
 const states={queued:'En cola',synthesizing:'Generando voz',ready:'Audio listo',dispatched:'Audio enviado',playing:'Reproduciendo',completed:'Reproducción terminada',interrupted:'Interrumpida',failed:'Falló',disconnected:'Desconectada'};
 const rows=replies.slice(-12).reverse().map(r=>{
  const row=document.createElement('tr'),input=r.input_ms||{},server=r.server_ms||{},provider=r.provider_ms||{};
  row.append(statsCell('td',r.reply_revision),...[
   input.speech_end_to_transcript_ms,input.endpoint_silence_ms,input.recognition_ms,
   server.input_queued_to_reply_received_ms,server.reply_received_to_synthesis_started_ms,
   provider.request_to_first_chunk_ms,provider.request_to_complete_ms,
   r.browser_ms?.audio_received_to_playback_scheduled_ms
  ].map(value=>statsCell('td',statsDuration(value))),statsCell('td',states[r.status]||r.status||'—'));
  return row;
 });
 $('stats-rows').replaceChildren(...rows);
 $('stats-empty').textContent=replies.length?'':'Aún no hay respuestas medidas para esta conversación.';
 renderLatencyStages(replies.at(-1));
}
// The last turn, stage by stage in the order they happen; each measured on its own clock, so bars compare, they do not add up.
const LATENCY_STAGES=[
 ['Silencio hasta cerrar el turno',r=>r.input_ms?.endpoint_silence_ms],
 ['Turno cerrado → texto',r=>r.input_ms?.recognition_ms],
 ['Whisper en este navegador',r=>r.input_ms?.request_to_transcript_ms],
 ['Texto → entregado al agente',r=>r.input_ms?.transcript_to_delivery_ms],
 ['Agente: entrega → primera respuesta',r=>r.server_ms?.input_queued_to_reply_received_ms],
 ['Respuesta → inicio de síntesis',r=>r.server_ms?.reply_received_to_synthesis_started_ms],
 ['Síntesis en el proveedor',r=>r.provider_ms?.request_to_complete_ms],
 ['Audio recibido → reproducción',r=>r.browser_ms?.audio_received_to_playback_scheduled_ms],
];
function renderLatencyStages(reply){
 const list=$('stats-stages');if(!list)return;list.replaceChildren();
 if(!reply){$('stats-stages-note').textContent='Aún no hay un turno completo que mostrar.';return}
 const values=LATENCY_STAGES.map(([label,pick])=>[label,pick(reply)]),max=Math.max(1,...values.map(([,v])=>statsNumber(v)?v:0));
 for(const [label,value] of values){const item=document.createElement('li');const name=document.createElement('span');name.textContent=label;const bar=document.createElement('i');if(statsNumber(value))bar.style.width=Math.max(1,Math.round(value/max*100))+'%';else bar.hidden=true;const amount=document.createElement('b');amount.textContent=statsDuration(value);item.append(name,bar,amount);list.append(item)}
 $('stats-stages-note').textContent='Turno '+reply.reply_revision+' · el tramo más largo marca la escala.';
}
function renderConnectionStats(data,roundTrip){
 const call=sessionId&&data?.call?.id===sessionId?data.call:null,track=micTrack(),settings=track?.getSettings?.()||{};
 const selectedLabel=id=>$(id).selectedOptions?.[0]?.textContent||'Predeterminado del sistema';
 const flag=value=>value===true||value==='all'?'Activado':value===false?'Desactivado':'No confirmado';
 const socket=['Conectando','Conectado','Cerrando','Desconectado'][ws?.readyState]||'Desconectado';
 const context=window.roomVoice?.context||audioContext,stt=call?.transcription;
 const sttReasons={explicit:'Selección explícita',auto_key:'Automático · clave disponible',auto_no_key:'Automático · sin clave, fallback local',openai_without_key:'OpenAI solicitado sin clave · fallback local'};
 const sttExecution=!stt?'—':stt.location==='local'
  ?[stt.device,stt.compute_type].filter(Boolean).join(' · ')
  :'Remota';
 const facts=[
  ['WebSocket',socket],
  ['Consulta al servidor (HTTP)',statsDuration(roundTrip)],
  ['Sesión',sessionId||'Sin llamada'],
  ['Servidor y navegador',call?'Misma sesión':sessionId?'Sesión no confirmada':'Sin llamada'],
  ['Transcripción',stt?[stt.provider,stt.model].filter(Boolean).join(' · '):'—'],
  ['Motor STT',stt?.engine||'—'],
  ['Ejecución STT',sttExecution],
  ['Selección STT',sttReasons[stt?.reason]||stt?.reason||'—'],
  ['Motor de audio',({running:'Activo',suspended:'Suspendido',closed:'Cerrado'})[context?.state]||'No iniciado'],
  ['Micrófono',track?.label||selectedLabel('input-device')],
  ['Captura',!track?'No iniciada':track.readyState==='ended'?'Finalizada':track.muted?'Sin señal del dispositivo':track.enabled?'Activa':'Silenciada'],
  ['Altavoces',selectedLabel('output-device')],
  ['Cancelación de eco',flag(settings.echoCancellation)],
  ['Reducción de ruido',flag(settings.noiseSuppression)],
  ['Frecuencia de captura',statsNumber(settings.sampleRate)?settings.sampleRate+' Hz':'—'],
  ['Audio recibido por el servidor',call?.mic?call.mic.frames+' frames · '+call.mic.bytes+' bytes':'—'],
  ['Último hueco entre paquetes',call?.mic?statsDuration(call.mic.last_gap_ms):'—'],
  ['Mayor hueco entre paquetes',call?.mic?statsDuration(call.mic.max_gap_ms):'—'],
  ['Huecos de más de 250 ms',call?.mic?call.mic.gaps_over_250ms:'—'],
  ['Pantalla activa',screenWakeLock&&!screenWakeLock.released?'Activado':'No confirmado']
 ];
 $('stats-connection').replaceChildren(...facts.flatMap(([label,value])=>[statsCell('dt',label),statsCell('dd',value)]));
}
function resetStats(){renderLatencyStats(null,null);$('stats-connection').replaceChildren();$('stats-updated').textContent=''}
async function refreshConnectionStats(){
 if(!$('connection-stats').open||statsRequest)return;
 const epoch=statsEpoch,callId=sessionId,thread=targetId(),controller=new AbortController();
 statsRequest=controller;$('stats-refresh').disabled=true;
 const timeout=setTimeout(()=>controller.abort(),5000);
 const started=latencyNow();
 try{
  const [connection,latency]=await Promise.allSettled([
   api(roomQuery('/api/presentation'),{signal:controller.signal}).then(data=>({data,elapsed:latencyNow()-started})),
   fetch(roomQuery('/api/presentation/latency'),{signal:controller.signal}).then(async response=>{
    if(response.status===404)return {unavailable:true};
    if(!response.ok)throw Error('No se pudieron consultar las mediciones.');
    return response.json();
   })
  ]);
  if(epoch!==statsEpoch||!$('connection-stats').open)return;
  if(callId!==sessionId||thread!==targetId()){resetStats();$('stats-status').textContent='La conversación ha cambiado. Actualizando…';return}
  if(connection.status==='fulfilled')renderConnectionStats(connection.value.data,connection.value.elapsed);
  else renderConnectionStats(null,null);
  const snapshot=latency.status==='fulfilled'?latency.value:null;
  const matches=!!callId&&snapshot?.session_id===callId;
  renderLatencyStats(matches?snapshot:null,thread);
  if(connection.status==='rejected'||latency.status==='rejected')$('stats-status').textContent='No se pudo actualizar. Se reintentará mientras esta vista esté abierta.';
  else if(snapshot?.unavailable)$('stats-status').textContent='Este servidor aún no ofrece mediciones. Hace falta reiniciarlo con la versión actualizada.';
  else if(!callId)$('stats-status').textContent='Entra en la sala para medir esta llamada.';
  else if(!matches)$('stats-status').textContent='Esperando las mediciones de esta sesión.';
  else $('stats-status').textContent='Mediciones de esta conversación · actualización cada 2 segundos';
  $('stats-updated').textContent=new Date().toLocaleTimeString();
 }finally{
  clearTimeout(timeout);
  if(statsRequest===controller){statsRequest=null;$('stats-refresh').disabled=false}
  if(epoch===statsEpoch&&$('connection-stats').open){clearTimeout(statsTimer);statsTimer=setTimeout(refreshConnectionStats,2000)}
 }
}
function stopConnectionStats(){
 ++statsEpoch;clearTimeout(statsTimer);statsTimer=null;statsRequest?.abort();statsRequest=null;$('stats-refresh').disabled=false;
}
function openConnectionStats(){
 stopConnectionStats();$('call-menu').open=false;setDevicesOpen(false);resetStats();
 $('stats-status').textContent='Recogiendo mediciones…';
 if(!$('connection-stats').open)$('connection-stats').showModal();
 return refreshConnectionStats();
}
$('stats-open').onclick=openConnectionStats;
$('stats-close').onclick=()=>$('connection-stats').close();
$('stats-refresh').onclick=()=>{clearTimeout(statsTimer);return refreshConnectionStats()};
$('connection-stats').addEventListener('close',stopConnectionStats);
$('connection-stats').addEventListener('cancel',stopConnectionStats);
// A backdrop click closes the modal without swallowing clicks inside its scroll area.
$('connection-stats').addEventListener('click',event=>{if(event.target!==$('connection-stats'))return;const box=event.target.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)event.target.close()});
// Diagnostic durations only. These events originate on the server; they are not raw mic timestamps.
const latencyTurns=new Map();
let latencyActiveTurn=null;
function latencyNow(){return globalThis.performance?.now?.()}
function latencyKey(thread,revision){return JSON.stringify([sessionId,thread,revision])}
function observeLatencyEvent(type,data){
 const now=latencyNow();if(!Number.isFinite(now))return;
 if(type==='voice-user-turn'){
  const key=latencyKey(data.thread_id,data.revision);
  if(data.phase==='started'){latencyActiveTurn=key;if(!latencyTurns.has(key))latencyTurns.set(key,{})}
  if(data.phase==='cancelled'){latencyTurns.delete(key);if(latencyActiveTurn===key)latencyActiveTurn=null}
  if(data.phase==='finished'){const turn=latencyTurns.get(key)||{};turn.finished=now;latencyTurns.set(key,turn)}
  if(latencyTurns.size>128)latencyTurns.delete(latencyTurns.keys().next().value);
 }else if(type==='user-stopped-speaking'){
  const turn=latencyTurns.get(latencyActiveTurn);if(turn)turn.vadStop=now;
 }else if(type==='user-started-speaking'){
  const turn=latencyTurns.get(latencyActiveTurn);if(turn&&!Number.isFinite(turn.finished))delete turn.vadStop;
 }
}
function browserLatency(d,received){
 const now=latencyNow();if(!Number.isFinite(now)||!Number.isFinite(received))return {};
 const durations={audio_received_to_playback_scheduled_ms:now-received};
 const turn=latencyTurns.get(latencyKey(d.thread_id,d.reply_revision??d.revision));
 if(Number.isFinite(turn?.finished)){
  durations.turn_finished_event_to_playback_scheduled_ms=now-turn.finished;
  if(Number.isFinite(turn.vadStop))durations.vad_stop_event_to_turn_finished_event_ms=turn.finished-turn.vadStop;
 }
 return Object.fromEntries(Object.entries(durations).filter(([,v])=>Number.isFinite(v)&&v>=0&&v<=3600000));
}
function message(raw){let m;try{m=JSON.parse(raw)}catch{return}const t=m.type,d=m.data||{};observeLatencyEvent(t,d);if(t==='voice-transcribe'){if(d.session_id===sessionId)window.roomTranscription.transcribe(d);return}if(t==='voice-speech'){receiveBrowserSpeech(d);return}if(t==='voice-speech-audio'){receiveServerSpeech(d);return}if(t==='voice-cancel'&&d.session_id===sessionId){roomRevision=Math.max(roomRevision,d.revision);cancelBrowserSpeech();return}if(t==='voice-user-turn'&&d.phase==='started'){roomRevision=Math.max(roomRevision,d.revision);cancelBrowserSpeech()}if(t==='voice-input-receipt'){const receiptId=d.history_id||(d.session_id||sessionId)+':user-turn:'+d.revision;const row=history.find(r=>r.thread===d.thread_id&&r.segment===receiptId);if(row){row.delivery=d.status;save();renderHistory()}else inputReceipts.set(receiptId,d.status)}if(t==='voice-user-turn'){const key='user-turn:'+d.revision,receiptId=(d.session_id||sessionId)+':'+key;if(d.phase==='started'){cancelledInput=false;userTurn={key,text:'',thread:d.thread_id};pendingPhase='listening';partial('')}else if(d.phase==='cancelled'){inputReceipts.delete(receiptId);if(d.merged){/* the room held this text for the turn now open: same bubble, nothing to remove */history=history.filter(r=>r.segment!==sessionId+':user-turn:'+d.revision);renderHistory()}else{pendingPhase='';cancelDraft(d.revision)}}else if(d.phase==='finished'){pendingPhase='';partial('');add('user',d.text,key,d.thread_id,{draft:false,time:Date.now(),delivery:d.thread_id?(inputReceipts.get(receiptId)||'pending'):'not_sent'});inputReceipts.delete(receiptId);userTurn=null}}if(t==='user-transcription'&&!cancelledInput){if(d.final){partial('');if(userTurn){userTurn.text=[userTurn.text,d.text].filter(Boolean).join(' ');add('user',userTurn.text,userTurn.key,userTurn.thread,{draft:true})}}else if(!userTurn||userTurn.thread===historyThreadId())partial(d.text)}if(t==='bot-output'&&!['word','token'].includes(d.aggregated_by)){const completed=d.spoken===true||d.spoken_status==='completed';const index=completed?pendingBotText.indexOf(d.text):-1;if(index>=0){pendingBotText.splice(index,1)}else{add('assistant',d.text,d.segment_id);if(d.spoken===false||d.spoken_status==='new')pendingBotText.push(d.text)}}if(t==='bot-started-speaking'){stopPreview();botLive=true;live()}if(t==='bot-stopped-speaking'){botLive=false;live()}if(t==='user-started-speaking'){if(userTurn){pendingPhase='listening';renderHistory()}cancelBrowserSpeech();userLive=true;if(botLive){const last=[...history].reverse().find(r=>r.thread===targetId()&&r.role==='assistant');if(last){last.interrupted=true;save();renderHistory()}}botLive=false;live()}if(t==='user-stopped-speaking'){if(userTurn&&pendingPhase==='listening'){pendingPhase='transcribing';renderHistory()}userLive=false;$('live').textContent='Procesando tu intervención…'}if(t==='error')setRoomError(d.message||d.error||'Error de conexión')}
function stopMeter(){cancelAnimationFrame(meterFrame);meterFrame=null;captureNode?.disconnect();captureNode=null;micSource?.disconnect();analyser?.disconnect();if(audioContext&&audioContext!==window.roomVoice?.context)audioContext.close().catch(()=>{});audioContext=null;analyser=null;micSource=null;$('mute').style.setProperty('--mic-fill','0%');$('mic-control').dataset.signal='quiet';$('mic-level-meter').setAttribute('aria-valuenow','0');waveLevels.fill(0);updateWave(0)}
function measureMic(samples,enabled){
 if(!enabled)return {value:0,state:'quiet',peak:0};
 let squares=0,peak=0;for(const sample of samples){squares+=sample*sample;peak=Math.max(peak,Math.abs(sample))}
 const rms=Math.sqrt(squares/samples.length),db=20*Math.log10(Math.max(rms,1e-6));
 return {value:Math.max(0,Math.min(100,Math.round((db+60)/60*100))),peak,state:peak>=.98?'clip':peak>=.8?'high':rms>.001?'normal':'quiet'};
}
function startMeter(rate){try{audioContext=window.roomVoice?.context||roomAudioContext(rate);analyser=audioContext.createAnalyser();analyser.fftSize=1024;micSource=audioContext.createMediaStreamSource(stream);micSource.connect(analyser);const data=new Float32Array(1024);let clipUntil=0,lastWave=0;function tick(){if(!analyser)return;analyser.getFloatTimeDomainData(data);const enabled=!!stream?.getAudioTracks()[0]?.enabled,level=measureMic(data,enabled);if(level.state==='clip')clipUntil=Date.now()+600;const state=enabled&&Date.now()<clipUntil?'clip':level.state;$('mute').style.setProperty('--mic-fill',level.value+'%');const meter=$('mic-level-meter'),mic=$('mic-control');mic.dataset.signal=state;if(Date.now()-lastWave>=80){updateWave(level.value);lastWave=Date.now()}meter.setAttribute('aria-valuenow',String(level.value));const description=state==='clip'?'Posible saturación del micrófono':state==='high'?'Nivel de micrófono alto':'Nivel de micrófono';if(meter.dataset.signal!==state){meter.dataset.signal=state;meter.setAttribute('title',description);meter.setAttribute('aria-label',description)}meterFrame=requestAnimationFrame(tick)}tick()}catch{}}
function roomSocketUrl(){return (location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/presentation/ws'}
// The room speaks first: its call id and the PCM format it expects. Anything else arriving meanwhile is an ordinary room event.
function openSession(socket,hello={}){return new Promise((resolve,reject)=>{const fail=text=>{clearTimeout(timer);reject(Error(text))};let timer=setTimeout(()=>fail('La sala no respondió'),10000);socket.onopen=()=>socket.send(JSON.stringify({label:'rtvi-ai',type:'client-ready',id:crypto.randomUUID(),data:hello}));socket.onerror=()=>fail('No se pudo conectar con la sala');socket.onclose=()=>fail('La sala rechazó la conexión');socket.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='voice-preparation'){if(m.data?.phase==='loading'){clearTimeout(timer);timer=null}showPreparation(m.data||{});return}if(m.type!=='voice-session'){message(e.data);return}clearTimeout(timer);showPreparation({phase:'hidden'});resolve(m.data)}})}
// Capturing at the room's rate lets the browser resample; the worklet covers browsers that refuse the rate.
function roomAudioContext(rate){try{return new AudioContext({sampleRate:rate})}catch{return new AudioContext()}}
async function startCapture(socket,session){if(!micSource)throw Error('No se pudo capturar el micrófono');
 // A context created outside the click gesture can start suspended, and a suspended context never
 // runs the worklet: no audio would leave the page and nothing would say why.
 if(audioContext.state!=='running'){try{await audioContext.resume()}catch{}}
 if(audioContext.state!=='running')throw Error('El navegador no autorizó la captura de audio. Vuelve a pulsar para unirte.');
 const context=audioContext,source=micSource,epoch=connectEpoch;
 await context.audioWorklet.addModule('/voice/mic_capture.js');
 if(ws!==socket||audioContext!==context||epoch!==connectEpoch)return;
 const node=new AudioWorkletNode(context,'mic-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit',processorOptions:{sampleRate:session.sample_rate}});captureNode=node;node.port.onmessage=e=>{if(captureNode===node&&ws===socket&&socket.readyState===WebSocket.OPEN&&micTrack()?.enabled)socket.send(e.data)};source.connect(node);node.connect(context.destination)/* reachable from the destination so it keeps running; its output stays silent */}
function disconnect(){
 latencyTurns.clear();latencyActiveTurn=null;
 ++connectEpoch;connecting=false;
 releaseScreenWakeLock();audioSession(false);++deviceEpoch;
 window.roomVoice?.cancel();window.roomTranscription?.stop();if($('voice-loading').open)$('voice-loading').close();
 cancelBrowserSpeech();stopPreview();
 const socket=ws;ws=null;socket?.close();showEngineBadge('');
 stream?.getTracks().forEach(t=>t.stop());stream=null;
 stopMeter();sessionId=null;userLive=botLive=holding=spaceDown=false;userTurn=null;pendingPhase='';pendingBotText=[];partial('');
 $('connect').disabled=false;$('connect').classList.remove('joined');
 $('connect').title='Entrar en la sala';$('connect').setAttribute('aria-label','Entrar en la sala');
 $('mute').classList.remove('holding');updateMic();
}
$('connect').onclick=async()=>{if(ws||connecting){disconnect();return}connecting=true;const epoch=++connectEpoch;keepScreenAwake();$('connect').classList.add('joined');$('connect').title='Salir de la sala';$('connect').setAttribute('aria-label','Salir de la sala');setRoomError('');try{await window.roomVoice.unlock();if(epoch!==connectEpoch)return;voicePreferences=await loadPreferences();if(epoch!==connectEpoch)return;const browserStt=voicePreferences.stt_provider!=='openai';let sttRuntime=null;if(browserStt){let {stt_model:model,stt_device:device}=voicePreferences;const caps=await window.roomTranscription.capabilities();if(!caps.models.includes(model)){const fallback=caps.models[0];if(!fallback)throw Error('Este navegador no puede transcribir en local; elige OpenAI en Configuración.');$('live').textContent='Este navegador no puede con el modelo guardado; se usa '+fallback.split('/').pop();model=fallback;device='auto'}sttRuntime=await prepareLocalWhisper(model,device)}if(epoch!==connectEpoch)return;callExecution='browser';if(callExecution==='browser'&&(voicePreferences.default_model||'kokoro')==='kokoro'){await window.roomVoice.prepare({device:voicePreferences.tts_device},text=>$('live').textContent=text)}if(epoch!==connectEpoch)return;audioSession(true);const acquiredStream=await acquireMicrophone();if(epoch!==connectEpoch){acquiredStream.getTracks().forEach(t=>t.stop());return}stream=acquiredStream;stream.getAudioTracks().forEach(t=>t.enabled=micEnabled);const socket=new WebSocket(roomSocketUrl());ws=socket;keepScreenAwake();refreshAudioDevices();socket.binaryType='arraybuffer';showEngineBadge(engineBadgeText(voicePreferences,sttRuntime));const session=await openSession(socket,{settings:voicePreferences,transcription:sttRuntime});if(epoch!==connectEpoch)return;socket.onerror=null;socket.onclose=()=>{if(ws===socket)disconnect()};socket.onmessage=e=>{if(ws===socket)message(e.data)};if(socket.readyState!==WebSocket.OPEN)throw Error('La sala cerró la conexión');sessionId=session.session_id;roomRevision=0;if(browserStt)window.roomTranscription.start({socket,language:voicePreferences.stt_language});startMeter(session.sample_rate);await startCapture(socket,session);if(epoch!==connectEpoch)return;await window.roomVoice.unlock();if(epoch!==connectEpoch)return;$('connect').setAttribute('aria-label','Salir de la sala');$('connect').title='Salir de la sala';$('connect').classList.add('joined');$('mute').disabled=false;updateMic();live();await refresh();await refreshPeople()}catch(e){if(epoch===connectEpoch){disconnect();setRoomError(e.message)}}finally{if(epoch===connectEpoch){connecting=false;$('connect').disabled=false}}};
function speedLimits(model){return providerFor(model)==='elevenlabs'?[.7,1.2]:[.5,2]}
function effectiveSpeed(model,value){const [min,max]=speedLimits(model);return Math.max(min,Math.min(max,Number(value)||1))}
function updateSpeedRange(){
 const model=$('default-model').value,[min,max]=speedLimits(model),input=$('tts-speed');
 const previous=Number(input.value)||1;
 input.min=String(min);input.max=String(max);input.value=String(effectiveSpeed(model,previous));
 $('speed-value').textContent=Number(input.value).toFixed(2)+'×';
 $('speed-note').textContent=providerFor(model)==='elevenlabs'
  ?'ElevenLabs genera la voz a esta velocidad (0,7–1,2×). Los valores heredados se ajustan al rango del motor.'
  :'Velocidad de Kokoro: 0,5–2×. ElevenLabs admite 0,7–1,2× en las voces por idioma.';
}
function modelInfo(id){return voiceCatalog?.models?.find(model=>model.id===id)||{id,label:id,provider:id==='kokoro'?'kokoro':'elevenlabs'}}
function setInfoContent(button,description){
 if(!button)return;
 button.hidden=!description;button.dataset.tooltip=description||"";button.setAttribute("aria-expanded","false");
 if(description){button.title=description;if(!window.sidevoiceUI)button.onclick=event=>{event.stopPropagation();button.setAttribute("aria-expanded",String(button.getAttribute("aria-expanded")!=="true"))}}
}
function setModelInfo(button,id){setInfoContent(button,modelInfo(id).description)}
function modelInfoButton(id){
 const button=document.createElement('button');button.type='button';button.className='model-info';button.textContent='ⓘ';
 button.setAttribute('aria-label','Descripción del modelo');setModelInfo(button,id);return button;
}
document.addEventListener('click',()=>document.querySelectorAll('.model-info[aria-expanded=true]').forEach(button=>button.setAttribute('aria-expanded','false')));

function providerFor(model){return modelInfo(model||'kokoro').provider||'kokoro'}
function entriesFor(select,entries,value){select.replaceChildren();const values=new Set(entries.map(entry=>entry[0]));if(value&& !values.has(value))entries=[[value,value],...entries];for(const [id,label,disabled] of entries){const option=document.createElement('option');option.value=id;option.textContent=label;if(disabled)option.disabled=true;select.append(option)}const usable=entries.filter(entry=>!entry[2]);select.value=usable.some(entry=>entry[0]===value)?value:(usable[0]?.[0]??'')}
function elevenVoiceItems(){return voiceCatalog?.providers?.elevenlabs?.voices||[]}
function conciseVoiceLabel(label){return String(label||"").split(" · ")[0].trim()}
function voicesFor(model,language,showAll=false){
 if(providerFor(model)!=="elevenlabs")return (voiceCatalog.languages.find(item=>item.id===language)?.voices||[]).map(([id,label])=>[id,conciseVoiceLabel(label)]);
 const voices=elevenVoiceItems(),visible=showAll?voices:voices.filter(item=>item.languages?.includes(language));
 return visible.map(item=>[item.id,conciseVoiceLabel(item.label)]);
}
function voiceEntriesFor(model,language,showAll=false){
 const voices=voicesFor(model,language,showAll);
 if(providerFor(model)==='elevenlabs'&&!showAll&&voices.length<elevenVoiceItems().length)return [...voices,[SHOW_ALL_VOICES,'Mostrar todas las voces…']];
 return voices;
}
function validVoice(entries,value){return entries.some(([id])=>id!==SHOW_ALL_VOICES&&id===value)?value:entries.find(([id])=>id!==SHOW_ALL_VOICES)?.[0]}
function renderDefaultVoices(value){
 const model=$('default-model').value,language=$('default-tts-language').value||'es',voices=voiceEntriesFor(model,language,defaultVoicesExpanded);
 setModelInfo($('default-model-info'),model);entriesFor($('default-voice'),voices,validVoice(voices,value));
 const cloud=providerFor(model)==='elevenlabs';updateSpeedRange();$('elevenlabs-credential').hidden=!cloud;$('tts-device').closest('label').hidden=cloud;$('prepare-model').hidden=cloud;
 $('model-status').textContent=cloud?(elevenCredentials.configured?'Voces filtradas por '+language.toUpperCase()+'. Usa «Mostrar todas las voces…» para quitar el filtro.':'Guarda una clave de ElevenLabs para cargar las voces de la cuenta.'):'Kokoro se prepara automáticamente al conectar o probar una voz.';
}
function stopPreview(){const job=previewJob;previewJob=null;if(!job)return;job.controller.abort();if(job.browser)window.roomVoice?.cancel();$('preview-audio').pause();$('preview-audio').removeAttribute('src');if(job.url)URL.revokeObjectURL(job.url);if(job.track&&stream?.getAudioTracks()[0]===job.track){job.track.enabled=job.enabled;updateMic()}for(const item of voiceCatalog?.languages||[])$('preview-'+item.id).textContent='▶'}
async function previewVoice(language){if(!$('language-form').reportValidity())return;if(previewJob){stopPreview();$('preview-status').textContent='Prueba detenida';return}if(botLive){$('preview-status').textContent='Espera a que termine la locución antes de probar una voz.';return}const track=stream?.getAudioTracks()[0],choice=selectedVoice(language),job={controller:new AbortController(),track,enabled:track?.enabled};previewJob=job;if(track){track.enabled=false;updateMic()}$('preview-'+language).textContent='■';$('preview-status').textContent='Preparando muestra…';try{job.browser=true;await window.roomVoice.unlock();if(previewJob!==job)return;const sample=voiceCatalog.languages.find(item=>item.id===language).sample;if(choice.provider==='elevenlabs'){const audio=await post('/api/presentation/synthesis/preview',{...choice,text:sample});if(previewJob!==job)return;await window.roomVoice.playEncoded(audio,text=>$('preview-status').textContent=text)}else{job.browser=true;await window.roomVoice.unlock();await window.roomVoice.speak({...choice,text:sample},text=>$('preview-status').textContent=text)}if(previewJob===job){stopPreview();$('preview-status').textContent='Prueba terminada'}}catch(e){if(previewJob!==job)return;stopPreview();$('preview-status').textContent=e.name==='AbortError'?'Prueba detenida':e.message}}
function selectedVoice(language){const selected=$('model-'+language).value,model=(selected==='inherit'?$('default-model').value:selected)||'kokoro',provider=providerFor(model),item=voiceCatalog.languages.find(item=>item.id===language);let voice=$('voice-'+language).value;if(voice==='inherit')voice=$('default-voice').value;if(provider==='kokoro'&&!item.voices.some(value=>value[0]===voice))voice=item.voices[0][0];return {model,provider,voice,speed:effectiveSpeed(model,$('speed-'+language).value||$('tts-speed').value),device:$('tts-device').value}}
function storeLanguage(){for(const item of voiceCatalog.languages)voiceDraft[item.id]={model:$('model-'+item.id).value,voice:$('voice-'+item.id).value,speed:$('speed-'+item.id).value===''?null:Number($('speed-'+item.id).value)}}
function renderLanguageRows(){
 const rows=$('language-rows');
 if(window.sidevoiceUI){
  const defaultModel=$('default-model').value,defaultVoice=$('default-voice').selectedOptions[0]?.textContent||$('default-voice').value,globalSpeed=$('tts-speed').value;
  window.sidevoiceUI.setLanguageModels(voiceCatalog.languages.map(item=>{
   const draft=voiceDraft[item.id]||{model:'inherit',voice:'inherit',speed:null},actualModel=(draft.model==='inherit'?defaultModel:draft.model)||'kokoro',[speedMin,speedMax]=speedLimits(actualModel);
   const choices=voiceEntriesFor(actualModel,item.id,expandedVoiceLanguages.has(item.id)),voice=draft.voice==='inherit'||choices.some(([id])=>id===draft.voice)?(draft.voice||'inherit'):'inherit';
   return {language:item.id,label:item.label,model:draft.model||'inherit',actualModel,modelDescription:modelInfo(actualModel).description,
    modelOptions:[['inherit','Usar por defecto'],...voiceCatalog.models.map(entry=>[entry.id,entry.label])].map(([value,label])=>({value,label})),
    voice,voiceOptions:[["inherit","Usar voz predeterminada"],...choices].map(([value,label])=>({value,label})),
    speed:draft.speed==null?null:effectiveSpeed(actualModel,draft.speed),speedMin,speedMax,inheritedSpeed:effectiveSpeed(actualModel,globalSpeed)};
  }));return;
 }
 rows.replaceChildren();const header=document.createElement('div');header.className='language-row language-row-head';
 for(const label of ['Idioma','Modelo','Voz','Velocidad','']){const cell=document.createElement('span');cell.textContent=label;header.append(cell)}rows.append(header);
 for(const item of voiceCatalog.languages){
  const row=document.createElement('div'),draft=voiceDraft[item.id]||{model:'inherit',voice:'inherit'};row.className='language-row';
  const name=document.createElement('strong');name.textContent=item.label;row.append(name);
  const model=document.createElement('select');model.id='model-'+item.id;model.setAttribute('aria-label','Modelo · '+item.label);entriesFor(model,[['inherit','Usar por defecto'],...voiceCatalog.models.map(entry=>[entry.id,entry.label])],draft.model);
  model.onchange=()=>{expandedVoiceLanguages.delete(item.id);voiceDraft[item.id]={...voiceDraft[item.id],model:model.value,voice:'inherit'};renderLanguageRows()};
  const actual=model.value==='inherit'?$('default-model').value:model.value,modelCell=document.createElement('span');modelCell.className='model-picker';modelCell.append(model,modelInfoButton(actual));row.append(modelCell);
  const voice=document.createElement('select'),choices=voiceEntriesFor(actual,item.id,expandedVoiceLanguages.has(item.id));voice.id='voice-'+item.id;voice.setAttribute('aria-label','Voz · '+item.label);
  const selected=draft.voice==='inherit'||choices.some(([id])=>id===draft.voice)?draft.voice:'inherit';entriesFor(voice,[['inherit','Usar voz predeterminada'],...choices],selected);
  voice.onchange=()=>{if(voice.value===SHOW_ALL_VOICES){expandedVoiceLanguages.add(item.id);renderLanguageRows();return}voiceDraft[item.id]={...voiceDraft[item.id],voice:voice.value}};
  row.append(voice);
  const speed=document.createElement('input'),[speedMin,speedMax]=speedLimits(actual);speed.type='number';speed.min=String(speedMin);speed.max=String(speedMax);speed.step='0.05';speed.id='speed-'+item.id;speed.value=draft.speed==null?'':effectiveSpeed(actual,draft.speed);speed.placeholder=effectiveSpeed(actual,$('tts-speed').value).toFixed(2)+'×';speed.title='Vacío: velocidad global, ajustada al rango del motor ('+speedMin+'–'+speedMax+'×).';speed.onchange=()=>{voiceDraft[item.id]={...voiceDraft[item.id],speed:speed.value===''?null:Number(speed.value)}};speed.setAttribute('aria-label','Velocidad · '+item.label);row.append(speed);
  const button=document.createElement('button');button.type='button';button.id='preview-'+item.id;button.textContent='▶';button.setAttribute('aria-label','Probar voz · '+item.label);button.title='Probar voz · '+item.label;button.onclick=()=>previewVoice(item.id);row.append(button);rows.append(row);
 }
}
function populateVoiceSettings(p){
 defaultVoicesExpanded=false;expandedVoiceLanguages.clear();voiceDraft=JSON.parse(JSON.stringify(p.language_overrides||{}));
 for(const [lang,prefix] of [['es','spanish'],['en','english']]){const voice=p[prefix+'_voice'],standard=lang==='es'?'ef_dora':'af_heart';voiceDraft[lang]??={model:p[prefix+'_model']||'inherit',voice:voice===standard?'inherit':voice||'inherit'}}
 entriesFor($('default-model'),voiceCatalog.models.map(item=>[item.id,item.label]),p.default_model);
 for(const id of ['default-tts-language','stt-language']){const select=$(id),preference=p[id.replaceAll('-','_')];select.replaceChildren();const entries=id==='stt-language'?[{id:'auto',label:'Detectar automáticamente'},...voiceCatalog.languages]:voiceCatalog.languages;for(const item of entries){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;select.append(option)}select.value=preference||select.value}
 renderDefaultVoices(p.default_voice);renderLanguageRows();$('language-support').textContent='Las voces de ElevenLabs se filtran por su idioma principal. «Mostrar todas las voces…» quita el filtro para ese selector.';
}
$('reset-languages').onclick=()=>{stopPreview();voiceDraft={};renderLanguageRows();$('preview-status').textContent='Todos los idiomas usan los valores por defecto. Pulsa Guardar cambios para aplicarlo.'};
$('prepare-model').onclick=async()=>{if(activeSpeech||previewJob){$('model-status').textContent='Espera a que termine la voz.';return}const button=$('prepare-model');button.disabled=true;try{await window.roomVoice.unlock();await window.roomVoice.prepare({device:$('tts-device').value},text=>$('model-status').textContent=text)}catch(e){$('model-status').textContent=e.message}finally{button.disabled=false}};
function cancelBrowserSpeech(){if(!activeSpeech)return;const speech=activeSpeech;clearKaraoke(speech);activeSpeech=null;window.roomVoice?.cancel();post('/api/presentation/browser-receipt',{session_id:speech.session_id,revision:speech.revision,utterance_id:speech.utterance_id,status:speech.started?'cancelled_playing':'cancelled_unplayed'}).catch(()=>{});const row=history.find(r=>r.segment===speechSegment(speech));if(row){row.interrupted=!!speech.started;save();renderHistory()}botLive=false;live()}
async function receiveBrowserSpeech(d,cloud=false){const receivedAt=latencyNow();if(d.session_id!==sessionId)return;if(d.thread_id!==targetId())await refresh();if(d.session_id!==sessionId||d.thread_id!==targetId()||d.revision<roomRevision)return;roomRevision=d.revision;stopPreview();cancelBrowserSpeech();activeSpeech=d;add('assistant',d.text,'voice:'+d.utterance_id,d.thread_id,{history_id:d.history_id,session:d.session_id,revision:d.revision});const receipt=status=>post('/api/presentation/browser-receipt',{session_id:d.session_id,revision:d.revision,utterance_id:d.utterance_id,status,...(status==='playing'?{timings_ms:browserLatency(d,receivedAt)}:{})});try{await window.roomVoice[cloud?'playEncoded':'speak'](d,text=>$('live').textContent=text,()=>{d.started=true;botLive=true;renderHistory();live();receipt('playing').catch(()=>{})},range=>updateKaraoke(d,range));if(activeSpeech!==d)return;clearKaraoke(d);activeSpeech=null;renderHistory();botLive=false;live();await receipt('playback_finished')}catch(e){if(activeSpeech!==d)return;clearKaraoke(d);activeSpeech=null;renderHistory();botLive=false;live();if(e.name!=='AbortError'){setRoomError((cloud?'Audio de ElevenLabs: ':'Voz del navegador: ')+e.message);receipt('failed').catch(()=>{})}}}
function receiveServerSpeech(d){return receiveBrowserSpeech(d,true)}

$('settings-open').onclick=async()=>{try{
 const p=await loadPreferences();window.roomI18n?.setLanguage(p.ui_language||'es');voicePreferences=p;
 for(const key of ['stt_language','default_tts_language','tts_speed','ui_language','tts_device','audio_grace_seconds'])$(key.replaceAll('_','-')).value=p[key];
 for(const key of MIC_KEYS)$(key.replaceAll('_','-')).value=p[key];
 $('speed-value').textContent=Number(p.tts_speed).toFixed(2)+'×';$('settings-error').textContent='Cargando catálogos…';
 if(!$('language-settings').open)$('language-settings').showModal();
 const [catalog]=await Promise.all([api('/api/presentation/voice-catalog'),loadTranscription()]);
 voiceCatalog=catalog;const eleven=voiceCatalog.providers?.elevenlabs||{};elevenCredentials={configured:!!eleven.configured};
 populateVoiceSettings(p);renderDefaultVoices(p.default_voice);renderLanguageRows();
 $('elevenlabs-key-state').textContent=eleven.configured?'Clave guardada':'Sin clave: no se pueden cargar ni usar voces de ElevenLabs.';
 $('elevenlabs-key-clear').disabled=!eleven.configured;
 $('settings-error').textContent=eleven.error||'';
}catch(e){$('settings-error').textContent=e.message;setRoomError(e.message)}};
$('tts-speed').oninput=()=>{$('speed-value').textContent=Number($('tts-speed').value).toFixed(2)+'×';if(voiceCatalog){storeLanguage();renderLanguageRows()}};
$('default-model').onchange=()=>{storeLanguage();defaultVoicesExpanded=false;expandedVoiceLanguages.clear();renderDefaultVoices();renderLanguageRows()};
$('default-voice').onchange=()=>{if($('default-voice').value===SHOW_ALL_VOICES){defaultVoicesExpanded=true;renderDefaultVoices();renderLanguageRows();return}storeLanguage();renderLanguageRows()};
$('default-tts-language').onchange=()=>{defaultVoicesExpanded=false;renderDefaultVoices();renderLanguageRows()};
function settingsSection(name){for(const section of ['general','voice','transcription','advanced']){$('pane-'+section).hidden=section!==name;$('settings-'+section).setAttribute('aria-pressed',String(section===name))}}
$('settings-advanced').onclick=()=>settingsSection('advanced');
$('settings-general').onclick=()=>settingsSection('general');
$('ui-language').onchange=()=>window.roomI18n?.setLanguage($('ui-language').value);
$('settings-voice').onclick=()=>settingsSection('voice');
$('settings-transcription').onclick=()=>settingsSection('transcription');
let sttCatalog=null,sttCapabilities=null;
const sttRemote={openai:{loaded:false,loading:false,error:null}};
function sttProvider(id){return (sttCatalog?.providers||[]).find(provider=>provider.id===id)}
function renderTranscription(){
 if(!sttCatalog||!sttCapabilities)return;
 const provider=$('stt-provider').value||voicePreferences?.stt_provider||'browser',entry=sttProvider(provider),modelSelect=$('stt-model');
 $('stt-browser-options').hidden=provider!=='browser';$('stt-credential').hidden=provider!=='openai';
 $('stt-provider-note').textContent=entry?.note||'';
 const current=modelSelect.value,saved=voicePreferences?.stt_provider===provider?voicePreferences?.stt_model:null;
 if(provider==='browser'){
  // Processing comes first: what this browser can run decides which models are offered.
  // The browser may offer WebGPU and still fail to load Whisper on it (iPhone); that failure is remembered per device.
  const gpuFailed=!!storedPreferences().stt_gpu_failed;
  const device=$('stt-device'),savedDevice=device.value||voicePreferences?.stt_device||'auto',entries=[['auto','Automático']];
  if(sttCapabilities.webgpu)entries.push(['webgpu',gpuFailed?'GPU · WebGPU (falló al cargar Whisper aquí)':'GPU · WebGPU']);
  if(sttCapabilities.wasm)entries.push(['wasm','CPU · WebAssembly']);
  entriesFor(device,entries,entries.some(([id])=>id===savedDevice)?savedDevice:'auto');
  const effective=device.value==='auto'?(sttCapabilities.webgpu&&!gpuFailed?'webgpu':'wasm'):device.value;
  $('stt-device-note').textContent=device.value==='auto'?(!sttCapabilities.webgpu?'Automático usará la CPU: WebGPU no está disponible en este navegador.':gpuFailed?'Automático usará la CPU: este navegador ofrece WebGPU pero no pudo cargar Whisper con ella.':'Automático usará la GPU: WebGPU está disponible en este navegador.'):(effective==='webgpu'?'Aceleración WebGPU. Si falla al cargar, se pasará a CPU.':'Procesamiento en CPU mediante WebAssembly.');
  const all=entry?.models||[];
  const runnable=model=>!!model.devices?.includes(effective)&&!!sttCapabilities.models?.includes(model.id);
  const reason=model=>!model.devices?.includes(effective)?(effective==='wasm'?'requiere GPU':'solo CPU'):'no disponible en este navegador';
  const enabled=all.filter(runnable),ids=enabled.map(model=>model.id);
  const preferred=ids.includes(current)?current:ids.includes(saved)?saved:ids.includes(entry?.default_model)?entry.default_model:ids[0];
  entriesFor(modelSelect,all.map(model=>[model.id,runnable(model)?model.label:model.label+' · '+reason(model),!runnable(model)]),preferred);
  modelSelect.disabled=!enabled.length;
  const selected=all.find(model=>model.id===modelSelect.value);
  setInfoContent($("stt-model-info"),selected?.description||"");
  $("stt-model-note").textContent=enabled.length?"":"Ningún modelo local puede correr con este procesamiento en este navegador.";
 }else{
  const models=entry?.models||[],state=sttCredentials.openai,remote=sttRemote.openai;
  $('stt-key-state').textContent=state?.configured?'Clave guardada '+(state.hint||'')+(state.source==='environment'?' · viene del entorno de la sala':''):'Sin clave: OpenAI no podrá transcribir hasta que guardes una.';
  $('stt-key-clear').disabled=!state?.configured||state.source==='environment';
  modelSelect.disabled=remote.loading;
  const preferred=models.some(model=>model.id===current)?current:models.some(model=>model.id===saved)?saved:(saved||entry?.default_model||models[0]?.id);
  entriesFor(modelSelect,remote.loading?[['','Cargando modelos de OpenAI…']]:models.map(model=>[model.id,model.label]),remote.loading?'':preferred);
  const selected=models.find(model=>model.id===modelSelect.value);
  const description=remote.loading?"Consultando los modelos disponibles en tu cuenta…":remote.error||selected?.description||(models.length?models.length+" modelos compatibles cargados directamente desde OpenAI.":"OpenAI no devolvió modelos compatibles para esta cuenta.");setInfoContent($("stt-model-info"),description);$("stt-model-note").textContent=remote.loading||remote.error?description:"";
 }
}

async function loadTranscriptionModels(provider,refresh=false){
 if(provider!=='openai'||!sttCatalog)return;
 const remote=sttRemote.openai;if(remote.loading||remote.loaded&&!refresh)return;
 remote.loading=true;remote.error=null;renderTranscription();
 try{
  const data=await api('/api/presentation/transcription/models?provider='+encodeURIComponent(provider));
  const entry=sttProvider(provider);if(entry)entry.models=Array.isArray(data.models)?data.models:[];
  remote.loaded=true;remote.error=data.error||null;
 }catch(error){remote.error=error.message||'No se pudo cargar el catálogo.'}
 finally{remote.loading=false;if($('stt-provider').value===provider)renderTranscription()}
}
async function loadTranscription(){
 const data=await api('/api/presentation/transcription');sttCatalog=data.catalog;sttCredentials=data.credentials||{};
 sttCapabilities=await window.roomTranscription.capabilities();
 entriesFor($('stt-provider'),(sttCatalog.providers||[]).filter(provider=>provider.id!=='browser'||sttCapabilities.webgpu||sttCapabilities.wasm).map(provider=>[provider.id,provider.label]),voicePreferences?.stt_provider||'browser');
 $('stt-device').disabled=false;renderTranscription();
 if($('stt-provider').value==='openai')void loadTranscriptionModels('openai');
}
$('stt-provider').onchange=()=>{$('stt-model').replaceChildren();renderTranscription();if($('stt-provider').value==='openai')void loadTranscriptionModels('openai',true)};
$('stt-device').onchange=renderTranscription;$('stt-model').onchange=renderTranscription;
$('stt-key-save').onclick=async()=>{const key=$('stt-key').value.trim();if(!key)return;$('stt-key-save').disabled=true;$('settings-error').textContent='';$('stt-key-state').textContent='Comprobando la clave con OpenAI…';try{const result=await post('/api/presentation/transcription/credential',{provider:'openai',key});sttCredentials=result.credentials||{};$('stt-key').value='';sttRemote.openai.loaded=false;await loadTranscriptionModels('openai',true)}catch(e){$('settings-error').textContent=e.message}finally{$('stt-key-save').disabled=false;renderTranscription()}};
$('stt-key-clear').onclick=async()=>{$('stt-key-clear').disabled=true;$('settings-error').textContent='';try{const result=await post('/api/presentation/transcription/credential',{provider:'openai',key:null});sttCredentials=result.credentials||{};const entry=sttProvider('openai');if(entry)entry.models=[];Object.assign(sttRemote.openai,{loaded:false,loading:false,error:null})}catch(e){$('settings-error').textContent=e.message}finally{renderTranscription()}};
async function loadElevenLabs(){const data=await api('/api/presentation/synthesis');elevenCredentials=data.credentials||{};const state=elevenCredentials;$('elevenlabs-key-state').textContent=state.configured?'Clave guardada '+(state.hint||'')+(state.source==='environment'?' · viene del entorno de la sala':''):'Sin clave: no se pueden cargar ni usar voces de ElevenLabs.';$('elevenlabs-key-clear').disabled=!state.configured||state.source==='environment'}
$('elevenlabs-key-save').onclick=async()=>{const key=$('elevenlabs-key').value.trim();if(!key)return;$('elevenlabs-key-save').disabled=true;$('settings-error').textContent='';$('elevenlabs-key-state').textContent='Comprobando la clave con ElevenLabs…';try{const result=await post('/api/presentation/synthesis/credential',{key});$('elevenlabs-key').value='';voiceCatalog=await api('/api/presentation/voice-catalog');elevenCredentials=result.credentials||{};renderDefaultVoices($('default-voice').value);renderLanguageRows()}catch(e){$('settings-error').textContent=e.message}finally{$('elevenlabs-key-save').disabled=false;await loadElevenLabs()}};
$('elevenlabs-key-clear').onclick=async()=>{try{await post('/api/presentation/synthesis/credential',{key:null});voiceCatalog=await api('/api/presentation/voice-catalog');elevenCredentials={};renderDefaultVoices();renderLanguageRows()}catch(e){$('settings-error').textContent=e.message}finally{await loadElevenLabs()}};
$('reset-settings').onclick=async()=>{try{localStorage.removeItem(SETTINGS_KEY);localStorage.removeItem('sidevoice.mic')}catch{}voiceDraft={};await $('settings-open').onclick();$('reset-settings-note').textContent='Restablecido a los valores por defecto. Guarda para conservarlo; los cambios de transcripción y micrófono se aplican al volver a entrar.'};
$('settings-close').onclick=()=>{stopPreview();$('language-settings').close()};$('language-settings').addEventListener('close',stopPreview);
const MIC_KEYS=['turn_end_mode','user_speech_timeout','smart_turn_min_silence','smart_turn_max_silence','vad_confidence','vad_min_volume'];
// Every setting belongs to this device. The room answers with its defaults and keeps no copy; what this browser saved wins.
const SETTINGS_KEY='sidevoice.settings';
function storedPreferences(){for(const key of [SETTINGS_KEY,'sidevoice.mic']){try{const stored=JSON.parse(localStorage.getItem(key)||'null');if(stored&&typeof stored==='object')return stored}catch{}}return {}}
function storePreferences(p){try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(p));localStorage.removeItem('sidevoice.mic')}catch{}}
async function loadPreferences(){const defaults=await api('/api/presentation/languages');return {...defaults,...storedPreferences()}}
// WebKit on the iPhone offers WebGPU and then fails while loading Whisper on it. A failed GPU load falls back to
// CPU for this call and is remembered for this device, so 'automatic' starts on CPU next time; choosing GPU explicitly still tries it.
// What this call is actually using, said small next to the controls: engine, model and processor, plus how the turn ends.
function engineBadgeText(p,runtime){
 if(!p)return '';
 const turn=p.turn_end_mode==='timer'?'silencio '+String(p.user_speech_timeout??2.5).replace('.',',')+' s':'smart-turn';
 if(p.stt_provider==='openai')return 'OpenAI · '+(p.stt_model||'')+' · '+turn;
 const model=String(runtime?.model||p.stt_model||'').split('/').pop().replace('whisper-','Whisper '),where=runtime?.device==='webgpu'?'GPU':runtime?.device==='wasm'?'CPU':'';
 return [model,where+(runtime?.fallback_from?' (GPU falló)':''),turn].filter(Boolean).join(' · ');
}
function showEngineBadge(text){const badge=$('engine-badge');if(!badge)return;badge.textContent=text||'';badge.title=text||'';badge.hidden=!text}
async function prepareLocalWhisper(model,device){
 const caps=sttCapabilities||(window.roomTranscription.capabilities?await window.roomTranscription.capabilities():{wasm:true});
 if(device==='auto'&&storedPreferences().stt_gpu_failed)device='wasm';
 try{return await window.roomTranscription.prepare({model,device})}
 catch(error){
  if(device==='wasm'||!caps.wasm)throw error;
  $('live').textContent='La GPU no pudo cargar '+model.split('/').pop()+'; este dispositivo usa la CPU';
  storePreferences({...(voicePreferences||{}),stt_device:'wasm',stt_gpu_failed:true});if(voicePreferences)voicePreferences.stt_device='wasm';
  const runtime=await window.roomTranscription.prepare({model,device:'wasm'});
  return {...runtime,fallback_from:device,fallback_error:String(error?.message||error).slice(0,300)};
 }
}
function micSettingsChanged(previous,next){return MIC_KEYS.some(key=>String(previous?.[key]??'')!==String(next?.[key]??''))}
function sttSettingsChanged(previous,next){return ['stt_provider','stt_model','stt_device','stt_language','stt_context'].some(key=>String(previous?.[key]??'')!==String(next?.[key]??''))}
async function applyTranscriptionSettings(previous,next){
 if(!ws||!sttSettingsChanged(previous,next))return false;
 if(previous?.stt_provider!==next.stt_provider||next.stt_provider==='openai'){disconnect();return 'reconnect'}
 const socket=ws,epoch=connectEpoch;switchingTranscription=true;
 window.roomTranscription.stop({cancelTurn:true});
 try{
  const runtime=await prepareLocalWhisper(next.stt_model,next.stt_device);
  if(ws!==socket||connectEpoch!==epoch)return false;
  socket.send(JSON.stringify({type:'voice-stt-ready',data:{session_id:sessionId,...runtime}}));showEngineBadge(engineBadgeText(next,runtime));
  window.roomTranscription.start({socket,language:next.stt_language});
  return true;
 }finally{switchingTranscription=false}
}
$('language-form').onsubmit=async e=>{e.preventDefault();storeLanguage();const previous=voicePreferences,p={...voicePreferences,tts_execution:'browser',language_overrides:voiceDraft};for(const key of ['stt_language','stt_device','default_tts_language','tts_speed','ui_language','tts_device','default_model','default_voice','audio_grace_seconds',...MIC_KEYS])p[key]=['tts_speed','audio_grace_seconds','user_speech_timeout','smart_turn_min_silence','smart_turn_max_silence','vad_confidence','vad_min_volume'].includes(key)?Number($(key.replaceAll('_','-')).value):$(key.replaceAll('_','-')).value;p.stt_provider=$('stt-provider').value||'browser';p.stt_model=$('stt-model').value;let hotSwap=false;try{storePreferences(p);if(ws&&ws.readyState===WebSocket.OPEN&&sessionId)ws.send(JSON.stringify({type:'voice-settings',data:{session_id:sessionId,settings:p}}));hotSwap=!!ws&&sttSettingsChanged(previous,p);voicePreferences=p;window.roomI18n?.setLanguage(p.ui_language);stopPreview();$('language-settings').close();const applied=await applyTranscriptionSettings(previous,p);const micChanged=!!ws&&micSettingsChanged(previous,p);$('live').textContent=applied==='reconnect'||micChanged?'Preferencias guardadas · Vuelve a entrar para aplicar los ajustes de micrófono':applied?'Preferencias guardadas · Transcripción actualizada':'Preferencias guardadas'}catch(e){if(hotSwap)disconnect();if(hotSwap)setRoomError(e.message);else $("settings-error").textContent=e.message}};
window.sidevoiceActions={
 cancelInput:cancelCurrentInput,
 selectParticipant(threadId){
  const participant=people.find(item=>item.thread_id===threadId);
  viewedThread=threadId;renderHistory();
  $('transcript-title').textContent=participant?.title||history.find(item=>item.thread===threadId)?.name||'Conversación';
  rosterSignature='';renderPeople();
  if(participant?.available)void select(threadId);
  updateComposer();
 },
 async closeParticipant(threadId){
  try{await post('/api/presentation/close',{thread_id:threadId});rosterSignature='';await refresh();await refreshPeople();await refreshHistory()}
  catch(e){setRoomError(e.message);throw e}
 },
 updateLanguageModel(language,model){
  expandedVoiceLanguages.delete(language);voiceDraft[language]={...voiceDraft[language],model,voice:'inherit'};renderLanguageRows();
 },
 updateLanguageVoice(language,voice){
  if(voice===SHOW_ALL_VOICES){expandedVoiceLanguages.add(language);renderLanguageRows();return}
  voiceDraft[language]={...voiceDraft[language],voice};renderLanguageRows();
 },
 updateLanguageSpeed(language,speed){
  voiceDraft[language]={...voiceDraft[language],speed};renderLanguageRows();
 },
 previewVoice,
};
$('mute').onclick=()=>{holding=false;setMic(!(stream?.getAudioTracks()[0]?.enabled??micEnabled))};
function typing(e){return e.target instanceof Element&&!!e.target.closest('input,textarea,select,[contenteditable=true],[role=menu],[role=menuitem],[data-radix-popper-content-wrapper]')}
window.addEventListener('keydown',e=>{
 if(typing(e)||e.altKey)return;
 if(e.code==='KeyD'&&(e.metaKey||e.ctrlKey)&&!e.shiftKey){e.preventDefault();if(!e.repeat)$('mute').click();return}
 if(stream&&e.code==='Space'&&!e.ctrlKey&&!e.metaKey&&!e.target.closest('summary')){
  e.preventDefault();
  if(spaceDown)return;
  spaceDown=true;
  if(!stream.getAudioTracks()[0].enabled){holding=true;setMic(true);$('mute').classList.add('holding')}
 }
},true);
window.addEventListener('keyup',e=>{if(e.code==='Space'&&spaceDown){e.preventDefault();releaseHold()}},true);
window.addEventListener('blur',releaseHold);document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseHold()});window.addEventListener('beforeunload',()=>{ws?.close();stream?.getTracks().forEach(t=>t.stop())});loadPreferences().then(p=>window.roomI18n?.setLanguage(p.ui_language||'es')).catch(()=>{});updateMic();refresh();refreshPeople();refreshHistory();setInterval(refreshHistory,1500);setInterval(refresh,1500);setInterval(refreshPeople,6000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&ws)keepScreenAwake()});
setupAudioControls();
