const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
function setup({strictDOM=false}={}){
 const sourceRoot=__dirname+'/../src'; const uiSource=fs.readdirSync(sourceRoot,{recursive:true}).filter(file=>String(file).endsWith('.tsx')).map(file=>fs.readFileSync(sourceRoot+'/'+file,'utf8')).join('\n');
 class Element{constructor(){this.children=[];this.dataset={};this.style={};this.classList={add(){},remove(){}};this.parentElement=this;this.listeners={};this.attributes={}}addEventListener(name,fn){this.listeners[name]=fn}showModal(){this.open=true}close(){this.open=false;this.listeners.close?.()}contains(node){return node===this||this.children.includes(node)}removeAttribute(){}closest(){return null}querySelector(){return null}append(...children){this.children.push(...children)}replaceChildren(...children){this.children=[...children]}remove(){}setAttribute(name,value){this.attributes[name]=value}getAttribute(name){return this.attributes[name]}click(){this.onclick?.()}}
 const elements=new Map(),handlers={};
 if(strictDOM){for(const match of uiSource.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element());for(const id of ['connection-stats','stats-title','stats-close','language-settings','settings-title','settings-close','stats-endpoint','stats-response','stats-synthesis','stats-playout','default-model-info'])elements.set(id,new Element())}
 const context=vm.createContext({Element,console,Date,JSON,Math,Uint8Array,AbortController,sessionStorage:{getItem:()=>null,setItem(){}},document:{getElementById:id=>{if(!elements.has(id)){if(strictDOM)return null;elements.set(id,new Element())}return elements.get(id)},createElement:()=>new Element(),addEventListener(){}},window:{addEventListener:(name,fn)=>handlers[name]=fn,roomTranscription:{capabilities:async()=>({webgpu:false,wasm:true,models:['onnx-community/whisper-tiny','onnx-community/whisper-base']}),prepare:async({model})=>({model,device:'wasm'}),start(){},stop(){},ingest(){}}},fetch:()=>new Promise(()=>{}),setInterval(){},setTimeout,clearTimeout,cancelAnimationFrame(){},requestAnimationFrame(){},WebSocket:{OPEN:1},location:{protocol:'https:',host:'room.example'}});
 const source=fs.readFileSync(sourceRoot+'/services/room-session-controller.js','utf8');vm.runInContext(source,context);
 vm.runInContext("roomBinding={thread_id:'a',title:'A'};sessionId='s'",context);
 return {context,handlers,Element,run:code=>vm.runInContext(code,context)};
}
test('The controller publishes serializable snapshots through the React store bridge',()=>{
 const s=setup({strictDOM:true}),snapshots={};
 s.context.window.sidevoiceUI={
  setConversation:value=>snapshots.conversation=value,
  setParticipants:value=>snapshots.participants=value,
  setLanguageModels:value=>snapshots.languageModels=value,
  setBootError:value=>snapshots.bootError=value
 };
 s.run("add('assistant','Hola','voice:1','a');renderHistory();people=[{thread_id:'a',title:'Agente',available:true}];rosterSignature='';renderPeople()");
 assert.equal(snapshots.conversation.messages[0].text,'Hola');
 assert.equal(snapshots.conversation.messages[0].thread,'a');
 assert.equal(snapshots.participants[0].threadId,'a');
 assert.equal(snapshots.participants[0].selected,true);
 assert.equal(s.run("setRoomError('fallo')"),undefined);
 assert.equal(snapshots.bootError,'fallo');
 assert.equal(s.run("$('messages').children.length"),0,'React owns rendering when the bridge is installed');
});
test('The React component tree initializes without inventing missing DOM elements',()=>{
 const s=setup({strictDOM:true});
 assert.equal(s.run("$('missing-element')"),null);
 for(const id of ['connect','mute','elevenlabs-key-save','elevenlabs-key-clear','stt-key-save','stt-key-clear'])
  assert.equal(s.run("typeof $('"+id+"').onclick"),'function');
 for(const id of ['elevenlabs-credential','elevenlabs-key','elevenlabs-key-state','stt-provider','stt-credential','stt-key','stt-key-state'])
  assert.ok(s.run("$('"+id+"')"),id);
});
test('ElevenLabs credentials render against the actual HTML controls',async()=>{
 const s=setup({strictDOM:true});
 s.context.fetch=async()=>({ok:true,json:async()=>({credentials:{configured:true,source:'stored',hint:'…test'}})});
 await s.run('loadElevenLabs()');
 assert.match(s.run("$('elevenlabs-key-state').textContent"),/Clave guardada/);
 assert.equal(s.run("$('elevenlabs-key-clear').disabled"),false);
 s.context.fetch=async()=>({ok:true,json:async()=>({credentials:{configured:false,source:null,hint:null}})});
 await s.run('loadElevenLabs()');
 assert.match(s.run("$('elevenlabs-key-state').textContent"),/Sin clave/);
 assert.equal(s.run("$('elevenlabs-key-clear').disabled"),true);
});

test('STT settings expose only models supported by the detected browser runtime',()=>{
 const s=setup({strictDOM:true});
 s.run("voicePreferences={stt_provider:'browser',stt_device:'auto',stt_model:'onnx-community/whisper-small'};sttCatalog={providers:[{id:'browser',label:'Browser',models:[{id:'onnx-community/whisper-tiny',label:'Tiny',description:'light',devices:['webgpu','wasm']},{id:'onnx-community/whisper-small',label:'Small',description:'quality',devices:['webgpu']}]},{id:'openai',label:'OpenAI',default_model:'gpt-4o-transcribe',models:[{id:'gpt-4o-transcribe',label:'GPT'}]}]};sttCapabilities={webgpu:true,wasm:true,models:['onnx-community/whisper-tiny']};$('stt-provider').value='browser';renderTranscription()");
 assert.deepEqual(s.run("$('stt-model').children.map(x=>x.value)"),['onnx-community/whisper-tiny']);
 s.run("sttCapabilities.models.push('onnx-community/whisper-small');renderTranscription()");
 assert.deepEqual(s.run("$('stt-model').children.map(x=>x.value)"),['onnx-community/whisper-tiny','onnx-community/whisper-small']);
 s.run("$('stt-model').value='onnx-community/whisper-small';$('stt-model').onchange()");
 assert.equal(s.run("$('stt-model-note').textContent"),'quality');
 assert.deepEqual(s.run("$('stt-device').children.map(x=>x.value)"),['auto','webgpu']);
 s.run("$('stt-device').value='wasm';$('stt-device').onchange()");
 assert.equal(s.run("$('stt-device').value"),'auto');
 assert.deepEqual(s.run("$('stt-model').children.map(x=>x.value)"),['onnx-community/whisper-tiny','onnx-community/whisper-small']);
});

