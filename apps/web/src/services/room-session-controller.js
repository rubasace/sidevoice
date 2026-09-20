import {createRoomSessionStore,working,joinView,conversationView,participantsView,echoCoverage as deriveEchoCoverage,offlineNote,audioNote,engineBadgeText,speechSegment,recordReceipt,recordReply,PRESENCE_LEVEL,GAP_BUFFER_SECONDS,BED_AFTER_USER_MS,REPLAY_NOTES} from '../state/room-session-state.js';
const roomStore=window.sidevoiceUI?.store||createRoomSessionStore();
const state=roomStore.facts;
// Browser room orchestration. Loaded once after React mounts the stable UI shell.
const $=id=>document.getElementById(id);
function setRoomError(message){const value=message||null;if(window.sidevoiceUI)window.sidevoiceUI.setBootError(value);else $("error").textContent=value||""}
function showPreparation(d){
 const box=$('voice-loading');
 if(d.phase==='inline'){state.liveNote=d.text;return}
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
window.addEventListener('voice-preparation',({detail:d})=>{showPreparation(d);noteJoinPreparation(d)});
/* One quiet line from the tap until this browser is in the room, naming the step the join is on.
 * It reuses the events that already existed — the engine's preparation, the room's hello, the
 * conversation this tab goes back to — and measures nothing of its own. A step that fails leaves
 * its reason, and what to do about it, in the same place. */


function joinStatus(step,{detail='',progress=null,subject=''}={}){roomStore.patch({joinStep:step,joinFailure:'',joinDetail:detail?String(detail).slice(0,80):'',joinProgress:progress==null?null:Number(progress),joinSubject:subject})}
function clearJoinStatus(){roomStore.patch({joinStep:null,joinFailure:'',joinDetail:'',joinProgress:null,joinSubject:'',liveNote:''})}
function failJoin(text){roomStore.patch({joinStep:null,joinFailure:text||'',joinDetail:'',joinProgress:null,joinSubject:''})}
// The engine's own progress refines the model step the join is already on; anywhere else it belongs to the modal alone.
function noteJoinPreparation(d){
 if(!d||d.phase!=='loading'||!['audio','whisper','voice','transcription','mic'].includes(state.joinStep))return;
 joinStatus(d.kind==='transcription'?'whisper':'voice',{progress:d.progress==null?null:d.progress});
}
// What this tab already calls the conversation it is going back to; the room is not asked again for a title.
function conversationTitle(id){return state.people.find(p=>p.thread_id===id)?.title||state.history.find(r=>r.thread===id)?.name||'tu conversación'}
/* Three failures actually happen here, and each one has something the person can do about it. Anything
 * else says what the browser said, because inventing a remedy for it would be worse than quoting it. */
function joinFailureText(step,error){
 const name=String(error?.name||''),message=String(error?.message||error||'');
 if(step==='microphone'){
  if(/NotAllowedError|SecurityError/.test(name)||/permiso|permission|denied/i.test(message))
   return 'El micrófono está bloqueado para esta página. Dale permiso en el navegador y vuelve a pulsar para entrar.';
  if(/NotFoundError|OverconstrainedError|NotReadableError/.test(name))
   return 'No se pudo usar el micrófono elegido. Conéctalo o elige otro en los dispositivos de audio, y vuelve a entrar.';
  return 'No se pudo abrir el micrófono: '+message+'. Revísalo y vuelve a entrar.';
 }
 if(step==='whisper'||step==='voice')
  return /Configuración/.test(message)?message   // the step already said where to change it
   :'El modelo no se pudo cargar en este dispositivo ('+message+'). Elige uno más pequeño en Configuración, o OpenAI para transcribir.';
 return message+(/[.!?…]$/.test(message)?'':'.');
}
function cancelPreparation(){if(state.activeSpeech){const d=state.activeSpeech;post('/api/presentation/browser-receipt',{session_id:d.session_id,revision:d.revision,utterance_id:d.utterance_id,status:'failed'}).catch(()=>{});cancelBrowserSpeech()}else if(state.previewJob)stopPreview();else if(state.switchingSession)abortSwitch();else if(state.connecting||state.switchingTranscription)disconnect();else window.roomVoice?.cancel();$('voice-loading').close()}
$('loading-cancel').onclick=cancelPreparation;$('voice-loading').addEventListener('cancel',e=>{e.preventDefault();cancelPreparation()});

// The room holds several browsers at once, so every question this page asks the
// room carries its own session: the answer is about this browser and no other.
function roomQuery(path){return state.sessionId?path+(path.includes('?')?'&':'?')+'session_id='+encodeURIComponent(state.sessionId):path}
// Which conversation this tab talks to is this tab's own state: the room routes, it never chooses for anyone.
const SELECTED_KEY='sidevoice.selected';
function rememberedThread(){try{return sessionStorage.getItem(SELECTED_KEY)||null}catch{return null}}
function rememberThread(id){try{if(id)sessionStorage.setItem(SELECTED_KEY,id);else sessionStorage.removeItem(SELECTED_KEY)}catch{}}
/* A reconnection is a new client id in the room, so nothing there would tie the browser that comes back
 * to the one that left. This tab names the ids it has used, and the room answers from its own journal
 * which replies *this* browser never heard (#52). Naming an id can only take a reply out of the
 * catch-up, never put someone else's in, so a stale id costs at most one repetition. */
const SESSIONS_KEY='sidevoice.sessions',REMEMBERED_SESSIONS=8;
function rememberedSessions(){try{const stored=JSON.parse(sessionStorage.getItem(SESSIONS_KEY)||'[]');return Array.isArray(stored)?stored.filter(id=>typeof id==='string').slice(-REMEMBERED_SESSIONS):[]}catch{return []}}
function rememberSession(id){if(!id)return;try{sessionStorage.setItem(SESSIONS_KEY,JSON.stringify([...rememberedSessions().filter(value=>value!==id),id].slice(-REMEMBERED_SESSIONS)))}catch{}}
let connectEpoch=0;
// A setting the room can only honour with another pipeline opens a second socket while the first
// one still carries the call. Until the room answers it, that socket is nobody's: `ws` is the call.
let openingSocket=null,switchEpoch=0;
window.sidevoiceSessionId=()=>state.sessionId;
let audioContext=null,analyser=null,micSource=null,meterFrame=null,holding=false,spaceDown=false;
let inputDeviceId='default',outputDeviceId='default',captureNode=null,deviceEpoch=0,captureRate=16000;
let screenWakeLock=null,wakeRequest=null,wakeEpoch=0,wakeRetries=0;
const waveLevels=Array(3).fill(0);
function micTrack(){return state.stream?.getAudioTracks?.()[0]||null}
function applyMicState(){const track=micTrack();if(track)track.enabled=state.micEnabled}
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
function showScreenLock(lockState,note){state.screenLock={state:lockState,note}}
/* Echo coverage, as far as the page can see it: the microphone track must have echo cancellation on, and the
 * room's voice must leave through the media element (on iOS only that playback joins the echo reference). The
 * page cannot see whether the canceller is doing well; what it can see is whether the conditions hold. */
function echoCoverage(){const track=micTrack();return deriveEchoCoverage({connected:!!state.ws,track:!!track,aec:track?.getSettings?.().echoCancellation,health:window.roomVoice?.health?.()})}
function showEchoCover(){const track=micTrack();state.echoFacts={connected:!!state.ws,track:!!track,aec:track?.getSettings?.().echoCancellation,health:window.roomVoice?.health?.()}}
window.addEventListener('voice-output',()=>showEchoCover());
async function keepScreenAwake(){
 // Asked for while connecting too: Safari grants the lock to the tap that started the
 // call, and by the end of the preparation chain that gesture has expired.
 if(!(state.ws||state.connecting)||document.hidden||screenWakeLock||wakeRequest)return;
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
    if(state.ws&&!document.hidden&&wakeRetries<3){++wakeRetries;setTimeout(()=>{if(state.ws&&!document.hidden)keepScreenAwake()},1000)}
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
/* The list of microphones and speakers is a fact about this device, and the selects that show it are
 * React's. The browser only names a device once the microphone has been granted, so the list is refreshed
 * rather than read once (#53). */
function deviceOptions(devices,kind,selected){
  const listed=devices.filter(d=>d.kind===kind&&d.deviceId&&d.deviceId!=='default');
  const options=[{id:'default',label:'Predeterminado del sistema'},
    ...listed.map((device,index)=>({id:device.deviceId,label:device.label||((kind==='audioinput'?'Micrófono ':'Altavoz ')+(index+1))}))];
  if(selected!=='default'&&!listed.some(d=>d.deviceId===selected))
   options.push({id:selected,label:'Dispositivo seleccionado · desconectado'});
  return options;
}
async function refreshAudioDevices(){
 const devices=state.audioDevices;
 if(!globalThis.navigator?.mediaDevices?.enumerateDevices){
  state.audioDevices={...devices,inputs:[],outputs:[],available:false};
  state.deviceNote='Selecciona los dispositivos desde los ajustes del sistema.';
  return;
 }
 try{
  const listed=await navigator.mediaDevices.enumerateDevices();
  const outputs=!!window.roomVoice?.supportsOutputSelection;
  state.audioDevices={busy:false,available:true,outputAvailable:outputs,
   inputs:deviceOptions(listed,'audioinput',inputDeviceId),outputs:deviceOptions(listed,'audiooutput',outputDeviceId),
   inputId:inputDeviceId,outputId:outputDeviceId};
  state.deviceNote=outputs?'Los nombres aparecen tras conceder permiso al micrófono.'
   :'Cambia la salida desde los ajustes del sistema; este navegador no permite elegirla aquí.';
 }catch(error){state.deviceNote=error.message||'No se pudieron enumerar los dispositivos.'}
}
/* Choosing one is an action, not an event on a node: React calls this and the runtime does the work. */
async function selectAudioDevice(kind,id){
 const devices=state.audioDevices;
 state.audioDevices={...devices,busy:true,...(kind==='input'?{inputId:id}:{outputId:id})};
 try{
  if(kind==='input'){await replaceMicrophone(id);state.deviceNote='Micrófono seleccionado.'}
  else{await window.roomVoice.unlock();await window.roomVoice.setOutputDevice(id);outputDeviceId=id;state.deviceNote='Salida de audio seleccionada.'}
  state.audioDevices={...state.audioDevices,busy:false};
 }catch(error){
  state.audioDevices={...state.audioDevices,busy:false,...(kind==='input'?{inputId:inputDeviceId}:{outputId:outputDeviceId})};
  state.deviceNote=error.message;
 }
}
async function replaceMicrophone(id){
 const epoch=++deviceEpoch,socket=state.ws,callEpoch=connectEpoch;
 if(!socket||!captureNode){inputDeviceId=id;return}
 const next=await acquireMicrophone(id);
 if(epoch!==deviceEpoch||socket!==state.ws||callEpoch!==connectEpoch){next.getTracks().forEach(t=>t.stop());return}
 let source;
 try{
  source=audioContext.createMediaStreamSource(next);
  next.getAudioTracks().forEach(t=>t.enabled=state.micEnabled);
  source.connect(analyser);source.connect(captureNode);
 }catch(error){source?.disconnect();next.getTracks().forEach(t=>t.stop());throw error}
 const previous=state.stream;micSource.disconnect();micSource=source;state.stream=next;inputDeviceId=id;
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

 globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange',refreshAudioDevices);
}
let voiceCatalog=null;let voiceDraft={};let editingLanguage=null;let callExecution='browser';let elevenCredentials={};let sttCredentials={};let pendingBotText=[];
let textAttempt=null;
const SHOW_ALL_VOICES='__show_all_voices__';let defaultVoicesExpanded=false;const expandedVoiceLanguages=new Set();
try{state.roomSeen=JSON.parse(sessionStorage.getItem('voice-room-seen')||'{}')}catch{}
try{state.history=JSON.parse(sessionStorage.getItem('voice-room-transcript')||'[]');if(!Array.isArray(state.history))state.history=[]}catch{}
function save(){try{sessionStorage.setItem('voice-room-transcript',JSON.stringify(state.history.slice(-1000)))}catch{}}
function targetId(){return state.roomBinding?.thread_id||null}
function historyThreadId(){return state.viewedThread||targetId()}

async function api(path,options){const r=await fetch(path,options),d=await r.json();if(!r.ok)throw Error(d.detail||'No se pudo completar la operación');return d}
const post=(path,body)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

/* What the microphone heard while the room was unreachable, said plainly. The person spoke to
 * nobody for a moment, and how much of it survived is a fact they are entitled to read. */

/* What the room is repeating because this browser never heard it (#52), said on the bubble itself so a
 * reply from two minutes ago is never taken for something just said. The mark follows what actually
 * happened to the repetition — queued, sounding, finished, cancelled by a new turn, or an audio the
 * room no longer has — because promising a repetition that never played would be the same lie. */


function replayNote(r){return r.role==='assistant'&&REPLAY_NOTES[state.replayMarks[r.segment]]||''}
function markReplay(id,status){if(!id||!Object.hasOwn(state.replayMarks,id))return;state.replayMarks={...state.replayMarks,[id]:status};markHistorySeen()}
function noteReplay(d){
 for(const item of d.replies||[])if(item?.history_id)state.replayMarks={...state.replayMarks,[item.history_id]:'queued'};
 for(const item of d.skipped||[])if(item?.history_id)state.replayMarks={...state.replayMarks,[item.history_id]:'gone'};
 markHistorySeen();
}
// A new turn, or the room cancelling the audio, ends the catch-up: what never sounded does not claim it did.
function cancelPendingReplays(){
 let changed=false;
 for(const [id,status] of Object.entries(state.replayMarks))if(status==='queued'||status==='playing'){state.replayMarks={...state.replayMarks,[id]:'cancelled'};changed=true}
 if(changed)markHistorySeen();
}


function clearKaraoke(speech){if(state.karaokeState?.segment===speechSegment(speech))state.karaokeState=null}
function updateKaraoke(speech,range){
 if(state.activeSpeech?.utterance_id!==speech.utterance_id||speech.session_id!==state.sessionId)return;
 state.karaokeState=range?{segment:speechSegment(speech),...range}:null;
}
function markHistorySeen() {
    const id = historyThreadId(), seen = Math.max(state.roomSeen[id] || 0, ...state.history.filter(r => r.thread === id).map(r => r.seq || 0));
    if (seen !== (state.roomSeen[id] || 0)) {
        state.roomSeen = { ...state.roomSeen, [id]: seen };
        try {
            sessionStorage.setItem('voice-room-seen', JSON.stringify(state.roomSeen));
        }
        catch { }
    }
}
function add(role, text, segment, thread = targetId(), metadata = {}) { if (!text?.trim())
    return; const key = metadata.history_id || (segment == null ? null : state.sessionId + ':' + segment); const existing = key && state.history.find(r => r.segment === key); if (existing) {
    state.history = state.history.map(r => r === existing ? { ...r, text, ...metadata } : r);
    save();
    markHistorySeen();
    return;
} state.history = [...state.history, { segment: key, thread, role, text, session: state.sessionId, revision: segment?.toString().startsWith('user-turn:') ? Number(segment.slice(10)) : undefined, ...metadata, name: role === 'user' ? 'Tú' : state.people.find(p => p.thread_id === thread)?.title || state.roomBinding?.title || 'Conversación', time: metadata.time || Date.now() }]; state.history = state.history.slice(-1000); save(); markHistorySeen(); }
async function cancelCurrentInput(){if(!state.userTurn||state.cancelledInput)return;const revision=Number(state.userTurn.key.slice(10));try{await post("/api/presentation/cancel-input",{session_id:state.sessionId,revision});cancelDraft(revision)}catch(e){setRoomError(e.message);throw e}}

function cancelDraft(revision){state.cancelledInput=true;state.history=state.history.filter(r=>r.segment!==state.sessionId+':user-turn:'+revision);save();partial('');markHistorySeen()}
function partial(text){state.pendingUserText=text||''}
function updateComposer(){const ready=!!state.ws&&!!state.sessionId&&!!targetId()&&historyThreadId()===targetId()&&!state.switching;$('text-message').disabled=!ready;$('text-send').disabled=!ready||state.textSending;$('text-message').placeholder=ready?'Escribe un mensaje…':'Entra en la sala y selecciona una conversación';}
$('text-composer').onsubmit=async event=>{event.preventDefault();const input=$('text-message'),text=input.value;if(state.textSending||!text.trim()||!state.sessionId||!targetId())return;const destination=targetId(),key=JSON.stringify([state.sessionId,destination,text]);if(textAttempt?.key!==key)textAttempt={key,id:crypto.randomUUID()};const attempt=textAttempt;state.textSending=true;updateComposer();setRoomError('');try{await post('/api/presentation/text',{text,thread_id:destination,session_id:state.sessionId,binding_id:state.roomBinding.binding_id,message_id:attempt.id});if(input.value===text)input.value='';if(textAttempt===attempt)textAttempt=null;await refreshHistory()}catch(e){setRoomError(e.message||'No se pudo confirmar el envío. El texto se conserva.')}finally{state.textSending=false;updateComposer()}};
$('text-message').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('text-composer').requestSubmit()}});
function updateMic(){state.micEnabled=micTrack()?.enabled??state.micEnabled;updateComposer()}
function setMic(enabled){stopPreview();state.micEnabled=enabled;applyMicState();updateMic()}
function releaseHold(){spaceDown=false;state.holding=false;if(holding){holding=false;setMic(false)}}