test('OpenAI remains selectable and shows its credential controls',()=>{
 const s=setup({strictDOM:true});
 s.run("voicePreferences={stt_provider:'openai',stt_model:'gpt-4o-transcribe'};sttCatalog={providers:[{id:'browser',label:'Browser',models:[]},{id:'openai',label:'OpenAI',note:'Cloud',default_model:'gpt-4o-transcribe',models:[{id:'gpt-4o-transcribe',label:'GPT'}]}]};sttCapabilities={webgpu:false,wasm:true,models:[]};sttCredentials={openai:{configured:true,source:'stored',hint:'…test'}};$('stt-provider').value='openai';renderTranscription()");
 assert.equal(s.run("$('stt-credential').hidden"),false);
 assert.equal(s.run("$('stt-browser-options').hidden"),true);
 assert.deepEqual(s.run("$('stt-model').children.map(x=>x.value)"),['gpt-4o-transcribe']);
 assert.match(s.run("$('stt-key-state').textContent"),/Clave guardada/);
});
test('OpenAI model loading never masquerades as a one-option catalogue',()=>{
 const s=setup({strictDOM:true});
 s.run("voicePreferences={stt_provider:'openai',stt_model:'gpt-4o-transcribe'};sttCatalog={providers:[{id:'openai',label:'OpenAI',default_model:'gpt-4o-transcribe',models:[],models_source:'remote'}]};sttCapabilities={webgpu:false,wasm:true,models:[]};sttCredentials={openai:{configured:true}};sttRemote.openai.loading=true;$('stt-provider').value='openai';renderTranscription()");
 assert.equal(s.run("$('stt-model').disabled"),true);
 assert.deepEqual(s.run("$('stt-model').children.map(x=>x.textContent)"),['Cargando modelos de OpenAI…']);
 assert.match(s.run("$('stt-model-note').textContent"),/Consultando/);
});
test('OpenAI models are fetched only when its provider is selected',async()=>{
 const s=setup({strictDOM:true});let requests=[];
 s.context.fetch=async path=>{requests.push(path);return {ok:true,json:async()=>({models:[{id:'gpt-4o-transcribe',label:'gpt-4o-transcribe'},{id:'gpt-4o-mini-transcribe',label:'gpt-4o-mini-transcribe'}],error:null})}};
 s.run("voicePreferences={stt_provider:'openai',stt_model:'gpt-4o-mini-transcribe'};sttCatalog={providers:[{id:'browser',label:'Browser',models:[]},{id:'openai',label:'OpenAI',default_model:'gpt-4o-transcribe',models:[],models_source:'remote'}]};sttCapabilities={webgpu:false,wasm:true,models:[]};sttCredentials={openai:{configured:true}};$('stt-provider').value='openai';renderTranscription()");
 assert.equal(requests.length,0);
 await s.run("loadTranscriptionModels('openai',true)");
 assert.equal(requests.length,1);
 assert.match(requests[0],/transcription\/models\?provider=openai/);
 assert.deepEqual(s.run("$('stt-model').children.map(x=>x.value)"),['gpt-4o-transcribe','gpt-4o-mini-transcribe']);
 assert.equal(s.run("$('stt-model').value"),'gpt-4o-mini-transcribe');
 assert.match(s.run("$('stt-model-note').textContent"),/2 modelos compatibles/);
});
test('Model descriptions stay out of labels and appear in optional tooltips',()=>{
 const s=setup({strictDOM:true});
 s.run("voiceCatalog={models:[{id:'eleven_flash_v2_5',label:'Eleven Flash v2.5',provider:'elevenlabs',description:'Rápido'}]};entriesFor($('default-model'),voiceCatalog.models.map(x=>[x.id,x.label]),'eleven_flash_v2_5');setModelInfo($('default-model-info'),'eleven_flash_v2_5')");
 assert.equal(s.run("$('default-model').children[0].textContent"),'Eleven Flash v2.5');
 assert.equal(s.run("$('default-model-info').dataset.tooltip"),'Rápido');
 assert.equal(s.run("$('default-model-info').hidden"),false);
});
test('ElevenLabs voices are filtered by primary language until all voices are requested',()=>{
 const s=setup({strictDOM:true});
 s.run(`voiceCatalog={
  models:[{id:'eleven_flash_v2_5',label:'Eleven Flash',provider:'elevenlabs'}],
  languages:[{id:'es',label:'Español',voices:[]}],
  providers:{elevenlabs:{voices:[
   {id:'lucia',label:'Lucía',languages:['es']},
   {id:'alice',label:'Alice',languages:['en']},
   {id:'mystery',label:'Sin idioma',languages:[]}
  ]}}
 };elevenCredentials={configured:true};$('tts-device').closest=()=>({hidden:false});$('default-model').value='eleven_flash_v2_5';$('default-tts-language').value='es';renderDefaultVoices('alice')`);
 assert.deepEqual(s.run("$('default-voice').children.map(x=>x.value)"),['lucia','__show_all_voices__']);
 assert.equal(s.run("$('default-voice').value"),'lucia','a stored voice from another language must not bypass the filter');
 s.run("window.sidevoiceUI={setLanguageModels(){}};$('default-voice').selectedOptions=[{textContent:'Lucía'}];$('default-voice').value=SHOW_ALL_VOICES;$('default-voice').onchange()");
 assert.deepEqual(s.run("$('default-voice').children.map(x=>x.value)"),['lucia','alice','mystery']);
});
test('Joining with ElevenLabs reaches microphone capture without loading Kokoro',async()=>{
 for(const model of ['eleven_flash_v2_5','kokoro']){
  const s=setup({strictDOM:true});let prepared=0,captured=0,unlocked=false;
  s.context.fetch=async()=>{assert.equal(unlocked,true,'audio unlock must precede network I/O');return {ok:true,json:async()=>({default_model:model,tts_device:'auto'})}};
  s.context.window.roomVoice={unlock:async()=>{unlocked=true},prepare:async()=>{prepared++},cancel(){}};
  s.context.navigator={mediaDevices:{getUserMedia:async()=>{captured++;throw Error('Microphone test boundary')}}};
  s.run("$('mute').style.setProperty=()=>{}");
  await s.run("$('connect').onclick()");
  assert.equal(captured,1,model);
  assert.equal(prepared,model==='kokoro'?1:0,model);
  assert.equal(s.run("$('error').textContent"),'Microphone test boundary');
  assert.equal(s.run('connecting'),false);
 }
});
test('A queued assistant reply never hides the active user speech bubble',()=>{
 const s=setup();const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-user-turn',{phase:'started',revision:1,thread_id:'a'});
 assert.equal(s.run("$('messages').children.at(-1).className"),'message user partial');
 emit('bot-output',{text:'Respuesta pendiente',spoken:false,segment_id:'queued'});
 assert.equal(s.run("$('messages').children.at(-1).className"),'message user partial');
 assert.match(s.run("$('messages').children.at(-1).textContent"),/Escuchando/);
});
test('TTS announcement/completion is one row; intentional repetitions remain separate',()=>{
 const s=setup();
 const emit=(spoken,id)=>s.run(`message(${JSON.stringify(JSON.stringify({type:'bot-output',data:{text:'Hola',spoken,segment_id:id,aggregated_by:'sentence'}}))})`);
 emit(false,1);emit(true,2);assert.equal(s.run('history.length'),1);
 emit(false,3);emit(true,4);assert.equal(s.run('history.length'),2);
});
test('Command D toggles and holding space restores mute on release or loss of focus',()=>{
 const s=setup();s.run("var track={enabled:true};stream={getAudioTracks:()=>[track]};ws={}");
 const key=code=>({code,metaKey:code==='KeyD',target:new s.Element(),preventDefault(){}});
 s.handlers.keydown(key('KeyD'));assert.equal(s.run('track.enabled'),false);
 s.handlers.keydown(key('Space'));assert.equal(s.run('track.enabled'),true);
 s.handlers.keyup(key('Space'));assert.equal(s.run('track.enabled'),false);
 s.handlers.keydown(key('Space'));s.handlers.blur();assert.equal(s.run('track.enabled'),false);
 s.handlers.keydown(key('KeyD'));assert.equal(s.run('track.enabled'),true);
});
test('Keyboard shortcuts ignore typing and auto-repeat',()=>{
 const s=setup();s.run("var track={enabled:true};stream={getAudioTracks:()=>[track]};ws={}");
 const target=new s.Element();target.closest=()=>({});
 s.handlers.keydown({code:'KeyD',metaKey:true,target});assert.equal(s.run('track.enabled'),true);
 s.handlers.keydown({code:'KeyD',metaKey:true,target:new s.Element(),repeat:true,preventDefault(){}});assert.equal(s.run('track.enabled'),true);
});
test('Pauses keep transcription fragments in one actual turn; the next turn stays separate',()=>{
 const s=setup();const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-user-turn',{phase:'started',revision:1,thread_id:'a'});
 emit('user-transcription',{final:true,text:'Tengo una idea.'});
 emit('user-stopped-speaking',{});emit('user-started-speaking',{});
 emit('user-transcription',{final:true,text:'Y otra cosa.'});
 assert.equal(s.run('history.length'),1);
 assert.equal(s.run('history[0].text'),'Tengo una idea. Y otra cosa.');
 emit('voice-user-turn',{phase:'finished',revision:1,thread_id:'a',text:'Tengo una idea. Y otra cosa.'});
 emit('voice-user-turn',{phase:'started',revision:2,thread_id:'a'});
 emit('user-transcription',{final:true,text:'Otro turno.'});
 assert.equal(s.run('history.length'),2);
 emit('voice-user-turn',{phase:'finished',revision:3,thread_id:'other',text:'Ajeno'});
 assert.equal(s.run('history.length'),3);
 assert.equal(s.run('history[2].thread'),'other');
 assert.equal(s.run("history.filter(x=>x.thread===historyThreadId()).length"),2);
});
test('The transcribed draft remains cancellable until the user turn finishes',()=>{
 const s=setup(),snapshots={};
 s.context.window.sidevoiceUI={setConversation:value=>snapshots.conversation=value};
 const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-user-turn',{phase:'started',revision:4,thread_id:'a'});
 emit('user-transcription',{final:true,text:'Una frase todavía abierta'});
 assert.equal(snapshots.conversation.pendingText,'');
 assert.equal(snapshots.conversation.messages[0].cancellable,true);
 emit('voice-user-turn',{phase:'finished',revision:4,thread_id:'a',text:'Una frase todavía abierta'});
 assert.equal(snapshots.conversation.messages[0].cancellable,false);
});
test('A late final transcription cannot duplicate an already finished user turn',()=>{
 const s=setup();const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-user-turn',{phase:'started',revision:1,thread_id:'a'});
 emit('voice-user-turn',{phase:'finished',revision:1,thread_id:'a',text:'Una sola burbuja'});
 emit('user-transcription',{final:true,text:'Una sola burbuja'});
 assert.equal(s.run('history.length'),1);
 assert.equal(s.run("history[0].segment"),'s:user-turn:1');
 assert.equal(s.run("history[0].text"),'Una sola burbuja');
});
test('Delivery tick is immediate, follows the matching receipt and does not imply read',()=>{
 const s=setup();const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-user-turn',{phase:'finished',revision:1,thread_id:'a',text:'Hola'});
 assert.equal(s.run('history[0].delivery'),'pending');
 emit('voice-input-receipt',{revision:1,thread_id:'other',status:'delivered'});
 assert.equal(s.run('history[0].delivery'),'pending');
 emit('voice-input-receipt',{revision:1,thread_id:'a',status:'pending'});
 assert.equal(s.run('history[0].delivery'),'pending');
 emit('voice-input-receipt',{revision:1,thread_id:'a',status:'delivered'});
 assert.equal(s.run('history[0].delivery'),'delivered');
});