document.addEventListener('click',event=>{if(!$('call-controls').contains(event.target))setDevicesOpen(false);for(const menu of document.querySelectorAll('.participant-menu[open],.call-menu[open]'))if(!menu.contains(event.target))menu.open=false});
document.addEventListener('keydown',event=>{if(event.key==='Escape')setDevicesOpen(false);if(event.key==='Escape')for(const menu of document.querySelectorAll('.participant-menu[open],.call-menu[open]'))menu.open=false});
async function select(id){if(state.switching||id===targetId()||!state.sessionId)return;state.switching=true;try{await post('/api/presentation/select',{thread_id:id,session_id:state.sessionId});rememberThread(id);await refresh()}catch(e){setRoomError(e.message)}finally{state.switching=false}}
async function refresh(){try{
 const d=await api(roomQuery('/api/presentation'));
 const previousThread=targetId(),changed=state.roomBinding?.binding_id!==d.binding?.binding_id;roomStore.batch(()=>{state.roomBinding=d.binding;if(d.binding?.thread_id)rememberThread(d.binding.thread_id);
 if(changed){state.viewedThread=null;state.turns={};if(previousThread!==targetId())state.harness=Object.fromEntries(Object.entries(state.harness).filter(([id])=>id!==previousThread));cancelBrowserSpeech();pendingBotText=[];state.pendingUserText='';state.userLive=state.botLive=false;markHistorySeen()}
 updateComposer();
 const call=d.call?.id===state.sessionId?d.call:null;if(call?.error)setRoomError(call.error);});
}catch{state.liveNote='Servidor no disponible'}}
async function refreshHistory() { try {
    const data = await api('/api/presentation/history');
    let changed = false;
    for (const r of data.messages) {
        const marker = ':voice:', suffix = r.role === 'assistant' && r.id.includes(marker) ? r.id.slice(r.id.lastIndexOf(marker)) : null;
        let row = state.history.find(h => h.segment === r.id);
        const aliases = suffix ? state.history.filter(h => h !== row && h.role === 'assistant' && h.segment?.endsWith(suffix) && h.thread === r.thread && h.text === r.text) : [];
        if (!row && aliases.length) {
            row = aliases.shift();
            changed = true;
        }
        if (aliases.length) {
            state.history = state.history.filter(h => !aliases.includes(h));
            changed = true;
        }
        const patch = { segment: r.id, thread: r.thread, role: r.role, text: r.text, name: r.role === 'user' ? 'Tú' : state.people.find(p => p.thread_id === r.thread)?.title || r.name, time: r.time, seq: r.seq, session: r.session, revision: r.revision, audio_reason: r.audio_reason, offline: r.offline, interrupted: ['interrupted', 'disconnected'].includes(r.status), draft: false, delivery: r.role === 'user' ? r.status : undefined, audio: r.role === 'assistant' ? r.status : undefined };
        if (!row) {
            state.history = [...state.history, patch];
            changed = true;
        }
        else if (JSON.stringify({ ...row, ...patch }) !== JSON.stringify(row)) {
            state.history = state.history.map(r => r === row ? { ...r, ...patch } : r);
            changed = true;
        }
    }
    if (changed) {
        state.history = state.history.slice(-1000);
        save();
        markHistorySeen();
    }
    for (const r of state.history) {
        const turn = (r.session || state.sessionId) + ':user-turn:' + r.revision;
        if (state.turns[turn] && r.delivery && r.delivery !== state.turns[turn].status)
            presenceReceipt(turn, r.delivery);
    }
}
catch { } }
$('pair-connector').onclick=async()=>{try{const r=await post('/api/connectors/pairing-code',{});$('pair-code').textContent=r.code;$('pair-code').hidden=false;$('pair-help').hidden=false}catch(e){setRoomError(e.message||'No se pudo generar el código')}}
async function selectOnlyListeningConversation(){
 if(targetId()||state.switching||!state.ws)return false;
 const listening=state.people.filter(person=>person.available&&person.reach?.state==='listening');
 if(listening.length!==1)return false;
 await select(listening[0].thread_id);return true;
}
async function refreshPeople(){try{const data=await api(roomQuery('/api/presentation/participants'));state.people=data.participants;await reselectRemembered()||await selectOnlyListeningConversation()}catch{}}
async function reselectRemembered(){
 // After a reload or a reconnect this tab goes back to the conversation it was on, if it is still in the room.
 const wanted=rememberedThread();
 if(!wanted||targetId()||state.switching||!state.ws)return false;
 if(!state.people.some(person=>person.thread_id===wanted&&person.available))return false;
 await select(wanted);return true;
}
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
 const measured=(Array.isArray(snapshot?.replies)?snapshot.replies:[]).filter(Boolean);
 const replies=measured.filter(r=>r.thread_id===thread);
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
 renderLatencyAggregates(measured);
}
// The last turn, stage by stage in the order they happen; each measured on its own clock, so bars compare, they do not add up.
// The third entry is the stage's stable name: it identifies the row in the aggregates and is what a metric will be called.
const LATENCY_STAGES=[
 ['Silencio hasta cerrar el turno',r=>r.input_ms?.endpoint_silence_ms,'endpoint_silence'],
 ['Turno cerrado → texto',r=>r.input_ms?.recognition_ms,'recognition'],
 ['Whisper en este navegador',r=>r.input_ms?.request_to_transcript_ms,'request_to_transcript'],
 ['Texto → entregado al agente',r=>r.input_ms?.transcript_to_delivery_ms,'transcript_to_delivery'],
 ['Entregado → leído por la conversación',r=>r.server_ms?.delivery_accepted_to_read_ms??r.server_ms?.input_queued_to_read_ms,'delivery_to_read'],
 ['Leído → primera respuesta',r=>r.server_ms?.read_to_reply_received_ms,'read_to_reply'],
 ['Agente: entrega → primera respuesta',r=>r.server_ms?.input_queued_to_reply_received_ms,'input_queued_to_reply'],
 ['Respuesta → inicio de síntesis',r=>r.server_ms?.reply_received_to_synthesis_started_ms,'reply_to_synthesis'],
 ['Síntesis en el proveedor',r=>r.provider_ms?.request_to_complete_ms,'provider_synthesis'],
 ['Audio recibido → reproducción',r=>r.browser_ms?.audio_received_to_playback_scheduled_ms,'audio_received_to_playback'],
];
function renderLatencyStages(reply){
 const list=$('stats-stages');if(!list)return;list.replaceChildren();
 if(!reply){$('stats-stages-note').textContent='Aún no hay un turno completo que mostrar.';return}
 const values=LATENCY_STAGES.map(([label,pick])=>[label,pick(reply)]),max=Math.max(1,...values.map(([,v])=>statsNumber(v)?v:0));
 for(const [label,value] of values){const item=document.createElement('li');const name=document.createElement('span');name.textContent=label;const bar=document.createElement('i');if(statsNumber(value))bar.style.width=Math.max(1,Math.round(value/max*100))+'%';else bar.hidden=true;const amount=document.createElement('b');amount.textContent=statsDuration(value);item.append(name,bar,amount);list.append(item)}
 $('stats-stages-note').textContent='Turno '+reply.reply_revision+' · el tramo más largo marca la escala.';
}
// Aggregates over the whole call, from the same snapshot the dialog already polls. Percentiles are
// nearest-rank: every number shown is a measurement that happened, never an interpolation between two.
// A stage nobody measured keeps its row with no numbers; a missing observation is never a zero.
function statsPercentile(sorted,fraction){
 return sorted.length?sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(fraction*sorted.length)-1))]:null;
}
function statsSummary(values){
 const sample=(Array.isArray(values)?values:[]).filter(statsNumber).sort((a,b)=>a-b),count=sample.length;
 if(!count)return {count:0,mean:null,p50:null,p90:null,max:null};
 return {count,mean:sample.reduce((total,value)=>total+value,0)/count,p50:statsPercentile(sample,0.5),p90:statsPercentile(sample,0.9),max:sample[count-1]};
}
function statsAggregate(replies,stages=LATENCY_STAGES){
 const measured=(Array.isArray(replies)?replies:[]).filter(Boolean);
 return stages.map(([label,pick,key])=>({key,label,...statsSummary(measured.map(reply=>pick(reply)))}));
}
const AGGREGATE_COLUMNS=['Tramo','n','Media','p50','p90','Máx'];
function statsThreads(replies){return [...new Set(replies.map(reply=>reply.thread_id).filter(Boolean))]}
function statsConversationName(threadId){return state.people.find(person=>person.thread_id===threadId)?.title||threadId}
function statsAggregateCaption(count){return count+(count===1?' respuesta medida':' respuestas medidas')}
function statsAggregateTable(caption,rows){
 const wrap=document.createElement('div');wrap.className='stats-table-wrap';
 const table=document.createElement('table');table.className='stats-table';
 const title=document.createElement('caption');title.textContent=caption;
 const head=document.createElement('thead'),headRow=document.createElement('tr');
 headRow.append(...AGGREGATE_COLUMNS.map(text=>statsCell('th',text)));head.append(headRow);
 const body=document.createElement('tbody');
 for(const row of rows){
  const line=document.createElement('tr');
  line.append(statsCell('td',row.label),statsCell('td',row.count||'—'),...[row.mean,row.p50,row.p90,row.max].map(value=>statsCell('td',statsDuration(value))));
  body.append(line);
 }
 table.append(title,head,body);wrap.append(table);return wrap;
}
// Whatever the dialog is aggregating right now, so the copy button and the tables never disagree.
let statsReplies=[];
function renderLatencyAggregates(replies){
 const host=$('stats-aggregates');if(!host)return;
 statsReplies=(Array.isArray(replies)?replies:[]).filter(Boolean);
 $('stats-aggregates-copied').textContent='';
 $('stats-aggregates-copy').disabled=!statsReplies.length;
 if(!statsReplies.length){host.replaceChildren();$('stats-aggregates-note').textContent='Aún no hay respuestas medidas en esta llamada.';return}
 const threads=statsThreads(statsReplies);
 const tables=[statsAggregateTable('Toda la sesión · '+statsAggregateCaption(statsReplies.length),statsAggregate(statsReplies))];
 // The agent side dominates and differs per harness, so a call that talked to two conversations gets one table each.
 if(threads.length>1)for(const thread of threads){
  const own=statsReplies.filter(reply=>reply.thread_id===thread);
  tables.push(statsAggregateTable(statsConversationName(thread)+' · '+statsAggregateCaption(own.length),statsAggregate(own)));
 }
 host.replaceChildren(...tables);
 $('stats-aggregates-note').textContent='Recuento, media, p50, p90 y máximo por tramo sobre '+statsAggregateCaption(statsReplies.length)+'. Los tramos se solapan: no se deben sumar. Percentiles por rango más cercano.';
}
function statsTextTable(caption,rows){
 const cells=[AGGREGATE_COLUMNS,...rows.map(row=>[row.label,row.count?String(row.count):'—',statsDuration(row.mean),statsDuration(row.p50),statsDuration(row.p90),statsDuration(row.max)])];
 const widths=AGGREGATE_COLUMNS.map((_,column)=>Math.max(...cells.map(row=>row[column].length)));
 const line=row=>row.map((cell,column)=>column?cell.padStart(widths[column]):cell.padEnd(widths[column])).join('  ').trimEnd();
 return [caption,line(cells[0]),widths.map(width=>'-'.repeat(width)).join('  '),...cells.slice(1).map(line)].join('\n');
}
function statsAggregatesText(replies){
 const measured=(Array.isArray(replies)?replies:[]).filter(Boolean),threads=statsThreads(measured);
 const blocks=[statsTextTable('Toda la sesión · '+statsAggregateCaption(measured.length),statsAggregate(measured))];
 if(threads.length>1)for(const thread of threads){
  const own=measured.filter(reply=>reply.thread_id===thread);
  blocks.push(statsTextTable(statsConversationName(thread)+' · '+statsAggregateCaption(own.length),statsAggregate(own)));
 }
 return ['Sidevoice · agregados de latencia · los tramos se solapan, no se suman',...blocks].join('\n\n');
}
async function copyLatencyAggregates(){
 const status=$('stats-aggregates-copied');
 if(!statsReplies.length){status.textContent='Aún no hay nada que copiar.';return}
 try{
  const clipboard=globalThis.navigator?.clipboard;
  if(!clipboard?.writeText)throw Error('sin portapapeles');
  await clipboard.writeText(statsAggregatesText(statsReplies));
  status.textContent='Copiado como texto.';
 }catch{status.textContent='Este navegador no dejó copiar; selecciona la tabla a mano.'}
}

// ----- the ambient bed: this browser's turn is in the conversation's hands (#42) -----
// Feedback with no model in it. Between the moment the conversation has read what this browser sent and
// the moment it speaks, a driver cannot tell work from a hang, and the silence is the whole problem. So
// The harness report is authoritative. Without one, receipts and replies record turn work;
// the store derives whether the silence between voices can carry the ambient breath.
// The sound itself, its level and why it cannot open a microphone turn are in RoomVoice.startPresence.
let presenceTimer=null;
function presenceReceipt(id,status){
 roomStore.batch(()=>{state.now=Date.now();state.turns=recordReceipt(state,id,status,state.now)});
}
// The timer contributes a clock fact. Scheduling and ambient playback are reconciled below,
// for every store transition, rather than remembered by individual event handlers.
let receiptDeadline=null,bedPlaying=false,observedStream=null;
function reconcileSession(view){
 if(view.facts.stream!==observedStream){observedStream=view.facts.stream;showEchoCover();return}
 const deadlines=Object.values(state.turns).filter(t=>!t.settled&&['delivered','unconfirmed'].includes(t.status)&&t.readyAt>state.now).map(t=>t.readyAt);
 // The bed waits for the person to be really done, so the moment that wait ends is a deadline like any other.
 if(state.userQuietAt&&state.userQuietAt+BED_AFTER_USER_MS>state.now)deadlines.push(state.userQuietAt+BED_AFTER_USER_MS);
 const deadline=deadlines.length?Math.min(...deadlines):null;
 if(deadline!==receiptDeadline){clearTimeout(presenceTimer);receiptDeadline=deadline;
  if(deadline!==null)presenceTimer=setTimeout(()=>{receiptDeadline=null;state.now=Math.max(Date.now(),deadline)},Math.max(0,deadline-state.now));
 }
 if(view.session.bed!==bedPlaying){
  if(view.session.bed){bedPlaying=true;bedPlaying=!!window.roomVoice?.startPresence?.({volume:PRESENCE_LEVEL,reason:'working_quiet'})}
  else {bedPlaying=false;window.roomVoice?.stopPresence?.('not_quiet_or_working')}
 }
 publishSessionView(view);
}
// The output's notable moments go to the room, so a phone that gets stuck can be read from the other end.
const REPORTED_OUTPUT_EVENTS=new Set(['cancel','stall','fail','complete','attach-refused','resume-refused','element-refused','audio-while-stopped','unlock-refused']);
function reportAudioHealth(reason){
 if(!state.ws||state.ws.readyState!==1||!state.sessionId||!window.roomVoice?.health)return;
 const health=window.roomVoice.health();
 // The same moment, twice said and once measured: the room's report keeps working exactly as it did,
 // and the trace gets it as an event on the call span instead of a channel of its own.
 window.sidevoiceTelemetry?.audioEvent?.(reason,{'sidevoice.audio_output':health?.output,'sidevoice.audio_context':health?.context,'sidevoice.stalls':health?.stalls});
 try{state.ws.send(JSON.stringify({type:'voice-audio-health',data:{session_id:state.sessionId,reason,health}}))}catch{}
}
window.addEventListener('voice-output',event=>{const kind=event.detail?.kind;if(REPORTED_OUTPUT_EVENTS.has(kind))reportAudioHealth(kind)});