test('A joined empty room selects its only listening conversation automatically',async()=>{
 const s=setup();s.run("roomBinding=null;ws={};people=[{thread_id:'only',available:true,reach:{state:'listening'}}];closedThreads=[];var chosen=null;select=async id=>{chosen=id}");
 assert.equal(await s.run('selectOnlyListeningConversation()'),true);
 assert.equal(s.run('chosen'),'only');
 s.run("people.push({thread_id:'second',available:true,reach:{state:'listening'}});chosen=null");
 assert.equal(await s.run('selectOnlyListeningConversation()'),false);
 assert.equal(s.run('chosen'),null);
});

test('A receipt arriving before the final bubble is retained instead of disappearing',()=>{
 const s=setup();const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-input-receipt',{revision:2,thread_id:'a',session_id:'s',status:'delivered'});
 emit('voice-user-turn',{phase:'finished',revision:2,thread_id:'a',session_id:'s',text:'Ya llegó'});
 assert.equal(s.run('history[0].delivery'),'delivered');
 assert.equal(s.run('inputReceipts.size'),0);
});
test('A finished turn without a selected conversation is visibly not sent',()=>{
 const s=setup();const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-user-turn',{phase:'finished',revision:3,thread_id:null,text:'Sin destino'});
 assert.equal(s.run('history[0].delivery'),'not_sent');
});