// ----- uncaught errors: nobody can read a phone's console while driving (#58) -----
// An uncaught error in the interface unmounts React and leaves a blank room, and the person it
// happens to is the one who cannot look. The room keeps the last few reports next to the audio ones,
// so the reason is read from the server. Never any transcript text: the message and the stack only.
function reportClientError(report){
 const entry={kind:String(report?.kind||'error').slice(0,40),message:String(report?.message||'').slice(0,400),
  stack:String(report?.stack||'').slice(0,2000),component:String(report?.component||'').slice(0,1000),
  build:String(window.sidevoiceBuildId||'').slice(0,40)};
 if(state.ws?.readyState===WebSocket.OPEN&&state.sessionId){
  try{state.ws.send(JSON.stringify({type:'voice-client-error',data:{session_id:state.sessionId,...entry}}));return}catch{}
 }
 // Before the call exists, or once its socket is gone, the beacon still reaches the room.
 try{navigator.sendBeacon?.('/api/presentation/client-error',new Blob([JSON.stringify(entry)],{type:'application/json'}))}catch{}
}
window.sidevoiceReportError=reportClientError;
for(const queued of window.sidevoiceClientErrors||[])reportClientError(queued);
window.sidevoiceClientErrors=[];
function forgetThread(threadId){state.history=state.history.filter(r=>r.thread!==threadId);save();if(state.viewedThread===threadId)state.viewedThread=null;markHistorySeen()}
function versionFacts(){
 const page=window.sidevoiceBuildId||'dev',served=state.roomInfo?.web_build||null;
 const stale=served&&page!=='dev'&&served!==page;
 return [['Versión de la página',page],['Versión que sirve la sala',served?served+(stale?' · hay una versión nueva, recarga':' · al día'):'—'],['Servidor',state.roomInfo?.version||'—']];
}
function audioOutputFacts(health){
 if(!health)return [];
 const states={running:'activo',suspended:'suspendido',interrupted:'interrumpido',closed:'cerrado',none:'sin iniciar'};
 const output=health.output==='element'?(health.element?.paused?'Elemento de audio en pausa':'Elemento de audio reproduciendo'):health.output==='context'?'Contexto directo (sin cancelación de eco propia)':'Sin salida';
 const clock=statsNumber(health.clock)?health.clock.toFixed(2)+' s · '+(states[health.context]||health.context):'—';
 const events=(health.events||[]).slice(-6).map(e=>new Date(e.at).toTimeString().slice(3,8)+' '+e.kind+(e.detail?' ('+e.detail+')':'')).join(' · ')||'Ninguno';
 const presence=health.presence?'Sonando · pico '+(health.presence*100).toFixed(1)+' % de escala':'En silencio';
 return [['Salida de audio',output],['Reloj de audio',clock],['Sonido de presencia',presence],['Bloqueos de reproducción',String(health.stalls||0)+(health.resuming?' · recuperando':'')],['Últimos eventos de audio',events]];
}
function renderConnectionStats(data,roundTrip){
 const call=state.sessionId&&data?.call?.id===state.sessionId?data.call:null,track=micTrack(),settings=track?.getSettings?.()||{};
 // The stats read the same list the selects do, not the DOM the selects happen to have rendered.
 const selectedLabel=kind=>{const devices=state.audioDevices,id=kind==='input'?devices.inputId:devices.outputId;
  return (kind==='input'?devices.inputs:devices.outputs).find(option=>option.id===id)?.label||'Predeterminado del sistema'};
 const flag=value=>value===true||value==='all'?'Activado':value===false?'Desactivado':'No confirmado';
 const socket=['Conectando','Conectado','Cerrando','Desconectado'][state.ws?.readyState]||'Desconectado';
 const context=window.roomVoice?.context||audioContext,stt=call?.transcription;
 const sttReasons={explicit:'Selección explícita',auto_key:'Automático · clave disponible',auto_no_key:'Automático · sin clave, fallback local',openai_without_key:'OpenAI solicitado sin clave · fallback local'};
 const sttExecution=!stt?'—':stt.location==='local'
  ?[stt.device,stt.compute_type].filter(Boolean).join(' · ')
  :'Remota';
 const facts=[
  ...versionFacts(),
  ['WebSocket',socket],
  ['Consulta al servidor (HTTP)',statsDuration(roundTrip)],
  ['Sesión',state.sessionId||'Sin llamada'],
  ['Servidor y navegador',call?'Misma sesión':state.sessionId?'Sesión no confirmada':'Sin llamada'],
  ['Transcripción',stt?[stt.provider,stt.model].filter(Boolean).join(' · '):'—'],
  ['Motor STT',stt?.engine||'—'],
  ['Ejecución STT',sttExecution],
  ['Selección STT',sttReasons[stt?.reason]||stt?.reason||'—'],
  ['Motor de audio',({running:'Activo',suspended:'Suspendido',closed:'Cerrado'})[context?.state]||'No iniciado'],
  ...audioOutputFacts(window.roomVoice?.health?.()),
  ['Micrófono',track?.label||selectedLabel('input')],
  ['Captura',!track?'No iniciada':track.readyState==='ended'?'Finalizada':track.muted?'Sin señal del dispositivo':track.enabled?'Activa':'Silenciada'],
  ['Altavoces',selectedLabel('output')],
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
 const epoch=statsEpoch,callId=state.sessionId,thread=targetId(),controller=new AbortController();
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
  if(callId!==state.sessionId||thread!==targetId()){resetStats();$('stats-status').textContent='La conversación ha cambiado. Actualizando…';return}
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
$('stats-aggregates-copy').onclick=copyLatencyAggregates;
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
function latencyKey(thread,revision){return JSON.stringify([state.sessionId,thread,revision])}
// The turn's root span is this page's: the room announces the turn, this browser opens the span and
// hands the room its W3C traceparent, so every stage the room measures hangs from the same trace.
function openTurnTrace(threadId,revision){
 const traceparent=window.sidevoiceTelemetry?.startTurn?.(threadId,revision,{'sidevoice.stt_provider':state.voicePreferences?.stt_provider,'sidevoice.turn_end_mode':state.voicePreferences?.turn_end_mode});
 if(!traceparent||!state.ws||state.ws.readyState!==1||!state.sessionId)return;
 try{state.ws.send(JSON.stringify({type:'voice-turn-trace',data:{session_id:state.sessionId,thread_id:threadId,revision,traceparent}}))}catch{}
}
function observeLatencyEvent(type,data){
 const now=latencyNow();if(!Number.isFinite(now))return;
 if(type==='voice-user-turn'){
  const key=latencyKey(data.thread_id,data.revision);
  if(data.phase==='started'){latencyActiveTurn=key;if(!latencyTurns.has(key))latencyTurns.set(key,{});openTurnTrace(data.thread_id,data.revision)}
  if(data.phase==='cancelled'){latencyTurns.delete(key);if(latencyActiveTurn===key)latencyActiveTurn=null;window.sidevoiceTelemetry?.endTurn?.(data.thread_id,data.revision,data.merged?'merged':'cancelled')}
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
 window.sidevoiceTelemetry?.stage?.(d.thread_id,d.reply_revision??d.revision,'audio_received_to_playback',now-received,{'sidevoice.utterance_id':d.utterance_id,'sidevoice.reply_revision':d.reply_revision??d.revision});
 const turn=latencyTurns.get(latencyKey(d.thread_id,d.reply_revision??d.revision));
 if(Number.isFinite(turn?.finished)){
  durations.turn_finished_event_to_playback_scheduled_ms=now-turn.finished;
  if(Number.isFinite(turn.vadStop))durations.vad_stop_event_to_turn_finished_event_ms=turn.finished-turn.vadStop;
 }
 return Object.fromEntries(Object.entries(durations).filter(([,v])=>Number.isFinite(v)&&v>=0&&v<=3600000));
}
function message(raw){return roomStore.batch(()=>recordMessage(raw))}
function recordMessage(raw) {
    let m;
    try {
        m = JSON.parse(raw);
    }
    catch {
        return;
    }
    const t = m.type, d = m.data || {};
    if (['voice-user-turn', 'user-transcription', 'user-started-speaking', 'user-stopped-speaking'].includes(t) && d.session_id && d.session_id !== state.sessionId)
        return;
    observeLatencyEvent(t, d);
    if (t === 'voice-transcribe') {
        if (d.session_id === state.sessionId)
            window.roomTranscription.transcribe(d);
        return;
    }
    if (t === 'voice-speech') {
        receiveBrowserSpeech(d);
        return;
    }
    if (t === 'voice-speech-audio') {
        receiveServerSpeech(d);
        return;
    }
    if (t === 'voice-replay' && d.session_id === state.sessionId) {
        noteReplay(d);
        return;
    }
    if (t === 'voice-cancel' && d.session_id === state.sessionId) {
        state.roomRevision = Math.max(state.roomRevision, d.revision);
        cancelPendingReplays();
        cancelBrowserSpeech();
        return;
    }
    if (t === 'voice-user-turn' && d.phase === 'started') {
        state.roomRevision = Math.max(state.roomRevision, d.revision);
        cancelPendingReplays();
        cancelBrowserSpeech();
    }
    if (t === 'voice-catchup-turn' && d.session_id === state.sessionId) { /* a message from the gap: its own bubble, with this browser's own clock, and nothing of the turn that may be open now */
        add('user', d.text, null, d.thread_id, { history_id: d.history_id, draft: false, offline: d.offline, time: d.time || Date.now(), delivery: d.thread_id ? (state.inputReceipts[d.history_id] || 'pending') : 'not_sent' });
        state.inputReceipts = Object.fromEntries(Object.entries(state.inputReceipts).filter(([id]) => id !== d.history_id));
        return;
    }
    if (t === 'voice-input-receipt') {
        const receiptId = d.history_id || (d.session_id || state.sessionId) + ':user-turn:' + d.revision;
        const row = state.history.find(r => r.thread === d.thread_id && r.segment === receiptId);
        if (row) {
            state.history = state.history.map(r => r === row ? { ...r, delivery: d.status } : r);
            save();
            markHistorySeen();
        }
        else
            state.inputReceipts = { ...state.inputReceipts, [receiptId]: d.status };
        if ((d.session_id || state.sessionId) === state.sessionId && d.thread_id === targetId())
            presenceReceipt((d.session_id || state.sessionId) + ':user-turn:' + d.revision, d.status);
    }
    if (t === 'voice-user-turn') {
        const key = 'user-turn:' + d.revision, receiptId = (d.session_id || state.sessionId) + ':' + key;
        if (d.phase === 'started') {
            state.cancelledInput = false;
            state.userTurn = { key, text: '', thread: d.thread_id };
            state.pendingPhase = 'listening';
            partial('');
        }
        else if (d.phase === 'cancelled') {
            state.inputReceipts = Object.fromEntries(Object.entries(state.inputReceipts).filter(([id]) => id !== receiptId));
            if (d.merged) { /* the room held this text for the turn now open: same bubble, nothing to remove */
                state.history = state.history.filter(r => r.segment !== state.sessionId + ':user-turn:' + d.revision);
                markHistorySeen();
            }
            else {
                state.pendingPhase = '';
                cancelDraft(d.revision);
            }
        }
        else if (d.phase === 'finished') {
            state.pendingPhase = '';
            partial('');
            add('user', d.text, key, d.thread_id, { draft: false, time: Date.now(), delivery: d.thread_id ? (state.inputReceipts[receiptId] || 'pending') : 'not_sent' });
            state.inputReceipts = Object.fromEntries(Object.entries(state.inputReceipts).filter(([id]) => id !== receiptId));
            state.userTurn = null;
        }
    }
    if (t === 'user-transcription' && !state.cancelledInput) {
        if (d.final) {
            partial('');
            if (state.userTurn) {
                state.userTurn = { ...state.userTurn, text: [state.userTurn.text, d.text].filter(Boolean).join(' ') };
                add('user', state.userTurn.text, state.userTurn.key, state.userTurn.thread, { draft: true });
            }
        }
        else if (!state.userTurn || state.userTurn.thread === historyThreadId())
            partial(d.text);
    }
    if (t === 'bot-output' && !['word', 'token'].includes(d.aggregated_by)) {
        const completed = d.spoken === true || d.spoken_status === 'completed';
        const index = completed ? pendingBotText.indexOf(d.text) : -1;
        if (index >= 0) {
            pendingBotText.splice(index, 1);
        }
        else {
            add('assistant', d.text, d.segment_id);
            if (d.spoken === false || d.spoken_status === 'new')
                pendingBotText.push(d.text);
        }
    }
    if (t === 'bot-started-speaking') {
        stopPreview();
        state.botLive = true;
    }
    if (t === 'bot-stopped-speaking') {
        state.botLive = false;
    }
    if (t === 'user-started-speaking') {
        if (state.userTurn) {
            state.pendingPhase = 'listening';
            markHistorySeen();
        }
        state.userLive = true;
        state.userQuietAt = 0;
        state.liveNote = '';
        cancelBrowserSpeech();
        state.userLive = true;
        if (state.botLive) {
            const last = [...state.history].reverse().find(r => r.thread === targetId() && r.role === 'assistant');
            if (last) {
                state.history = state.history.map(r => r === last ? { ...r, interrupted: true } : r);
                save();
                markHistorySeen();
            }
        }
        state.botLive = false;
    }
    if (t === 'user-stopped-speaking') {
        if (state.userTurn && state.pendingPhase === 'listening') {
            state.pendingPhase = 'transcribing';
            markHistorySeen();
        }
        state.userLive = false;
        state.userQuietAt = Date.now();
    }
    if (t === 'voice-conversation' && d.thread_id) {
        if (typeof d.working === 'boolean') {
            state.harness = { ...state.harness, [d.thread_id]: d.working };
            if (d.turn_phase === 'end' && d.session_id === state.sessionId && d.thread_id === targetId()
                    && Number.isInteger(d.revision)) {
                const id = d.session_id + ':user-turn:' + d.revision;
                const previous = state.turns[id] || {};
                state.turns = { ...state.turns, [id]: { ...previous, session: d.session_id,
                    thread: d.thread_id, settled: true, harnessEnded: true } };
                if (!previous.harnessEnded)
                    window.sidevoiceTelemetry?.endTurn?.(d.thread_id, d.revision, 'harness_finished');
            }
        }
    }
    if (t === 'error')
        setRoomError(d.message || d.error || 'Error de conexión');
}
function stopMeter(){cancelAnimationFrame(meterFrame);meterFrame=null;captureNode?.disconnect();captureNode=null;micSource?.disconnect();analyser?.disconnect();if(audioContext&&audioContext!==window.roomVoice?.context)audioContext.close().catch(()=>{});audioContext=null;analyser=null;micSource=null;$('mute').style.setProperty('--mic-fill','0%');$('mic-control').dataset.signal='quiet';$('mic-level-meter').setAttribute('aria-valuenow','0');waveLevels.fill(0);updateWave(0)}
/* The bubble of the turn being recorded draws this microphone: the waveform pulls the samples the meter's
 * own analyser already holds, once per animation frame and from the canvas itself. No second audio graph, no
 * capture of its own, and nothing that renders React at meter frequency (docs/FRONTEND.md). */
let waveSamples=null;
window.sidevoiceAudio={readWaveform(){
 if(!analyser)return null;
 if(!waveSamples||waveSamples.length!==analyser.fftSize)waveSamples=new Float32Array(analyser.fftSize);
 analyser.getFloatTimeDomainData(waveSamples);
 return waveSamples;
}};
function measureMic(samples,enabled){
 if(!enabled)return {value:0,state:'quiet',peak:0};
 let squares=0,peak=0;for(const sample of samples){squares+=sample*sample;peak=Math.max(peak,Math.abs(sample))}
 const rms=Math.sqrt(squares/samples.length),db=20*Math.log10(Math.max(rms,1e-6));
 return {value:Math.max(0,Math.min(100,Math.round((db+60)/60*100))),peak,state:peak>=.98?'clip':peak>=.8?'high':rms>.001?'normal':'quiet'};
}
function startMeter(rate){try{audioContext=window.roomVoice?.context||roomAudioContext(rate);analyser=audioContext.createAnalyser();analyser.fftSize=1024;micSource=audioContext.createMediaStreamSource(state.stream);micSource.connect(analyser);const data=new Float32Array(1024);let clipUntil=0,lastWave=0;function tick(){if(!analyser)return;analyser.getFloatTimeDomainData(data);const enabled=!!state.stream?.getAudioTracks()[0]?.enabled,level=measureMic(data,enabled);if(level.signal==='clip')clipUntil=Date.now()+600;const signal=enabled&&Date.now()<clipUntil?'clip':level.state;$('mute').style.setProperty('--mic-fill',level.value+'%');const meter=$('mic-level-meter'),mic=$('mic-control');mic.dataset.signal=signal;if(Date.now()-lastWave>=80){updateWave(level.value);lastWave=Date.now()}meter.setAttribute('aria-valuenow',String(level.value));const description=signal==='clip'?'Posible saturación del micrófono':signal==='high'?'Nivel de micrófono alto':'Nivel de micrófono';if(meter.dataset.signal!==signal){meter.dataset.signal=signal;meter.setAttribute('title',description);meter.setAttribute('aria-label',description)}meterFrame=requestAnimationFrame(tick)}tick()}catch{}}
function roomSocketUrl(){return (location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/presentation/ws'}
// The room speaks first: its call id and the PCM format it expects. Anything else arriving meanwhile is an ordinary room event.
function openSession(socket,hello={}){return new Promise((resolve,reject)=>{const fail=text=>{clearTimeout(timer);reject(Error(text))};let timer=setTimeout(()=>fail('La sala no respondió'),10000),refusal=null;socket.onopen=()=>socket.send(JSON.stringify({label:'rtvi-ai',type:'client-ready',id:crypto.randomUUID(),data:hello}));socket.onerror=()=>fail('No se pudo conectar con la sala');socket.onclose=event=>fail(event?.code===1013?'La sala ya tiene el máximo de navegadores conectados. Espera a que salga alguien y vuelve a entrar.':refusal||'La sala rechazó la conexión');socket.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='voice-preparation'){if(m.data?.phase==='loading'){clearTimeout(timer);timer=null}showPreparation(m.data||{});noteJoinPreparation(m.data||{});return}if(m.type!=='voice-session'){if(m.type==='error')refusal=m.data?.message||m.data?.error||refusal;message(e.data);return}state.roomInfo=m.data?.room||state.roomInfo;clearTimeout(timer);showPreparation({phase:'hidden'});resolve(m.data)}})}
// Capturing at the room's rate lets the browser resample; the worklet covers browsers that refuse the rate.
function roomAudioContext(rate){try{return new AudioContext({sampleRate:rate})}catch{return new AudioContext()}}
async function startCapture(socket,session){if(!micSource)throw Error('No se pudo capturar el micrófono');
 // A context created outside the click gesture can start suspended, and a suspended context never
 // runs the worklet: no audio would leave the page and nothing would say why.
 if(audioContext.state!=='running'){try{await audioContext.resume()}catch{}}
 if(audioContext.state!=='running')throw Error('El navegador no autorizó la captura de audio. Vuelve a pulsar para unirte.');
 const context=audioContext,source=micSource,epoch=connectEpoch;
 await context.audioWorklet.addModule('/voice/mic_capture.js?v='+encodeURIComponent(window.sidevoiceBuildId||'dev'));
 if(state.ws!==socket||audioContext!==context||epoch!==connectEpoch)return;
 captureRate=session.sample_rate;
 const node=new AudioWorkletNode(context,'mic-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit',processorOptions:{sampleRate:session.sample_rate}});captureNode=node;node.port.onmessage=e=>{
  if(captureNode!==node||!micTrack()?.enabled)return;
  // The socket is gone but the call is not: this is what the gap buffer exists for.
  if(state.ws===socket&&socket.readyState===WebSocket.OPEN)socket.send(e.data);else bufferGapAudio(e.data);
 };source.connect(node);node.connect(context.destination)/* reachable from the destination so it keeps running; its output stays silent */}
function disconnect() {
    latencyTurns.clear();
    latencyActiveTurn = null;
    window.sidevoiceTelemetry?.endCall?.('left');
    ++connectEpoch;
    state.connecting = false;
    releaseScreenWakeLock();
    audioSession(false);
    ++deviceEpoch;
    roomStore.patch({ harness: {}, turns: {} });
    window.roomVoice?.cancel();
    window.roomTranscription?.stop();
    if ($('voice-loading').open)
        $('voice-loading').close();
    clearJoinStatus();
    cancelBrowserSpeech();
    stopPreview();
    disarmGapBuffer();
    state.replayMarks = {};
    ++switchEpoch;
    state.switchingSession = false;
    const socket = state.ws, opening = openingSocket;
    state.ws = openingSocket = null;
    socket?.close();
    opening?.close();
    state.engineReady=false;
    showEchoCover();
    state.stream?.getTracks().forEach(t => t.stop());
    state.stream = null;
    stopMeter();
    state.sessionId = null;
    state.userLive = state.botLive = holding = spaceDown = false;
    state.userTurn = null;
    state.pendingPhase = '';
    pendingBotText = [];
    partial('');
    state.holding = false;
    state.liveNote = '';
    updateMic();
}
// Joining and leaving are the same button, and it belongs to React: this is what it calls (#53).
async function toggleCall(){if(state.ws||state.connecting){disconnect();return}state.connecting=true;const epoch=++connectEpoch;keepScreenAwake();setRoomError('');joinStatus('audio');try{await window.roomVoice.unlock();if(epoch!==connectEpoch)return;state.voicePreferences=await loadPreferences();if(epoch!==connectEpoch)return;if(state.voicePreferences.stt_provider!=='openai')joinStatus('whisper');const {browserStt,sttRuntime}=await prepareTranscription(state.voicePreferences);if(epoch!==connectEpoch)return;callExecution='browser';if(callExecution==='browser'&&(state.voicePreferences.default_model||'kokoro')==='kokoro'){joinStatus('voice');await window.roomVoice.prepare({device:state.voicePreferences.tts_device},text=>{state.liveNote=text})}if(epoch!==connectEpoch)return;audioSession(true);joinStatus('microphone');const acquiredStream=await acquireMicrophone();if(epoch!==connectEpoch){acquiredStream.getTracks().forEach(t=>t.stop());return}state.stream=acquiredStream;state.stream.getAudioTracks().forEach(t=>t.enabled=state.micEnabled);keepScreenAwake();refreshAudioDevices();roomStore.patch({engineReady:true,enginePreferences:state.voicePreferences,sttRuntime});joinStatus('room');const session=await joinRoom(epoch,{browserStt,sttRuntime});if(epoch!==connectEpoch||!session)return;await window.roomVoice.unlock();if(epoch!==connectEpoch)return;updateMic();showEchoCover();const remembered=rememberedThread();if(remembered)joinStatus('conversation',{subject:conversationTitle(remembered)});await refresh();await refreshPeople();if(epoch===connectEpoch)clearJoinStatus()}catch(e){if(epoch===connectEpoch){const failed=state.joinStep;disconnect();failJoin(joinFailureText(failed,e))}}finally{if(epoch===connectEpoch)state.connecting=false}}
// ----- the socket: opened on join, reopened by itself when the room goes away -----
// A room restart or a network blip must not end the call: the microphone permission, the media stream
// and the unlocked output all survive it; only the socket needs reopening, with the same hello.
const RECONNECT_DELAYS_MS=[1000,2000,5000,10000,10000,20000];

function shouldReconnect(event){return ![1008,1013].includes(event?.code)}   // refused by policy or full: do not insist
// The room replays nothing into a new session: the one being replaced is over the moment the new
// one exists, so this page drops what belonged to it instead of pretending it is still running.
function dropReplacedSession(socket){
 socket.onclose=socket.onmessage=socket.onerror=null;
 try{socket.close()}catch{}
 window.roomTranscription?.stop();
 cancelBrowserSpeech();state.userLive=state.botLive=false;state.pendingUserText='';state.pendingPhase='';markHistorySeen();
}
// `context.keepCurrent` is a swap: the call in progress keeps this page's socket, its audio and its
// microphone until the room has answered the new hello, so a refusal costs the call nothing.
async function joinRoom(epoch,context){
 const socket=new WebSocket(roomSocketUrl());socket.binaryType='arraybuffer';
 if(context.keepCurrent)openingSocket=socket;else state.ws=socket;
 let session;
 // The hello carries this browser's call span, so the room's own spans are inside it instead of
 // being a second trace about the same call. With no collector configured there is no span to carry.
 const traceparent=window.sidevoiceTelemetry?.startCall?.({'sidevoice.stt_provider':state.voicePreferences?.stt_provider,'sidevoice.stt_model':state.voicePreferences?.stt_model});
 try{session=await openSession(socket,{conversation:rememberedThread(),sessions:rememberedSessions(),settings:state.voicePreferences,transcription:context.sttRuntime,...(traceparent?{telemetry:{traceparent}}:{})})}
 // A swap that failed leaves nothing behind: this socket never became the call's, and a refusal
 // that timed out could still be open and still be talking to a page that is not listening.
 catch(error){if(context.keepCurrent){socket.onclose=socket.onmessage=socket.onerror=null;try{socket.close()}catch{}}throw error}
 finally{if(openingSocket===socket)openingSocket=null}
 if(epoch!==connectEpoch){socket.close();return null}
 socket.onerror=null;
 // Nothing is swapped over a socket that is already gone: the call keeps the one it has.
 if(socket.readyState!==WebSocket.OPEN)throw Error('La sala cerró la conexión');
 const replaced=context.keepCurrent&&state.ws&&state.ws!==socket?state.ws:null;
 state.ws=socket;
 if(replaced)dropReplacedSession(replaced);
 // What reopens this socket by itself is the call, never the swap that opened it.
 const again={browserStt:context.browserStt,sttRuntime:context.sttRuntime};
 socket.onclose=event=>{if(state.ws===socket)lostConnection(event,epoch,again)};
 socket.onmessage=e=>{if(state.ws===socket)message(e.data)};
 state.sessionId=session.session_id;state.roomRevision=0;rememberSession(state.sessionId);
 window.sidevoiceTelemetry?.noteSession?.(state.sessionId);
 if(context.browserStt)window.roomTranscription.start({socket,language:state.voicePreferences.stt_language});
 else window.roomTranscription?.stop();
 stopMeter();startMeter(session.sample_rate);await startCapture(socket,session);
 return session;
}
async function lostConnection(event,epoch,context){
 if(epoch!==connectEpoch||state.reconnecting)return;
 state.ws=null;
 window.sidevoiceTelemetry?.endCall?.('connection_lost');
 // The meter and the capture stay up on purpose: the microphone was never paused, and what it hears
 // while the socket is down is what the gap buffer keeps. Only the room's own transcription stops.
 window.roomTranscription?.stop();roomStore.patch({harness:{},turns:{}});
 cancelBrowserSpeech();state.userLive=state.botLive=false;state.pendingUserText='';state.pendingPhase='';markHistorySeen();
 if(!shouldReconnect(event)){disconnect();failJoin('La sala cerró la llamada. Vuelve a pulsar para entrar cuando esté disponible.');return}
 state.reconnecting=true;
 armGapBuffer(captureRate);
 try{
  for(let attempt=0;attempt<RECONNECT_DELAYS_MS.length;attempt++){
   joinStatus('reconnect',{detail:attempt?String(attempt+1):''});
   await new Promise(resolve=>setTimeout(resolve,RECONNECT_DELAYS_MS[attempt]));
   if(epoch!==connectEpoch)return;
   try{
    const session=await joinRoom(epoch,context);
    if(epoch!==connectEpoch||!session)return;
    await window.roomVoice.unlock();
    await refresh();await refreshPeople();
    // Once the room has said which conversation this browser is on, what it missed can go to it. It
    // arrives after any turn already finished here, which is the order the room delivers turns in.
    sendGapAudio(state.ws);
    setRoomError('');clearJoinStatus();
    return;
   }catch(e){if(epoch!==connectEpoch)return;state.ws=null}
  }
  disconnect();failJoin('La sala no volvió. Entra de nuevo cuando esté disponible.');
 }finally{state.reconnecting=false;disarmGapBuffer()}
}
/* ----- what the microphone kept hearing while the socket was down -----
 * The microphone is never paused, so while the call is reconnecting the page holds on to the PCM it
 * would have streamed and hands it to the new session as one catch-up turn. The buffer is bounded on
 * purpose: a room that never comes back must not grow this page's memory, so the oldest audio is
 * dropped and the bubble says so rather than the page quietly shortening what was said. */
const GAP_FRAME_MS=20,GAP_VOICE_PEAK=.02,GAP_MARGIN_MS=250,GAP_SLICE_SAMPLES=32768;
const gap={armed:false,rate:16000,chunks:[],samples:0,dropped:false,startedAt:0};
function armGapBuffer(rate){Object.assign(gap,{armed:true,rate:rate||16000,chunks:[],samples:0,dropped:false,startedAt:0})}
function disarmGapBuffer(){Object.assign(gap,{armed:false,chunks:[],samples:0,dropped:false,startedAt:0})}
function bufferGapAudio(data){
 if(!gap.armed)return;
 const chunk=new Int16Array(data);if(!chunk.length)return;
 const now=Date.now();
 if(!gap.chunks.length)gap.startedAt=now-Math.round(chunk.length/gap.rate*1000);
 gap.chunks.push(chunk);gap.samples+=chunk.length;
 const limit=gap.rate*GAP_BUFFER_SECONDS;
 while(gap.samples>limit){
  const oldest=gap.chunks.shift();gap.samples-=oldest.length;gap.dropped=true;
  gap.startedAt+=Math.round(oldest.length/gap.rate*1000);
 }
}
/* What of the gap is worth sending: the voiced span, with a margin so no word loses its edges.
 * Silence is not a message — a gap that only held room noise is sent as nothing at all. */
function gapSpeech(){
 if(!gap.samples)return null;
 const frame=Math.max(1,Math.round(gap.rate*GAP_FRAME_MS/1000)),pcm=new Int16Array(gap.samples);
 let offset=0;for(const chunk of gap.chunks){pcm.set(chunk,offset);offset+=chunk.length}
 let first=-1,last=-1;
 for(let start=0;start<pcm.length;start+=frame){
  let peak=0;for(let i=start;i<Math.min(start+frame,pcm.length);i++)peak=Math.max(peak,Math.abs(pcm[i])/32768);
  if(peak<GAP_VOICE_PEAK)continue;
  if(first<0)first=start;
  last=Math.min(start+frame,pcm.length);
 }
 if(first<0)return null;
 const margin=Math.round(gap.rate*GAP_MARGIN_MS/1000);
 const from=Math.max(0,first-margin),to=Math.min(pcm.length,last+margin);
 return {samples:pcm.subarray(from,to),
  // The oldest audio was already speech when it was dropped: how much came before is unknowable.
  truncated:gap.dropped&&first===0,
  startedAt:gap.startedAt+Math.round(from/gap.rate*1000)};
}
function base64Pcm(samples){
 const bytes=new Uint8Array(samples.buffer,samples.byteOffset,samples.byteLength);
 let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
 return btoa(binary);
}
/* One catch-up, in slices small enough that no frame limit between here and the room can drop it.
 * It goes as text and never as the binary microphone frames: this audio belongs to a session that
 * is gone, and the room must not be able to mistake it for someone speaking now. */
function sendGapAudio(socket){
 const speech=gapSpeech(),rate=gap.rate;
 disarmGapBuffer();
 if(!speech||!socket||socket.readyState!==WebSocket.OPEN||!state.sessionId)return 0;
 const total=Math.ceil(speech.samples.length/GAP_SLICE_SAMPLES)||1;
 for(let index=0;index<total;index++){
  const slice=speech.samples.subarray(index*GAP_SLICE_SAMPLES,(index+1)*GAP_SLICE_SAMPLES);
  socket.send(JSON.stringify({type:'voice-catchup',data:{session_id:state.sessionId,sample_rate:rate,seq:index,
   audio_base64:base64Pcm(slice),final:index===total-1,truncated:speech.truncated,started_at:speech.startedAt}}));
 }
 return total;
}
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
/* Voices are chosen the way transcription is: the provider first, then what that provider offers. A flat
 * list of models mixed Kokoro with every ElevenLabs model and had nowhere to put what belongs to the
 * provider itself — its API key, and, when the provider is this browser, where the model runs (#64). */
const VOICE_PROVIDERS={
 kokoro:{label:'Este navegador',browser:true},
 elevenlabs:{label:'ElevenLabs',key:'elevenlabs'},
};
function voiceProviders(){
 const seen=[];
 for(const model of voiceCatalog?.models||[])if(!seen.includes(model.provider||'kokoro'))seen.push(model.provider||'kokoro');
 return seen;
}
function voiceProviderLabel(id){return VOICE_PROVIDERS[id]?.label||id}
function modelsOf(provider){return (voiceCatalog?.models||[]).filter(model=>(model.provider||'kokoro')===provider)}
function selectedVoiceProvider(){return $('tts-provider')?.value||providerFor($('default-model')?.value)}
/* Where a browser voice runs, said in the same words transcription uses, and disabled when this browser
 * cannot do it. WebGPU is a property of the browser, so the answer comes from the same probe. */
function renderVoiceDevice(saved){
 const device=$('tts-device'),note=$('tts-device-note');
 if(!device)return;
 const entries=[['auto','Automático · GPU si está disponible']];
 if(sttCapabilities?.webgpu)entries.push(["webgpu","GPU · WebGPU"]);
 entries.push(['wasm','CPU · WebAssembly']);
 const wanted=saved||device.value||'auto';
 entriesFor(device,entries,entries.some(([id])=>id===wanted)?wanted:'auto');
 if(note)note.textContent=device.value==='auto'
  ?(sttCapabilities?.webgpu?'Automático usará la GPU de este navegador.':'Automático usará la CPU: este navegador no expone WebGPU.')
  :device.value==='webgpu'?'La voz se generará en la GPU. Si falla, se reintenta en CPU y se te dice.'
  :'La voz se generará en la CPU. Más lenta, pero funciona en cualquier navegador.';
}
function renderVoiceProvider(savedModel,savedVoice){
 const select=$('tts-provider');
 if(!select||!voiceCatalog)return;
 const providers=voiceProviders();
 const wanted=select.value||providerFor(savedModel||$('default-model').value);
 entriesFor(select,providers.map(id=>[id,voiceProviderLabel(id)]),providers.includes(wanted)?wanted:providers[0]);
 const provider=select.value,meta=VOICE_PROVIDERS[provider]||{};
 $('tts-browser-options').hidden=!meta.browser;
 $('elevenlabs-credential').hidden=meta.key!=='elevenlabs';
 $('prepare-model').hidden=!meta.browser;
 const models=modelsOf(provider),current=$('default-model').value;
 const keep=models.some(model=>model.id===current)?current:(models.some(model=>model.id===savedModel)?savedModel:models[0]?.id);
 entriesFor($('default-model'),models.map(model=>[model.id,model.label]),keep);
 renderVoiceDevice();
 renderDefaultVoices(savedVoice);
}

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
 const cloud=providerFor(model)==='elevenlabs';updateSpeedRange();
 $('model-status').textContent=cloud&&!elevenCredentials.configured?'Guarda una clave de ElevenLabs para cargar las voces de la cuenta.':'';
}
function stopPreview(){return roomStore.batch(()=>stopPreviewJob())}
function stopPreviewJob(){const job=state.previewJob;state.previewJob=null;if(!job)return;job.controller.abort();if(job.browser)window.roomVoice?.cancel();$('preview-audio').pause();$('preview-audio').removeAttribute('src');if(job.url)URL.revokeObjectURL(job.url);for(const item of voiceCatalog?.languages||[])$('preview-'+item.id).textContent='▶'}
async function previewVoice(language){if(!$('language-form').reportValidity())return;if(state.previewJob){stopPreview();$('preview-status').textContent='Prueba detenida';return}if(state.botLive){$('preview-status').textContent='Espera a que termine la locución antes de probar una voz.';return}const track=state.stream?.getAudioTracks()[0],choice=selectedVoice(language),job={controller:new AbortController(),track,enabled:track?.enabled};state.previewJob=job;$('preview-'+language).textContent='■';$('preview-status').textContent='Preparando muestra…';try{job.browser=true;await window.roomVoice.unlock();if(state.previewJob!==job)return;const sample=voiceCatalog.languages.find(item=>item.id===language).sample;if(choice.provider==='elevenlabs'){const audio=await post('/api/presentation/synthesis/preview',{...choice,text:sample});if(state.previewJob!==job)return;await window.roomVoice.playEncoded(audio,text=>$('preview-status').textContent=text)}else{job.browser=true;await window.roomVoice.unlock();await window.roomVoice.speak({...choice,text:sample},text=>$('preview-status').textContent=text)}if(state.previewJob===job){stopPreview();$('preview-status').textContent='Prueba terminada'}}catch(e){if(state.previewJob!==job)return;stopPreview();$('preview-status').textContent=e.name==='AbortError'?'Prueba detenida':e.message}}
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
    modelOptions:[{value:'inherit',label:'Usar por defecto'},
     ...voiceProviders().map(provider=>({label:voiceProviderLabel(provider),
      options:modelsOf(provider).map(entry=>({value:entry.id,label:entry.label}))}))],
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
 if($('tts-provider'))$('tts-provider').value=providerFor(p.default_model);
 for(const id of ['default-tts-language','stt-language']){const select=$(id),preference=p[id.replaceAll('-','_')];select.replaceChildren();const entries=id==='stt-language'?[{id:'auto',label:'Detectar automáticamente'},...voiceCatalog.languages]:voiceCatalog.languages;for(const item of entries){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;select.append(option)}select.value=preference||select.value}
 renderVoiceProvider(p.default_model,p.default_voice);renderLanguageRows();
}
$('reset-languages').onclick=()=>{stopPreview();voiceDraft={};renderLanguageRows();$('preview-status').textContent='Todos los idiomas usan los valores por defecto. Pulsa Guardar cambios para aplicarlo.'};
$('prepare-model').onclick=async()=>{if(state.activeSpeech||state.previewJob){$('model-status').textContent='Espera a que termine la voz.';return}const button=$('prepare-model');button.disabled=true;try{await window.roomVoice.unlock();await window.roomVoice.prepare({device:$('tts-device').value},text=>$('model-status').textContent=text)}catch(e){$('model-status').textContent=e.message}finally{button.disabled=false}};
// The job identity belongs to the async adapter; the store holds its observable facts.
let speechJob=null;
function cancelBrowserSpeech(){
 if(!state.activeSpeech)return;
 const speech=state.activeSpeech;speechJob=null;
 roomStore.batch(()=>{
  // Cancel before publishing silence: the engine repairs the sink before the bed can resume.
  window.roomVoice?.cancel();clearKaraoke(speech);
  roomStore.patch({activeSpeech:null,botLive:false});
  state.history=state.history.map(r=>r.segment===speechSegment(speech)?{...r,interrupted:!!speech.started}:r);
 });
 save();
 post('/api/presentation/browser-receipt',{session_id:speech.session_id,revision:speech.revision,
  utterance_id:speech.utterance_id,status:speech.started?'cancelled_playing':'cancelled_unplayed'}).catch(()=>{});
}
async function receiveBrowserSpeech(d,cloud=false){
 const receivedAt=latencyNow();
 if(d.session_id!==state.sessionId)return;
 if(d.thread_id!==targetId())await refresh();
 if(d.session_id!==state.sessionId||d.thread_id!==targetId())return;
 if(d.revision<state.roomRevision){if(!d.replay)state.turns=recordReply(state,d);return}
 state.roomRevision=d.revision;
 roomStore.batch(()=>{
  stopPreview();cancelBrowserSpeech();speechJob=d;
  roomStore.patch({activeSpeech:{...d},turns:d.replay?state.turns:recordReply(state,d)});
  add('assistant',d.text,'voice:'+d.utterance_id,d.thread_id,{history_id:d.history_id,session:d.session_id,revision:d.revision});
 });
 const receipt=status=>post('/api/presentation/browser-receipt',{session_id:d.session_id,revision:d.revision,
  utterance_id:d.utterance_id,status,...(status==='playing'?{timings_ms:browserLatency(d,receivedAt)}:{})});
 const finish=()=>roomStore.batch(()=>{clearKaraoke(d);speechJob=null;roomStore.patch({activeSpeech:null,botLive:false})});
 try{
  await window.roomVoice[cloud?'playEncoded':'speak'](d,()=>{},()=>{
   if(speechJob!==d||d.session_id!==state.sessionId)return;
   roomStore.batch(()=>{roomStore.patch({activeSpeech:{...d,started:true},botLive:true});if(d.replay)markReplay(d.history_id,'playing')});
   receipt('playing').catch(()=>{});
  },range=>{if(speechJob===d)updateKaraoke(d,range)});
  if(speechJob!==d)return
  finish();
  if(d.replay)markReplay(d.history_id,'done');
  await receipt('playback_finished');
 }catch(e){
  if(speechJob!==d)return
  finish();
  if(d.replay)markReplay(d.history_id,'cancelled');
  if(e.name!=='AbortError'){setRoomError((cloud?'Audio de ElevenLabs: ':'Voz del navegador: ')+e.message);receipt('failed').catch(()=>{})}
 }
}
function receiveServerSpeech(d){return receiveBrowserSpeech(d,true)}

$('settings-open').onclick=async()=>{try{
 const p=await loadPreferences();window.roomI18n?.setLanguage(p.ui_language||'es');state.voicePreferences=p;
 for(const key of ['stt_language','default_tts_language','tts_speed','ui_language','tts_device','audio_grace_seconds','replay_on_return_seconds'])$(key.replaceAll('_','-')).value=p[key];
 for(const key of MIC_KEYS)$(key.replaceAll('_','-')).value=p[key];
 $('presence-sound').value=(p.presence_sound??'on')==='off'?'off':'on';

 $('speed-value').textContent=Number(p.tts_speed).toFixed(2)+'×';$('settings-error').textContent='Cargando catálogos…';
 if(!$('language-settings').open)$('language-settings').showModal();
 const [catalog]=await Promise.all([api('/api/presentation/voice-catalog'),loadTranscription()]);
 voiceCatalog=catalog;const eleven=voiceCatalog.providers?.elevenlabs||{};
 populateVoiceSettings(p);renderDefaultVoices(p.default_voice);renderLanguageRows();
 await loadElevenLabs().catch(()=>{});
 $('settings-error').textContent=eleven.error||'';
}catch(e){$('settings-error').textContent=e.message;setRoomError(e.message)}};
$('tts-speed').oninput=()=>{$('speed-value').textContent=Number($('tts-speed').value).toFixed(2)+'×';if(voiceCatalog){storeLanguage();renderLanguageRows()}};
$('default-model').onchange=()=>{storeLanguage();defaultVoicesExpanded=false;expandedVoiceLanguages.clear();renderDefaultVoices();renderLanguageRows()};
$('tts-provider').onchange=()=>{storeLanguage();defaultVoicesExpanded=false;expandedVoiceLanguages.clear();renderVoiceProvider();renderLanguageRows()};
$('tts-device').onchange=()=>renderVoiceDevice($('tts-device').value);
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
 const provider=$('stt-provider').value||state.voicePreferences?.stt_provider||'browser',entry=sttProvider(provider),modelSelect=$('stt-model');
 $('stt-browser-options').hidden=provider!=='browser';$('stt-credential').hidden=provider!=='openai';
 $('stt-provider-note').textContent=entry?.note||'';
 const current=modelSelect.value,saved=state.voicePreferences?.stt_provider===provider?state.voicePreferences?.stt_model:null;
 if(provider==='browser'){
  // Processing comes first: what this browser can run decides which models are offered.
  // The browser may offer WebGPU and still fail to load Whisper on it (iPhone); that failure is remembered per device.
  const gpuFailed=!!storedPreferences().stt_gpu_failed;
  const device=$('stt-device'),savedDevice=device.value||state.voicePreferences?.stt_device||'auto',entries=[['auto','Automático']];
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
  showCredential('stt',state,'Sin clave: OpenAI no podrá transcribir');
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
 entriesFor($('stt-provider'),(sttCatalog.providers||[]).filter(provider=>provider.id!=='browser'||sttCapabilities.webgpu||sttCapabilities.wasm).map(provider=>[provider.id,provider.label]),state.voicePreferences?.stt_provider||'browser');
 $('stt-device').disabled=false;renderTranscription();
 if($('stt-provider').value==='openai')void loadTranscriptionModels('openai');
}
$('stt-provider').onchange=()=>{$('stt-model').replaceChildren();renderTranscription();if($('stt-provider').value==='openai')void loadTranscriptionModels('openai',true)};
$('stt-device').onchange=renderTranscription;$('stt-model').onchange=renderTranscription;
/* A key is saved like every other setting, with the form: no button of its own, because one field with
 * two buttons under it invites the question of which one applies what (#64). Removing it is the ✕ in
 * the field, which is the only thing that cannot wait for the form. */