test('Space repeats and release suppress native button activation without toggling the mic',()=>{
 const s=setup();s.run("var track={enabled:false};stream={getAudioTracks:()=>[track]};ws={}");
 let prevented=0;const event=repeat=>({code:'Space',repeat,target:new s.Element(),preventDefault(){prevented++}});
 s.handlers.keydown(event(false));
 for(let i=0;i<8;i++)s.handlers.keydown(event(true));
 assert.equal(s.run('track.enabled'),true);
 s.handlers.keyup(event(false));assert.equal(s.run('track.enabled'),false);
 assert.equal(prevented,10);
 s.run('track.enabled=true');s.handlers.keydown(event(false));s.handlers.keyup(event(false));
 assert.equal(s.run('track.enabled'),true);
});

test('Preview resolves the same language voice and effective speed as the settings',()=>{
 const s=setup();s.run("voiceCatalog={languages:[{id:'en',voices:[['af_heart','Heart'],['af_bella','Bella']]}]};$('voice-en').value='inherit';$('default-voice').value='ef_dora';$('speed-en').value='0.85';$('tts-speed').value='1.5';$('tts-device').value='auto'");
 assert.equal(s.run("selectedVoice('en').speed"),0.85);
 assert.equal(s.run("selectedVoice('en').voice"),'af_heart');
 s.run("$('speed-en').value='';$('voice-en').value='af_bella'");
 assert.equal(s.run("selectedVoice('en').speed"),1.5);
 assert.equal(s.run("selectedVoice('en').voice"),'af_bella');
});


test('A delivery receipt never fabricates a typing or working indicator',()=>{
 const s=setup();s.run("add('user','Hola','user-turn:1','a');history[0].delivery='delivered';renderHistory()");
 assert.equal(s.run("$('messages').children.some(x=>x.className==='waiting-response')"),false);
});

test('Background history arrives without changing focus and has an unread badge',async()=>{
 const s=setup();s.context.fetch=async()=>({ok:true,json:async()=>({messages:[{id:'old:voice:reply',thread:'b',role:'assistant',text:'Listo B',name:'B',time:1,seq:5,status:'text_only'}]})});
 await s.run('refreshHistory()');
 assert.equal(s.run('targetId()'),'a');assert.equal(s.run("unseen('b')"),1);
 assert.equal(s.run("history[0].text"),'Listo B');
 s.run("viewedThread='b';renderHistory()");
 assert.equal(s.run("unseen('b')"),0);
 assert.equal(s.run('targetId()'),'a');
 await s.run('refreshHistory()');assert.equal(s.run('history.length'),1);
});

test('A composing message follows received replies and gets its final timestamp on send',()=>{
 const s=setup();
 s.run("history=[{thread:'a',role:'user',segment:'s:user-turn:1',text:'En curso',time:100,draft:true},{thread:'a',role:'assistant',text:'Respuesta recibida',time:200}]");
 assert.equal(s.run("orderedHistory('a')[0].role"),'assistant');
 s.run("add('user','Ya terminado','user-turn:1','a',{draft:false,time:300})");
 assert.equal(s.run("history[0].time"),300);
 assert.equal(s.run("orderedHistory('a')[0].role"),'assistant');
 assert.equal(s.run("orderedHistory('a')[1].text"),'Ya terminado');
});

test('Final messages use send timestamps, even when answering an older turn',()=>{
 const s=setup();
 s.run("history=[{thread:'a',role:'assistant',session:'s',revision:1,time:300,text:'Respuesta tardía'},{thread:'a',role:'user',session:'s',revision:2,time:200,text:'Nuevo mensaje'}]");
 assert.equal(s.run("orderedHistory('a')[0].text"),'Nuevo mensaje');
});

test('The UI distinguishes audio suppression reasons without inferring unknown ones',()=>{
 const s=setup();
 assert.equal(s.run("audioNote({audio:'text_only',audio_reason:'newer_turn'})"),'Sin audio · Empezaste otra intervención');
 assert.equal(s.run("audioNote({audio:'text_only',audio_reason:'focus_changed'})"),'Sin audio · Cambiaste de conversación');
 assert.equal(s.run("audioNote({audio:'text_only'})"),'Sin audio · Motivo no registrado');
});

test('Microphone meter measures level and peak independently and clears when muted',()=>{
 const s=setup();
 assert.equal(s.run('measureMic([0,0,0],true).value'),0);
 assert.equal(s.run('measureMic([.1,-.1],true).state'),'normal');
 assert.equal(s.run('measureMic([.85,0],true).state'),'high');
 assert.equal(s.run('measureMic([.99,0],true).state'),'clip');
 assert.equal(s.run('measureMic([.99,0],false).value'),0);
 assert.equal(s.run('measureMic([.99,0],false).state'),'quiet');
});

test('Cancelling unplayed synthesis reports it as unplayed rather than interrupted audio',()=>{
 const s=setup(),requests=[];
 s.context.fetch=async(path,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}};
 s.run("window.roomVoice={cancel(){}};activeSpeech={session_id:'s',revision:1,utterance_id:'u'};history=[{segment:'s:voice:u',thread:'a',role:'assistant',time:1,text:'Preparando'}];cancelBrowserSpeech()");
 assert.equal(requests[0].status,'cancelled_unplayed');
 assert.equal(s.run('history[0].interrupted'),false);
 s.run("activeSpeech={session_id:'s',revision:1,utterance_id:'v',started:true};cancelBrowserSpeech()");
 assert.equal(requests[1].status,'cancelled_playing');
});

test('Text submission freezes its destination and clears only the submitted draft',async()=>{
 const s=setup(),sent=[];s.context.crypto={randomUUID:()=> 'test-message'};
 s.run("ws={};$('text-message').value='Un mensaje escrito';roomBinding.binding_id='binding-a'");
 s.context.fetch=async(path,options)=>{if(options){sent.push(JSON.parse(options.body));s.run("$('text-message').value='Ya escribiendo el siguiente'");return {ok:true,json:async()=>({accepted:true})}}return {ok:true,json:async()=>({messages:[]})}};
 await s.run("$('text-composer').onsubmit({preventDefault(){}})");
 assert.equal(sent[0].thread_id,'a');assert.equal(sent[0].text,'Un mensaje escrito');
 assert.equal(s.run("$('text-message').value"),'Ya escribiendo el siguiente');
});

test('Text entry is unavailable when viewing a different inactive history',()=>{
 const s=setup();s.run("ws={};viewedThread='b';updateComposer()");
 assert.equal(s.run("$('text-send').disabled"),true);
});
test('Microphone preference can be toggled before joining',()=>{
 const s=setup();
 s.run("$('mute').click()");
 assert.equal(s.run('micEnabled'),false);
 s.run("$('mute').click()");
 assert.equal(s.run('micEnabled'),true);
});
test('Hangup releases media and cancels an in-flight connection without clearing history',()=>{
 const s=setup();
 s.run(`
 var stopped=0,closed=0;
 $('mute').style.setProperty=()=>{};
 window.roomVoice={cancel(){}};
 ws={close(){closed++}};
 stream={getTracks:()=>[{stop(){stopped++}}]};
 connecting=true;history=[{text:'keep'}];
 disconnect();
 `);
 assert.equal(s.run('stopped'),1);
 assert.equal(s.run('closed'),1);
 assert.equal(s.run('ws'),null);
 assert.equal(s.run('stream'),null);
 assert.equal(s.run('connecting'),false);
 assert.equal(s.run('connectEpoch'),1);
 assert.equal(s.run('history.length'),1);
});
test('Cancelled draft disappears and late transcription is ignored until the next turn',()=>{
 const s=setup(),emit=(data)=>s.run(`message(${JSON.stringify(JSON.stringify(data))})`);
 emit({type:'voice-user-turn',data:{phase:'started',revision:1,thread_id:'a'}});
 emit({type:'user-transcription',data:{final:true,text:'discard'}});
 emit({type:'voice-user-turn',data:{phase:'cancelled',revision:1,thread_id:'a'}});
 emit({type:'user-transcription',data:{final:true,text:'late'}});
 assert.equal(s.run('history.length'),0);
 emit({type:'voice-user-turn',data:{phase:'started',revision:2,thread_id:'a'}});
 emit({type:'user-transcription',data:{final:true,text:'keep'}});
 assert.equal(s.run('history[0].text'),'keep');
});
test('The room speaks first: the page adopts its call id and treats anything earlier as a room event',async()=>{
 const s=setup();s.context.crypto={randomUUID:()=>'ready-1'};
 const socket={sent:[],send(data){this.sent.push(data)}};
 const session=s.run('openSession')(socket);
 socket.onopen();assert.equal(JSON.parse(socket.sent[0]).type,'client-ready');
 socket.onmessage({data:JSON.stringify({type:'user-started-speaking',data:{}})});
 assert.equal(s.run('userLive'),true);
 socket.onmessage({data:JSON.stringify({type:'voice-preparation',data:{kind:'transcription',phase:'loading',title:'Preparando transcripción',text:'Descargando o cargando Whisper large-v3 en Sidevoice…'}})});
 assert.equal(s.run("$('voice-loading').open"),true);
 assert.equal(s.run("$('loading-title').textContent"),'Preparando transcripción');
 assert.match(s.run("$('loading-detail').textContent"),/large-v3/);
 socket.onmessage({data:JSON.stringify({type:'voice-preparation',data:{kind:'transcription',phase:'ready'}})});
 assert.equal(s.run("$('voice-loading').open"),false);
 socket.onmessage({data:JSON.stringify({type:'voice-session',data:{session_id:'call-1',sample_rate:16000,channels:1}})});
 assert.deepEqual(await session,{session_id:'call-1',sample_rate:16000,channels:1});
 const refused={send(){}};const rejection=s.run('openSession')(refused);refused.onclose();
 await assert.rejects(rejection,{message:'La sala rechazó la conexión'});
});
test('The call socket follows the page scheme and host',()=>{
 const s=setup();assert.equal(s.run('roomSocketUrl()'),'wss://room.example/api/presentation/ws');
});
test('Cloud speech receipts track actual playout completion',async()=>{
 const s=setup(),receipts=[];let finish;
 s.context.fetch=async(path,options)=>{receipts.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}};
 s.context.window.roomVoice={cancel(){},playEncoded(data,status,onPlaying){assert.equal(data.audio_base64,'SUQz');onPlaying();return new Promise(resolve=>finish=resolve)}};
 const playing=s.run("receiveServerSpeech({session_id:'s',thread_id:'a',revision:1,utterance_id:'cloud',text:'Hola',audio_base64:'SUQz'})");
 assert.equal(s.run('botLive'),true);assert.deepEqual(receipts.map(r=>r.status),['playing']);
 finish();await playing;
 assert.equal(s.run('botLive'),false);assert.deepEqual(receipts.map(r=>r.status),['playing','playback_finished']);
});
test('Cloud preview stays active and keeps the microphone muted until audio ends',async()=>{
 const s=setup();let finish;s.context.AbortController=AbortController;
 s.context.fetch=async()=>({ok:true,json:async()=>({audio_base64:'SUQz'})});
 s.context.window.roomVoice={unlock:async()=>{},cancel(){},playEncoded(){return new Promise(resolve=>finish=resolve)}};
 s.run("voiceCatalog={languages:[{id:'es',sample:'Hola',voices:[]}]};$('language-form').reportValidity=()=>true;$('preview-audio').pause=()=>{};var track={enabled:true};stream={getAudioTracks:()=>[track]};$('model-es').value='inherit';$('default-model').value='eleven_v3';$('voice-es').value='inherit';$('default-voice').value='custom';$('speed-es').value='';$('tts-speed').value='1'");
 const preview=s.run("previewVoice('es')");
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.run('track.enabled'),false);assert.equal(s.run('previewJob!==null'),true);
 finish();await preview;
 assert.equal(s.run('track.enabled'),true);assert.equal(s.run('previewJob'),null);
 assert.equal(s.run("$('preview-status').textContent"),'Prueba terminada');
});