async function saveCredentials(){
 const openai=$('stt-key').value.trim(),eleven=$('elevenlabs-key').value.trim();
 if(openai){
  const result=await post('/api/presentation/transcription/credential',{provider:'openai',key:openai});
  sttCredentials=result.credentials||{};$('stt-key').value='';sttRemote.openai.loaded=false;
  await loadTranscriptionModels('openai',true);
 }
 if(eleven){
  const result=await post('/api/presentation/synthesis/credential',{key:eleven});
  $('elevenlabs-key').value='';voiceCatalog=await api('/api/presentation/voice-catalog');
  elevenCredentials=result.credentials||{};await loadElevenLabs().catch(()=>{});
 }
}
$('stt-key-clear').onclick=async()=>{$('stt-key-clear').disabled=true;$('settings-error').textContent='';try{const result=await post('/api/presentation/transcription/credential',{provider:'openai',key:null});sttCredentials=result.credentials||{};const entry=sttProvider('openai');if(entry)entry.models=[];Object.assign(sttRemote.openai,{loaded:false,loading:false,error:null})}catch(e){$('settings-error').textContent=e.message}finally{renderTranscription()}};
/* A stored key shows itself where the key goes: masked, in its own field, with the four digits the room
 * returns. The line underneath is for news — checking, refused, taken from the room's environment — and
 * says nothing when there is nothing to say, instead of repeating what the field already shows (#64). */