test('AEC includes local playback when supported and keeps capture enabled',async()=>{
 const s=setup();let constraints,applied;
 const track={enabled:true,getCapabilities:()=>({echoCancellation:[true,false,'all']}),applyConstraints:async value=>{applied=value}};
 s.context.navigator={mediaDevices:{getUserMedia:async value=>{constraints=value;return {getAudioTracks:()=>[track]}}}};
 s.run("inputDeviceId='car-mic'");
 await s.run('acquireMicrophone()');
 assert.equal(constraints.audio.echoCancellation,true);
 assert.equal(constraints.audio.deviceId.exact,'car-mic');
 assert.equal(applied.echoCancellation.exact,'all');
 assert.equal(track.enabled,true);
 track.applyConstraints=async()=>{throw Error('Mode unavailable')};
 await s.run('acquireMicrophone()');
 assert.equal(track.enabled,true,'fallback retains the already acquired AEC stream');
});
test('Local and ElevenLabs responses preserve open mic and voice interruption',async()=>{
 for(const cloud of [false,true]){
  const s=setup();let playing,finish,cancelled=0;
  s.context.fetch=async()=>({ok:true,json:async()=>({})});
  const speech=(_options,_status,onPlaying)=>{playing=onPlaying;return new Promise(resolve=>finish=resolve)};
  s.context.window.roomVoice={speak:speech,playEncoded:speech,cancel(){cancelled++}};
  s.run("var track={enabled:true};stream={getAudioTracks:()=>[track]};ws={}");
  const pending=s.run("receiveBrowserSpeech({session_id:'s',thread_id:'a',revision:1,utterance_id:'u',text:'Hola'},"+cloud+")");
  playing();
  assert.equal(s.run('track.enabled'),true);
  s.run('message(JSON.stringify({type:"user-started-speaking"}))');
  assert.equal(cancelled,1);assert.equal(s.run('activeSpeech'),null);
  finish();await pending;
 }
});
test('Wake lock is released if hangup wins the pending request',async()=>{
 const s=setup();let grant,requests=0,released=0;
 s.context.navigator={wakeLock:{request:()=>{requests++;return new Promise(resolve=>grant=resolve)}}};
 s.run('ws={}');
 const pending=s.run('keepScreenAwake()');
 await s.run('keepScreenAwake()');
 assert.equal(requests,1);
 s.run('ws=null;releaseScreenWakeLock()');
 grant({release:async()=>{released++},addEventListener(){}});
 await pending;
 assert.equal(released,1);assert.equal(s.run('screenWakeLock'),null);
});
test('Failed and cancelled microphone changes preserve or release the right stream',async()=>{
 const s=setup();let resolve,stopped=0;
 s.run("ws={};captureNode={};stream={getAudioTracks:()=>[{enabled:true}]}");
 s.context.navigator={mediaDevices:{getUserMedia:async()=>{throw Error('Permission denied')}}};
 await assert.rejects(s.run("replaceMicrophone('other')"),/Permission denied/);
 assert.equal(s.run('inputDeviceId'),'default');assert.ok(s.run('stream'));
 s.context.navigator.mediaDevices.getUserMedia=()=>new Promise(r=>resolve=r);
 const pending=s.run("replaceMicrophone('other')");
 s.run('ws=null;connectEpoch++');
 resolve({getAudioTracks:()=>[{}],getTracks:()=>[{stop(){stopped++}}]});
 await pending;assert.equal(stopped,1);assert.equal(s.run('inputDeviceId'),'default');
});
test('Preview uses ElevenLabs native speed limits while Kokoro retains its range',()=>{
 const s=setup();
 assert.equal(s.run("effectiveSpeed('eleven_flash_v2_5',1.5)"),1.2);
 assert.equal(s.run("effectiveSpeed('eleven_flash_v2_5',.5)"),.7);
 assert.equal(s.run("effectiveSpeed('kokoro',1.5)"),1.5);
});

test('Capture shares the playback context and hangup only disconnects the microphone graph',async()=>{
 const s=setup();let closed=0,ingested=0,nodeOptions;
 const source={connect(){},disconnect(){}};
 const context={state:'running',createAnalyser:()=>({getFloatTimeDomainData(data){data.fill(0)},disconnect(){}}),createMediaStreamSource:()=>source,audioWorklet:{addModule:async()=>{}},close:async()=>{closed++}};
 s.context.window.roomVoice={context};s.context.window.roomTranscription.ingest=()=>{ingested++};
 s.context.AudioWorkletNode=class{constructor(_context,_name,options){nodeOptions=options;this.port={}}connect(){}disconnect(){}};
 s.run("$('mute').style.setProperty=()=>{};stream={getAudioTracks:()=>[{enabled:true}]};ws={readyState:1,send(){}}");
 s.run('ws').send=()=>{throw Error('raw PCM must not be sent')};
 s.run('startMeter(16000)');
 assert.equal(s.run('audioContext'),context);
 await s.run('startCapture(ws,{sample_rate:16000})');
 const node=s.run('captureNode');
 node.port.onmessage({data:new ArrayBuffer(640)});
 assert.equal(ingested,1);assert.equal(nodeOptions.processorOptions.sampleRate,16000);
 s.run('stopMeter()');
 node.port.onmessage({data:new ArrayBuffer(640)});
 assert.equal(ingested,1);assert.equal(closed,0);
});

test('Latency uses browser monotonic durations and original reply revision',()=>{
 const s=setup();let now=100;s.context.performance={now:()=>now};
 s.run("observeLatencyEvent('voice-user-turn',{phase:'started',thread_id:'a',revision:1})");
 now=200;s.run("observeLatencyEvent('user-stopped-speaking',{})");
 now=2700;s.run("observeLatencyEvent('voice-user-turn',{phase:'finished',thread_id:'a',revision:1})");
 now=4000;
 const metrics=s.run("browserLatency({thread_id:'a',revision:2,reply_revision:1},3900)");
 assert.equal(metrics.audio_received_to_playback_scheduled_ms,100);
 assert.equal(metrics.turn_finished_event_to_playback_scheduled_ms,1300);
 assert.equal(metrics.vad_stop_event_to_turn_finished_event_ms,2500);
 assert.equal(s.run("browserLatency({thread_id:'other',revision:1},3900).turn_finished_event_to_playback_scheduled_ms"),undefined);
 s.run("sessionId='new-session'");
 assert.equal(s.run("browserLatency({thread_id:'a',revision:1},3900).turn_finished_event_to_playback_scheduled_ms"),undefined);
});
test('Latency turn storage is bounded and absent clocks produce no fake zeros',()=>{
 const s=setup();assert.equal(Object.keys(s.run("browserLatency({thread_id:'a',revision:1},0)")).length,0);
 s.context.performance={now:()=>100};
 s.run("for(let r=0;r<150;r++)observeLatencyEvent('voice-user-turn',{phase:'finished',thread_id:'a',revision:r})");
 assert.equal(s.run('latencyTurns.size'),128);
});
test('Playing receipts carry only measured browser durations without delaying playback',async()=>{
 const s=setup();let now=100,playing,finish;const receipts=[];
 s.context.performance={now:()=>now};
 s.context.fetch=async(path,opts)=>{receipts.push(JSON.parse(opts.body));return {ok:true,json:async()=>({})}};
 s.context.window.roomVoice={cancel(){},playEncoded:(_d,_status,onPlaying)=>{playing=onPlaying;return new Promise(r=>finish=r)}};
 const pending=s.run("receiveBrowserSpeech({session_id:'s',thread_id:'a',revision:1,utterance_id:'u',text:'Hola'},true)");
 now=175;playing();finish();await pending;
 const receipt=receipts.find(r=>r.status==='playing');
 assert.equal(receipt.timings_ms.audio_received_to_playback_scheduled_ms,75);
 assert.equal(receipts.find(r=>r.status==='playback_finished').timings_ms,undefined);
});

test('Assistant text moves from pending to playing to complete with browser playout',async()=>{
 const s=setup();let playing,finish;
 s.context.fetch=async()=>({ok:true,json:async()=>({})});
 s.context.window.roomVoice={cancel(){},speak:(_d,_status,onPlaying)=>{playing=onPlaying;return new Promise(resolve=>finish=resolve)}};
 const pending=s.run("receiveBrowserSpeech({session_id:'s',thread_id:'a',revision:1,utterance_id:'u',text:'Hola mundo'})");
 assert.equal(s.run("karaokeNodes.get('s:voice:u').node.dataset.playback"),'pending');
 playing();
 assert.equal(s.run("karaokeNodes.get('s:voice:u').node.dataset.playback"),'playing');
 finish();await pending;
 assert.equal(s.run("karaokeNodes.get('s:voice:u').node.dataset.playback"),'complete');
});
test('Karaoke preserves full text, survives history redraw and clears when interrupted',()=>{
 const s=setup();
 s.run("var speech={session_id:'s',utterance_id:'u'};activeSpeech=speech;add('assistant','Hola <mundo>','voice:u','a');updateKaraoke(speech,{from:5,to:12,mode:'word'})");
 let saved=s.run("karaokeNodes.get('s:voice:u')");
 assert.equal(saved.node.children.map(n=>n.textContent).join(''),'Hola <mundo>');
 assert.equal(saved.node.children[1].textContent,'<mundo>');
 assert.equal(saved.node.children[1].className,'karaoke-current');
 s.run('renderHistory()');
 saved=s.run("karaokeNodes.get('s:voice:u')");
 assert.equal(saved.node.children[1].textContent,'<mundo>');
 s.run("window.roomVoice={cancel(){}};cancelBrowserSpeech()");
 assert.equal(s.run('karaokeState'),null);
 s.run("updateKaraoke(speech,{from:0,to:4,mode:'word'})");
 assert.equal(s.run('karaokeState'),null);
 assert.equal(s.run('history[0].text'),'Hola <mundo>');
});