function showCredential(field,state,missing){
 const input=$(field+'-key'),note=$(field+'-key-state'),clear=$(field+'-key-clear');
 if(input){input.value='';input.placeholder=state?.configured?'•••••••• '+(state.hint||''):missing}
 if(note)note.textContent=state?.configured&&state.source==='environment'?'Esta clave viene del entorno de la sala; no se puede quitar desde aquí.':'';
 if(clear)clear.disabled=!state?.configured||state.source==='environment';
}
async function loadElevenLabs(){const data=await api('/api/presentation/synthesis');elevenCredentials=data.credentials||{};const state=elevenCredentials;showCredential('elevenlabs',state,'Sin clave: no hay voces de ElevenLabs')}
$('elevenlabs-key-clear').onclick=async()=>{try{await post('/api/presentation/synthesis/credential',{key:null});voiceCatalog=await api('/api/presentation/voice-catalog');elevenCredentials={};renderDefaultVoices();renderLanguageRows()}catch(e){$('settings-error').textContent=e.message}finally{await loadElevenLabs()}};
$('reset-settings').onclick=async()=>{try{localStorage.removeItem(SETTINGS_KEY);localStorage.removeItem('sidevoice.mic')}catch{}voiceDraft={};await $('settings-open').onclick();$('reset-settings-note').textContent='Restablecido a los valores por defecto. Guarda para aplicarlo; la llamada en curso no se interrumpe.'};
$('settings-close').onclick=()=>{stopPreview();$('language-settings').close()};$('language-settings').addEventListener('close',stopPreview);
// What this device may set. The detector's tuning is the room's: one place to fix it for everyone.
// The only thing a device says about turn detection. The seconds behind each word are the room's, in one
// place for everyone: a device that had saved the old numbers kept them after the room changed its mind,
// and the fix never reached the person it was written for (2026-09-20).
const MIC_KEYS=['turn_patience'];
// Every setting belongs to this device. The room answers with its defaults and keeps no copy; what this browser saved wins.
const SETTINGS_KEY='sidevoice.settings';
function storedPreferences(){for(const key of [SETTINGS_KEY,'sidevoice.mic']){try{const stored=JSON.parse(localStorage.getItem(key)||'null');if(stored&&typeof stored==='object')return stored}catch{}}return {}}
function storePreferences(p){try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(p));localStorage.removeItem('sidevoice.mic')}catch{}}
async function loadPreferences(){const defaults=await api('/api/presentation/languages');return {...defaults,...storedPreferences()}}
// WebKit on the iPhone offers WebGPU and then fails while loading Whisper on it. A failed GPU load falls back to
// CPU for this call and is remembered for this device, so 'automatic' starts on CPU next time; choosing GPU explicitly still tries it.
// What this call is actually using, said small next to the controls: engine, model and processor, plus how the turn ends.