test('Meet split control opens devices independently of mute and exposes settings',()=>{
 const s=setup({strictDOM:true});s.run("$('audio-device-panel').hidden=true");
 s.run("$('audio-devices').click()");
 assert.equal(s.run("$('audio-device-panel').hidden"),false);
 assert.equal(s.run("$('audio-devices').getAttribute('aria-expanded')"),'true');
 assert.equal(s.run('micEnabled'),true);
 s.run("$('audio-devices').click()");
 assert.equal(s.run("$('audio-device-panel').hidden"),true);
 s.run("var settingsOpened=0;$('settings-open').onclick=()=>settingsOpened++;$('audio-settings-open').click();$('call-settings-open').click()");
 assert.equal(s.run('settingsOpened'),2);
});
test('Stats omit missing durations and use first reply per turn, only for selected thread',()=>{
 const s=setup({strictDOM:true});
 s.run(`renderLatencyStats({replies:[
 {thread_id:'a',reply_revision:1,status:'completed',input_ms:{speech_end_to_transcript_ms:2490,endpoint_silence_ms:2000,recognition_ms:450},server_ms:{input_queued_to_reply_received_ms:4000},provider_ms:{request_to_complete_ms:300},browser_ms:{audio_received_to_playback_scheduled_ms:50}},
 {thread_id:'a',reply_revision:1,status:'completed',server_ms:{input_queued_to_reply_received_ms:8000},provider_ms:{request_to_complete_ms:500}},
 {thread_id:'a',reply_revision:2,status:'failed',server_ms:{input_queued_to_reply_received_ms:6000}},
 {thread_id:'other',reply_revision:3,server_ms:{input_queued_to_reply_received_ms:100000}}
 ]},'a')`);
 assert.equal(s.run("$('stats-endpoint').textContent"),'2.49 s');
 assert.equal(s.run("$('stats-response').textContent"),'5.00 s');
 assert.equal(s.run("$('stats-synthesis').textContent"),'400 ms');
 assert.equal(s.run("$('stats-playout').textContent"),'50 ms');
 assert.equal(s.run("$('stats-rows').children.length"),3);
 assert.equal(s.run("$('stats-rows').children[0].children[6].textContent"),'—');
 for(const value of ['null','undefined','NaN','Infinity','-1','true',"'10'"])
  assert.equal(s.run('statsDuration('+value+')'),'—');
 assert.equal(s.run('statsDuration(0)'),'0 ms');
});
test('Stats modal polls only while open and rejects results from an earlier opening',async()=>{
 const s=setup({strictDOM:true});let polls=0;const pending=[];
 s.context.setTimeout=()=>1;s.context.clearTimeout=()=>{};
 s.context.fetch=(path,options)=>new Promise(resolve=>{polls++;pending.push({path,options,resolve})});
 const first=s.run('openConnectionStats()');
 assert.equal(polls,2);
 await s.run('refreshConnectionStats()');assert.equal(polls,2);
 s.run("$('connection-stats').close()");
 assert.equal(pending[0].options.signal.aborted,true);
 const second=s.run('openConnectionStats()');assert.equal(polls,4);
 const response=(session,duration)=>({session_id:session,replies:[{thread_id:'a',reply_revision:1,server_ms:{input_queued_to_reply_received_ms:duration}}]});
 pending[2].resolve({ok:true,json:async()=>({call:{id:'s'}})});
 pending[3].resolve({ok:true,json:async()=>response('s',1200)});
 await second;assert.equal(s.run("$('stats-response').textContent"),'1.20 s');
 pending[0].resolve({ok:true,json:async()=>({call:{id:'s'}})});
 pending[1].resolve({ok:true,json:async()=>response('s',99000)});
 await first;assert.equal(s.run("$('stats-response').textContent"),'1.20 s');
 s.run("$('connection-stats').close()");await s.run('refreshConnectionStats()');assert.equal(polls,4);
});
test('Stats handle old servers, network failures and other call sessions without fake data',async()=>{
 for(const mode of ['old','offline','other']){
  const s=setup({strictDOM:true});s.context.setTimeout=()=>1;s.context.clearTimeout=()=>{};
  s.context.fetch=async path=>{
   if(mode==='offline')throw Error('Offline');
   if(path.endsWith('/latency'))return {ok:mode!=='old',status:mode==='old'?404:200,json:async()=>({session_id:'other',replies:[{thread_id:'a',reply_revision:1,server_ms:{input_queued_to_reply_received_ms:10}}]})};
   return {ok:true,json:async()=>({call:{id:'other'}})};
  };
  await s.run('openConnectionStats()');
  assert.equal(s.run("$('stats-response').textContent"),'—');
  assert.equal(s.run("$('stats-rows').children.length"),0);
  assert.match(s.run("$('stats-status').textContent"),mode==='old'?/reiniciarlo/:mode==='offline'?/reintentará/:/Esperando/);
  s.run("$('connection-stats').close()");
 }
});
test('Stats renders device and session values as text and does not mislabel HTTP as audio latency',()=>{
 const s=setup({strictDOM:true});
 s.run(`ws={readyState:1};stream={getAudioTracks:()=>[{label:'<img onerror=boom>',readyState:'live',enabled:true,getSettings:()=>({echoCancellation:true,noiseSuppression:false,sampleRate:48000})}]};renderConnectionStats({call:{id:'s',transcription:{provider:'local',model:'turbo',reason:'openai_without_key',engine:'faster-whisper',location:'local',device:'cpu',compute_type:'int8'},mic:{frames:20,bytes:1024,last_gap_ms:20,max_gap_ms:610,gaps_over_250ms:2}}},36)`);
 const values=s.run("$('stats-connection').children.map(n=>n.textContent)");
 assert.ok(values.includes('<img onerror=boom>'));assert.ok(values.includes('Consulta al servidor (HTTP)'));
 assert.ok(values.includes('36 ms'));assert.ok(values.includes('48000 Hz'));assert.ok(values.includes('610 ms'));assert.ok(values.includes('2'));assert.ok(values.includes('Misma sesión'));
 assert.ok(values.includes('local · turbo'));assert.ok(values.includes('faster-whisper'));assert.ok(values.includes('cpu · int8'));
 assert.ok(values.includes('OpenAI solicitado sin clave · fallback local'));
});

test('Changed STT settings hot-swap the active browser runtime',async()=>{
 const s=setup({strictDOM:true});
 s.run(`
  var actions=[];
  ws={readyState:1,sent:[],send(value){this.sent.push(JSON.parse(value))}};
  sessionId='call-1';connectEpoch=7;
  window.roomTranscription={
   stop(options){actions.push(['stop',options.cancelTurn])},
   prepare:async options=>{actions.push(['prepare',options.model,options.device]);return {model:options.model,device:'webgpu'}},
   start(options){actions.push(['start',options.language,options.silenceSeconds])}
  };
 `);
 const previous={stt_model:'tiny',stt_device:'wasm',stt_language:'auto',user_speech_timeout:2.5};
 const next={stt_model:'small',stt_device:'webgpu',stt_language:'es',user_speech_timeout:3};
 assert.equal(await s.run('applyTranscriptionSettings('+JSON.stringify(previous)+','+JSON.stringify(next)+')'),true);
 assert.equal(JSON.stringify(s.run('actions')),JSON.stringify([['stop',true],['prepare','small','webgpu'],['start','es',3]]));
 assert.equal(s.run('ws.sent[0].type'),'voice-stt-ready');
 assert.equal(s.run('ws.sent[0].data.model'),'small');
 assert.equal(s.run('ws.sent[0].data.session_id'),'call-1');
 assert.equal(await s.run('applyTranscriptionSettings('+JSON.stringify(next)+','+JSON.stringify(next)+')'),false);
 assert.equal(s.run('actions.length'),3);
});