// What the output reports moves the mark: a stall is 'recovering' until something plays through; a refusal or a failure stays until the next playout succeeds.
function noteOutputHealth(kind){
 const next=kind==='stall'?'recovering':['fail','attach-refused','resume-refused','element-refused','unlock-refused','chime-failed'].includes(kind)?'failed':['complete','play-encoded'].includes(kind)?'ok':null;
 if(next&&next!==state.outputHealth){state.outputHealth=next}
}
window.addEventListener('voice-output',event=>noteOutputHealth(event.detail?.kind));
async function prepareLocalWhisper(model,device){
 const caps=sttCapabilities||(window.roomTranscription.capabilities?await window.roomTranscription.capabilities():{wasm:true});
 if(device==='auto'&&storedPreferences().stt_gpu_failed)device='wasm';
 try{return await window.roomTranscription.prepare({model,device})}
 catch(error){
  if(device==='wasm'||!caps.wasm)throw error;
  state.liveNote='La GPU no pudo cargar '+model.split('/').pop()+'; este dispositivo usa la CPU';
  storePreferences({...(state.voicePreferences||{}),stt_device:'wasm',stt_gpu_failed:true});if(state.voicePreferences)state.voicePreferences.stt_device='wasm';
  const runtime=await window.roomTranscription.prepare({model,device:'wasm'});
  return {...runtime,fallback_from:device,fallback_error:String(error?.message||error).slice(0,300)};
 }
}
// What this device runs before it can transcribe locally: the model it saved, or the best one this
// browser can actually load, with the GPU→CPU fallback and the preparation indicator behind it.
async function prepareTranscription(preferences){
 if(preferences?.stt_provider==='openai')return {browserStt:false,sttRuntime:null};
 let {stt_model:model,stt_device:device}=preferences||{};
 const caps=await window.roomTranscription.capabilities();
 if(!caps.models.includes(model)){
  const fallback=caps.models[0];
  if(!fallback)throw Error('Este navegador no puede transcribir en local; elige OpenAI en Configuración.');
  state.liveNote='Este navegador no puede con el modelo guardado; se usa '+fallback.split('/').pop();
  model=fallback;device='auto';
 }
 return {browserStt:true,sttRuntime:await prepareLocalWhisper(model,device)};
}
function micSettingsChanged(previous,next){return MIC_KEYS.some(key=>String(previous?.[key]??'')!==String(next?.[key]??''))}
function sttSettingsChanged(previous,next){return ['stt_provider','stt_model','stt_device','stt_language','stt_context'].some(key=>String(previous?.[key]??'')!==String(next?.[key]??''))}
// The room builds its pipeline once per socket, out of the hello: who transcribes, in which language
// and with what context, and how this device's turns are detected, are fixed for that call. The local
// Whisper model is not one of them — the room never runs it — unless OpenAI is the one being asked.
function pipelineSettingsChanged(previous,next){
 return micSettingsChanged(previous,next)
  ||['stt_provider','stt_language','stt_context'].some(key=>String(previous?.[key]??'')!==String(next?.[key]??''))
  ||(next?.stt_provider==='openai'&&String(previous?.stt_model??'')!==String(next?.stt_model??''));
}
// Only the model this page itself runs changed: the room's pipeline stays as it is.
function localModelSwap(previous,next){return !!state.ws&&next?.stt_provider!=='openai'&&!pipelineSettingsChanged(previous,next)&&sttSettingsChanged(previous,next)}
/* Changing the pipeline used to hang up, and a hang-up in the middle of a conversation is not a
 * setting taking effect. The page opens a second socket instead: whatever has to load (a local
 * Whisper model, its GPU→CPU fallback) loads while the call goes on over the socket it already has,
 * the new session only replaces the old one once the room has answered it, and a refusal leaves the
 * call exactly as it was — with the room's own reason for it said out loud. */
async function switchSession(previous,next){
 if(!state.ws)return false;
 // The last save wins: a swap still in flight is abandoned, never queued behind this one.
 if(state.switchingSession)abortSwitch();
 const epoch=connectEpoch,attempt=++switchEpoch;
 const step=sttSettingsChanged(previous,next)?'transcription':'mic';
 const stale=()=>epoch!==connectEpoch||attempt!==switchEpoch;
 state.switchingSession=true;joinStatus(step);
 // The two things that can fail here fail differently: a model this device cannot load, and a room
 // that refuses the new session. Each one is told the way joining already tells it.
 let phase='whisper';
 try{
  const context=await prepareTranscription(next);
  if(stale())return false;
  phase='room';joinStatus(step);
  const session=await joinRoom(epoch,{...context,keepCurrent:true});
  if(stale()||!session)return false;
  await window.roomVoice?.unlock();
  roomStore.patch({engineReady:true,enginePreferences:next,voicePreferences:next,sttRuntime:context.sttRuntime});showEchoCover();
  await refresh();await refreshPeople();
  setRoomError('');clearJoinStatus();
  return true;
 }catch(error){
  if(stale())return false;
  // Nothing was swapped: `ws` is still the socket the call was already on.
  showPreparation({phase:'hidden'});
  failJoin('No se pudo aplicar el cambio: '+joinFailureText(phase,error)+' La llamada sigue con los ajustes anteriores.');

  return false;
 }finally{if(attempt===switchEpoch)state.switchingSession=false}
}
// Cancelling the preparation abandons the swap, not the call: the old session was never touched.
function abortSwitch(){
 if(!state.switchingSession)return;
 ++switchEpoch;state.switchingSession=false;
 const opening=openingSocket;openingSocket=null;opening?.close();
 showPreparation({phase:'hidden'});clearJoinStatus();
}
async function applyTranscriptionSettings(previous,next){
 if(!state.ws)return false;
 if(pipelineSettingsChanged(previous,next))return await switchSession(previous,next)&&'switched';
 if(!localModelSwap(previous,next))return false;
 const socket=state.ws,epoch=connectEpoch;state.switchingTranscription=true;
 window.roomTranscription.stop({cancelTurn:true});
 try{
  const runtime=await prepareLocalWhisper(next.stt_model,next.stt_device);
  if(state.ws!==socket||connectEpoch!==epoch)return false;
  socket.send(JSON.stringify({type:'voice-stt-ready',data:{session_id:state.sessionId,...runtime}}));roomStore.patch({engineReady:true,enginePreferences:next,voicePreferences:next,sttRuntime:runtime});
  window.roomTranscription.start({socket,language:next.stt_language});
  return 'local';
 }finally{state.switchingTranscription=false}
}
$('language-form').onsubmit=async e=>{e.preventDefault();storeLanguage();try{await saveCredentials()}catch(error){$('settings-error').textContent=error.message;return}const previous=state.voicePreferences,p={...state.voicePreferences,tts_execution:'browser',language_overrides:voiceDraft};for(const key of ['stt_language','stt_device','default_tts_language','tts_speed','ui_language','tts_device','default_model','default_voice','audio_grace_seconds','presence_sound','replay_on_return_seconds',...MIC_KEYS]){p[key]=['tts_speed','audio_grace_seconds','presence_volume','replay_on_return_seconds'].includes(key)?Number($(key.replaceAll('_','-')).value):$(key.replaceAll('_','-')).value;if((key==='stt_device'||key==='tts_device')&&!['auto','webgpu','wasm'].includes(p[key]))p[key]=['auto','webgpu','wasm'].includes(previous?.[key])?previous[key]:'auto'}p.stt_provider=$('stt-provider').value||'browser';p.stt_model=$('stt-model').value;let hotSwap=false;try{storePreferences(p);if(state.ws&&state.ws.readyState===WebSocket.OPEN&&state.sessionId)state.ws.send(JSON.stringify({type:'voice-settings',data:{session_id:state.sessionId,settings:p}}));hotSwap=localModelSwap(previous,p);state.voicePreferences=p;window.roomI18n?.setLanguage(p.ui_language);stopPreview();$('language-settings').close();const applied=await applyTranscriptionSettings(previous,p);state.liveNote=applied==='switched'?'Preferencias guardadas · '+(sttSettingsChanged(previous,p)?'Transcripción cambiada':'Micrófono aplicado')+' sin salir de la llamada':applied?'Preferencias guardadas · Transcripción actualizada':'Preferencias guardadas'}catch(e){if(hotSwap)disconnect();if(hotSwap)setRoomError(e.message);else $("settings-error").textContent=e.message}};
window.sidevoiceActions={
 cancelInput:cancelCurrentInput,
 toggleMic,
 toggleCall,
 selectAudioDevice,
 selectParticipant(threadId){
  const participant=state.people.find(item=>item.thread_id===threadId);
  state.viewedThread=threadId;markHistorySeen();
  if(participant?.available)void select(threadId);
  updateComposer();
 },
 async closeParticipant(threadId){
  try{await post('/api/presentation/close',{thread_id:threadId})}
  catch(e){
   // The room does not know it (it was closed elsewhere, or the room restarted): only this page remembered it.
   if(!/No se encuentra/.test(e.message||'')){setRoomError(e.message);throw e}
   forgetThread(threadId)
  }
  await refresh();await refreshPeople();await refreshHistory()
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
function toggleMic(){holding=false;setMic(!(state.stream?.getAudioTracks()[0]?.enabled??state.micEnabled))}
function typing(e){return e.target instanceof Element&&!!e.target.closest('input,textarea,select,[contenteditable=true],[role=menu],[role=menuitem],[data-radix-popper-content-wrapper]')}
window.addEventListener('keydown',e=>{
 if(typing(e)||e.altKey)return;
 if(e.code==='KeyD'&&(e.metaKey||e.ctrlKey)&&!e.shiftKey){e.preventDefault();if(!e.repeat)toggleMic();return}
 if(state.stream&&e.code==='Space'&&!e.ctrlKey&&!e.metaKey&&!e.target.closest('summary')){
  e.preventDefault();
  if(spaceDown)return;
  spaceDown=true;
  if(!state.stream.getAudioTracks()[0].enabled){holding=true;setMic(true);state.holding=true}
 }
},true);
window.addEventListener('keyup',e=>{if(e.code==='Space'&&spaceDown){e.preventDefault();releaseHold()}},true);
window.addEventListener('blur',releaseHold);document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseHold()});window.addEventListener('beforeunload',()=>{state.ws?.close();state.stream?.getTracks().forEach(t=>t.stop())});loadPreferences().then(p=>window.roomI18n?.setLanguage(p.ui_language||'es')).catch(()=>{});updateMic();refresh();refreshPeople();refreshHistory();setInterval(refreshHistory,1500);setInterval(refresh,1500);setInterval(refreshPeople,6000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.ws)keepScreenAwake()});
setupAudioControls();

let lastBridge=null,lastJoin;
function publishSessionView(view = roomStore.getState()) {
    const ui = window.sidevoiceUI;
    if (ui && ui.store !== roomStore) {
        ui.setConversation?.(view.conversation);
        ui.setParticipants?.(view.participants);
        const key = JSON.stringify(view.join);
        if (ui !== lastBridge || key !== lastJoin) {
            lastBridge = ui;
            lastJoin = key;
            ui.setJoinStatus?.(view.join);
        }
    }
    // The join line has one owner: JoinStatus renders it from this same store. Writing its textContent
    // from here removed React's own children, and the next render threw NotFoundError trying to replace
    // a node that was no longer there — which unmounts the whole root and leaves the room blank (#58).
    const badge = $('engine-badge');
    if (badge) {
        badge.textContent = view.engine.text;
        badge.title = view.engine.title;
        badge.dataset.output = view.engine.output;
        badge.hidden = !view.engine.text;
    }
    const echo = view.echo, light = $('echo-cover');
    if (light) {
        light.hidden = !echo.state;
        light.dataset.state = echo.state;
        light.title = echo.note;
    }
    if ($('echo-cover-text'))
        $('echo-cover-text').textContent = echo.state ? 'Eco: ' + echo.note : '';
    if ($('echo-note'))
        $('echo-note').textContent = echo.note;
    updateComposer();
}
roomStore.subscribe(reconcileSession);
reconcileSession(roomStore.getState());
