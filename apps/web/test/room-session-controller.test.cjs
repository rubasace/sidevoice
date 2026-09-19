const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
function setup({strictDOM=false}={}){
 const sourceRoot=__dirname+'/../src'; const uiSource=fs.readdirSync(sourceRoot,{recursive:true}).filter(file=>String(file).endsWith('.tsx')).map(file=>fs.readFileSync(sourceRoot+'/'+file,'utf8')).join('\n');
 class Element{constructor(){this.children=[];this.dataset={};this.style={setProperty(){}};this.classList={add(){},remove(){}};this.parentElement=this;this.listeners={};this.attributes={}}addEventListener(name,fn){this.listeners[name]=fn}showModal(){this.open=true}close(){this.open=false;this.listeners.close?.()}contains(node){return node===this||this.children.includes(node)}removeAttribute(){}closest(){return null}querySelector(){return null}append(...children){this.children.push(...children)}replaceChildren(...children){this.children=[...children]}remove(){}setAttribute(name,value){this.attributes[name]=value}getAttribute(name){return this.attributes[name]}click(){this.onclick?.()}}
 const elements=new Map(),handlers={};
 if(strictDOM){for(const match of uiSource.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element());for(const id of ['connection-stats','stats-title','stats-close','language-settings','settings-title','settings-close','stats-endpoint','stats-response','stats-synthesis','stats-playout','default-model-info','stt-model-info'])elements.set(id,new Element())}
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

test('Processing comes first and decides which local models are offered',()=>{
 const s=setup({strictDOM:true});
 s.run("voicePreferences={stt_provider:'browser',stt_device:'auto',stt_model:'onnx-community/whisper-small'};sttCatalog={providers:[{id:'browser',label:'Browser',models:[{id:'onnx-community/whisper-tiny',label:'Tiny',description:'light',devices:['webgpu','wasm']},{id:'onnx-community/whisper-small',label:'Small',description:'quality',devices:['webgpu']}]},{id:'openai',label:'OpenAI',default_model:'gpt-4o-transcribe',models:[{id:'gpt-4o-transcribe',label:'GPT'}]}]};sttCapabilities={webgpu:true,wasm:true,models:['onnx-community/whisper-tiny','onnx-community/whisper-small']};$('stt-provider').value='browser';renderTranscription()");
 assert.deepEqual(s.run("$('stt-device').children.map(x=>x.value)"),['auto','webgpu','wasm']);
 assert.match(s.run("$('stt-device-note').textContent"),/usará la GPU/);
 assert.equal(JSON.stringify(s.run("$('stt-model').children.map(x=>[x.value,!!x.disabled])")),JSON.stringify([['onnx-community/whisper-tiny',false],['onnx-community/whisper-small',false]]));
 assert.equal(s.run("$('stt-model').value"),'onnx-community/whisper-small');
 assert.equal(s.run("$('stt-model-info').dataset.tooltip"),'quality');
 s.run("$('stt-device').value='wasm';$('stt-device').onchange()");
 assert.equal(JSON.stringify(s.run("$('stt-model').children.map(x=>[x.textContent,!!x.disabled])")),JSON.stringify([['Tiny',false],['Small · requiere GPU',true]]));
 assert.equal(s.run("$('stt-model').value"),'onnx-community/whisper-tiny','a model the processing cannot run is never left selected');
 s.run("sttCapabilities={webgpu:false,wasm:true,models:['onnx-community/whisper-tiny']};$('stt-device').value='auto';renderTranscription()");
 assert.deepEqual(s.run("$('stt-device').children.map(x=>x.value)"),['auto','wasm']);
 assert.match(s.run("$('stt-device-note').textContent"),/no está disponible/);
 assert.equal(JSON.stringify(s.run("$('stt-model').children.map(x=>[x.textContent,!!x.disabled])")),JSON.stringify([['Tiny',false],['Small · requiere GPU',true]]));

 // A GPU that already failed to load Whisper here makes automatic mean CPU, and says so.
 s.context.localStorage={getItem:key=>key==='sidevoice.settings'?JSON.stringify({stt_gpu_failed:true}):null,setItem(){},removeItem(){}};
 s.run("sttCapabilities={webgpu:true,wasm:true,models:['onnx-community/whisper-tiny','onnx-community/whisper-small']};$('stt-device').value='auto';renderTranscription()");
 assert.match(s.run("$('stt-device-note').textContent"),/no pudo cargar Whisper/);
 assert.match(s.run("$('stt-device').children[1].textContent"),/falló/);
 assert.equal(JSON.stringify(s.run("$('stt-model').children.map(x=>!!x.disabled)")),JSON.stringify([false,true]));
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
 assert.equal(s.run("$('stt-model-note').textContent"),'');
 assert.match(s.run("$('stt-model-info').dataset.tooltip"),/2 modelos compatibles/);
});
test('Model descriptions stay out of labels and appear in optional tooltips',()=>{
 const s=setup({strictDOM:true});
 s.run("voiceCatalog={models:[{id:'eleven_flash_v2_5',label:'Eleven Flash v2.5',provider:'elevenlabs',description:'Rápido'}]};entriesFor($('default-model'),voiceCatalog.models.map(x=>[x.id,x.label]),'eleven_flash_v2_5');setModelInfo($('default-model-info','stt-model-info'),'eleven_flash_v2_5')");
 assert.equal(s.run("$('default-model').children[0].textContent"),'Eleven Flash v2.5');
 assert.equal(s.run("$('default-model-info','stt-model-info').dataset.tooltip"),'Rápido');
 assert.equal(s.run("$('default-model-info','stt-model-info').hidden"),false);
});
test('ElevenLabs voices are filtered by primary language until all voices are requested',()=>{
 const s=setup({strictDOM:true});
 s.run(`voiceCatalog={
  models:[{id:'eleven_flash_v2_5',label:'Eleven Flash',provider:'elevenlabs'}],
  languages:[{id:'es',label:'Español',voices:[]}],
  providers:{elevenlabs:{voices:[
   {id:'lucia',label:'Lucía · premade',languages:['es']},
   {id:'alice',label:'Alice',languages:['en']},
   {id:'mystery',label:'Sin idioma',languages:[]}
  ]}}
 };elevenCredentials={configured:true};$('tts-device').closest=()=>({hidden:false});$('default-model').value='eleven_flash_v2_5';$('default-tts-language').value='es';renderDefaultVoices('alice')`);
 assert.deepEqual(s.run("$('default-voice').children.map(x=>x.value)"),['lucia','__show_all_voices__']);
 assert.equal(s.run("$('default-voice').children[0].textContent"),'Lucía');
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
  assert.match(s.run("$('join-status').textContent"),/No se pudo abrir el micrófono: Microphone test boundary/,model);
  assert.equal(s.run("$('join-status').dataset.state"),'failed');
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
test('The tap that starts the call asks for the lock, before there is a socket',async()=>{
 const s=setup();let requests=0;
 s.context.navigator={wakeLock:{request:async()=>{requests++;return {release:async()=>{},addEventListener(){}}}}};
 s.run('connecting=true');
 await s.run('keepScreenAwake()');
 assert.equal(requests,1,'a lock asked for while connecting keeps the gesture Safari needs');
 assert.equal(s.run("$('screen-lock').hidden"),false);
 assert.equal(s.run("$('screen-lock').dataset.state"),'on');
});
test('A refused lock shows red and says so, instead of failing silently',async()=>{
 const s=setup();
 s.context.navigator={wakeLock:{request:async()=>{throw Error('NotAllowedError')}}};
 s.run('ws={}');
 await s.run('keepScreenAwake()');
 assert.equal(s.run("$('screen-lock').dataset.state"),'off');
 assert.match(s.run("$('screen-lock-text').textContent"),/No se pudo/);
});
test('A lock the system takes back is asked for again while the call is up, and not after it ends',async()=>{
 const s=setup();let requests=0,release=null;const scheduled=[];
 s.context.setTimeout=fn=>{scheduled.push(fn);return 0};
 s.context.navigator={wakeLock:{request:async()=>{requests++;return {release:async()=>{},addEventListener:(name,fn)=>{if(name==='release')release=fn}}}}};
 s.run('ws={}');
 await s.run('keepScreenAwake()');
 assert.equal(requests,1);
 release();
 assert.equal(s.run("$('screen-lock').dataset.state"),'off');
 assert.equal(scheduled.length,1,'the retry waits rather than spinning');
 await scheduled.pop()();
 assert.equal(requests,2);
 s.run('ws=null');
 release();
 assert.equal(scheduled.length,0,'a call that ended does not keep the screen awake');
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

test('Capture shares the playback context, streams PCM to the room, and hangup only disconnects the microphone graph',async()=>{
 const s=setup();let closed=0,sentFrames=0,nodeOptions;
 const source={connect(){},disconnect(){}};
 const context={state:'running',createAnalyser:()=>({getFloatTimeDomainData(data){data.fill(0)},disconnect(){}}),createMediaStreamSource:()=>source,audioWorklet:{addModule:async()=>{}},close:async()=>{closed++}};
 s.context.window.roomVoice={context};
 s.context.AudioWorkletNode=class{constructor(_context,_name,options){nodeOptions=options;this.port={}}connect(){}disconnect(){}};
 s.run("$('mute').style.setProperty=()=>{};stream={getAudioTracks:()=>[{enabled:true}]};ws={readyState:1,send(){}}");
 s.run('ws').send=frame=>{if(typeof frame==='string'||frame?.byteLength!==640)throw Error('the room expects raw PCM frames');sentFrames++};
 s.run('startMeter(16000)');
 assert.equal(s.run('audioContext'),context);
 await s.run('startCapture(ws,{sample_rate:16000})');
 const node=s.run('captureNode');
 node.port.onmessage({data:new ArrayBuffer(640)});
 assert.equal(sentFrames,1);assert.equal(nodeOptions.processorOptions.sampleRate,16000);
 s.run('stopMeter()');
 node.port.onmessage({data:new ArrayBuffer(640)});
 assert.equal(sentFrames,1);assert.equal(closed,0);
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
 assert.equal(saved.node.children[0].textContent,'Hola <mundo>');
 assert.equal(saved.node.children[0].className,'karaoke-played');
 assert.equal(saved.node.children[1].className,'karaoke-upcoming');
 s.run('renderHistory()');
 saved=s.run("karaokeNodes.get('s:voice:u')");
 assert.equal(saved.node.children[0].textContent,'Hola <mundo>');
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
   if(path.includes('/latency'))return {ok:mode!=='old',status:mode==='old'?404:200,json:async()=>({session_id:'other',replies:[{thread_id:'a',reply_revision:1,server_ms:{input_queued_to_reply_received_ms:10}}]})};
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

test('Changing only the local Whisper model swaps it on the socket the call already has',async()=>{
 const s=setup({strictDOM:true});
 s.run(`
  var actions=[];
  ws={readyState:1,sent:[],send(value){this.sent.push(JSON.parse(value))}};
  sessionId='call-1';connectEpoch=7;
  window.roomTranscription={
   stop(options){actions.push(['stop',options.cancelTurn])},
   prepare:async options=>{actions.push(['prepare',options.model,options.device]);return {model:options.model,device:'webgpu'}},
   start(options){actions.push(['start',options.language])}
  };
 `);
 // The room never runs this model, so its pipeline does not change: no second socket, no reconnection.
 const previous={stt_provider:'browser',stt_model:'tiny',stt_device:'wasm',stt_language:'es'};
 const next={stt_provider:'browser',stt_model:'small',stt_device:'webgpu',stt_language:'es'};
 assert.equal(await s.run('applyTranscriptionSettings('+JSON.stringify(previous)+','+JSON.stringify(next)+')'),'local');
 assert.equal(JSON.stringify(s.run('actions')),JSON.stringify([['stop',true],['prepare','small','webgpu'],['start','es']]));
 assert.equal(s.run('ws.sent[0].type'),'voice-stt-ready');
 assert.equal(s.run('ws.sent[0].data.model'),'small');
 assert.equal(s.run('ws.sent[0].data.session_id'),'call-1');
 assert.equal(await s.run('applyTranscriptionSettings('+JSON.stringify(next)+','+JSON.stringify(next)+')'),false);
 assert.equal(s.run('actions.length'),3);
 // What the room does own is a new pipeline every time, and the local model alone never is.
 assert.equal(s.run('pipelineSettingsChanged('+JSON.stringify(previous)+','+JSON.stringify(next)+')'),false);
 for(const change of [{stt_provider:'openai'},{stt_language:'auto'},{stt_context:'Sidevoice'},{turn_end_mode:'timer'},{vad_confidence:0.8},{user_speech_timeout:4}])
  assert.equal(s.run('pipelineSettingsChanged('+JSON.stringify(previous)+','+JSON.stringify({...previous,...change})+')'),true,JSON.stringify(change));
 // Voices, speed and grace travel live over the socket: they must never open a second one.
 for(const change of [{default_model:'eleven_flash_v2_5'},{spanish_voice:'em_alex'},{tts_speed:1.2},{audio_grace_seconds:4}]){
  assert.equal(s.run('pipelineSettingsChanged('+JSON.stringify(previous)+','+JSON.stringify({...previous,...change})+')'),false,JSON.stringify(change));
  assert.equal(await s.run('applyTranscriptionSettings('+JSON.stringify(previous)+','+JSON.stringify({...previous,...change})+')'),false);
 }
 assert.equal(s.run('actions.length'),3,'nothing was prepared or restarted for a voice change');
});

/* A pipeline change (who transcribes, in what language, how the turn ends) used to hang up. Now the
 * page opens a second socket while the first one is still carrying the call. */
function switching(){
 const s=setup();const sockets=[],errors=[];
 s.context.WebSocket=class{
  constructor(url){this.url=url;this.readyState=0;this.sent=[];this.closed=false;sockets.push(this)}
  send(value){this.sent.push(value)}
  close(){this.closed=true;this.readyState=3;this.onclose?.({code:1000})}
 };
 s.context.WebSocket.OPEN=1;
 // The join line is where a swap says which step it is on, and where its failure lands.
 const status=[];
 s.context.window.sidevoiceUI=new Proxy({},{get:(target,name)=>name==='setJoinStatus'?value=>status.push(value):()=>{}});
 s.context.crypto={randomUUID:()=>'hello-id'};
 s.context.fetch=async()=>({ok:true,json:async()=>({binding:null,room:{revision:0},clients:[],call:null,participants:[]})});
 s.context.sessionStorage={getItem:()=>'t-1',setItem(){},removeItem(){}};
 s.run(`
  var prepared=[],started=[],stopped=0;
  startMeter=()=>{};stopMeter=()=>{};startCapture=async()=>{};keepScreenAwake=()=>{};
  window.roomVoice={unlock:async()=>{},cancel(){},context:{state:'running'}};
  window.roomTranscription={
   capabilities:async()=>({webgpu:false,wasm:true,models:['onnx-community/whisper-tiny']}),
   prepare:async options=>{prepared.push(options.model);return {model:options.model,device:'wasm'}},
   start(options){started.push(options.language)},stop(){stopped++}
  };
  stream={getAudioTracks:()=>[{enabled:true}]};
  ws=new WebSocket('wss://room.example/old');ws.readyState=1;sessionId='old-session';
 `);
 return {s,sockets,old:sockets[0],status};
}
const OLD_SETTINGS={stt_provider:'browser',stt_model:'onnx-community/whisper-tiny',stt_device:'auto',stt_language:'es',stt_context:'',turn_end_mode:'smart_turn'};
function apply(s,next){s.run('voicePreferences='+JSON.stringify(next));return s.run('applyTranscriptionSettings('+JSON.stringify(OLD_SETTINGS)+','+JSON.stringify(next)+')')}

test('Changing the transcription provider swaps sessions without ending the call',async()=>{
 const {s,sockets,old,status}=switching();
 const pending=apply(s,{...OLD_SETTINGS,stt_provider:'openai',stt_model:'gpt-4o-transcribe'});
 await new Promise(resolve=>setTimeout(resolve,5));
 // While the room has not answered, the call is still the old one: same socket, same session, mic untouched.
 assert.equal(sockets.length,2,'a second socket is opened');
 assert.equal(s.run('ws'),old);
 assert.equal(old.closed,false);
 assert.equal(s.run('sessionId'),'old-session');
 assert.match(status.at(-1).text,/Cambiando de transcripción/);
 assert.equal(s.run('prepared.length'),0,'OpenAI transcribes in the room: nothing is loaded here');
 const next=sockets[1];next.readyState=1;next.onopen();
 const hello=JSON.parse(next.sent[0]);
 assert.equal(hello.data.conversation,'t-1','the tab keeps the conversation it had chosen');
 assert.equal(hello.data.settings.stt_provider,'openai','the new hello carries the new settings');
 next.onmessage({data:JSON.stringify({type:'voice-session',data:{session_id:'new-session',sample_rate:16000,channels:1}})});
 assert.equal(await pending,'switched');
 assert.equal(status.at(-1),null,'the line goes away once the new session is up');
 assert.equal(s.run('ws'),next);
 assert.equal(s.run('sessionId'),'new-session');
 assert.equal(old.closed,true,'the old socket is closed once the new session exists');
 assert.equal(old.onclose,null,'and its close is not read as the room going away');
 assert.equal(s.run('stream')!==null,true,'the microphone stream was kept');
 assert.equal(s.run('stopped')>0,true,'the local runtime stops when the room takes over transcription');
 assert.equal(s.run('switchingSession'),false);
});

test('A microphone threshold rebuilds the pipeline the same way, loading the local model before the swap',async()=>{
 const {s,sockets,old,status}=switching();
 const pending=apply(s,{...OLD_SETTINGS,vad_confidence:0.8,user_speech_timeout:4});
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(s.run('JSON.stringify(prepared)'),'["onnx-community/whisper-tiny"]','the runtime is ready before the socket is swapped');
 assert.match(status.at(-1).text,/micrófono/);
 assert.equal(s.run('ws'),old,'the call runs on the old pipeline while the new one is prepared');
 const next=sockets[1];next.readyState=1;next.onopen();
 assert.equal(JSON.parse(next.sent[0]).data.settings.vad_confidence,0.8);
 next.onmessage({data:JSON.stringify({type:'voice-session',data:{session_id:'new-session',sample_rate:16000,channels:1}})});
 assert.equal(await pending,'switched');
 assert.equal(s.run('ws'),next);
 assert.equal(s.run('JSON.stringify(started)'),'["es"]','the browser transcribes again, on the new socket');
});

test('A room that refuses the new session leaves the call exactly as it was, and says why',async()=>{
 const {s,sockets,old,status}=switching();
 const pending=apply(s,{...OLD_SETTINGS,stt_provider:'openai',stt_model:'gpt-4o-transcribe'});
 await new Promise(resolve=>setTimeout(resolve,5));
 const next=sockets[1];next.readyState=1;next.onopen();
 next.onmessage({data:JSON.stringify({type:'error',data:{message:'OpenAI necesita una clave de API antes de conectar.'}})});
 next.close();
 assert.equal(await pending,false);
 assert.equal(s.run('ws'),old,'the call never left the socket it was on');
 assert.equal(old.closed,false);
 assert.equal(s.run('sessionId'),'old-session');
 assert.equal(status.at(-1).failed,true);
 assert.match(status.at(-1).text,/No se pudo aplicar el cambio: OpenAI necesita una clave de API/);
 assert.match(status.at(-1).text,/sigue con los ajustes anteriores/);
 assert.equal(s.run('switchingSession'),false);
});

test('Cancelling the preparation abandons the swap and not the call',async()=>{
 const {s,sockets,old}=switching();
 s.run("window.roomTranscription.prepare=()=>new Promise(()=>{})");
 const pending=apply(s,{...OLD_SETTINGS,stt_model:'onnx-community/whisper-tiny',stt_language:'auto'});
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(s.run('switchingSession'),true);
 s.run('cancelPreparation()');
 assert.equal(s.run('switchingSession'),false);
 assert.equal(s.run('ws'),old,'the call stays up');
 assert.equal(old.closed,false);
 assert.equal(sockets.length,1,'the swap never got as far as a second socket');
 assert.equal(await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('pending'),5))]),'pending');
});

test('Every room query names the browser asking, so the answer is never another device\'s',async()=>{
 const s=setup(),asked=[];
 s.context.fetch=async path=>{asked.push(path);return {ok:true,json:async()=>({binding:{thread_id:'a',title:'A',binding_id:'b'},room:{clients:2},call:{id:'s'}})}};
 await s.run('refresh()');
 assert.equal(asked[0],'/api/presentation?session_id=s');
 assert.equal(s.run("roomQuery('/api/presentation/latency')"),'/api/presentation/latency?session_id=s');
 // Before joining there is no browser to ask about, and the page asks about the room alone.
 s.run("sessionId=null");
 assert.equal(s.run("roomQuery('/api/presentation')"),'/api/presentation');
});

test('A reply the room addressed to another browser is not played by this one',async()=>{
 const s=setup(),posts=[];
 s.context.fetch=async(path,options)=>{if(options)posts.push(JSON.parse(options.body));return {ok:true,json:async()=>({messages:[]})}};
 s.run("played=[];window.roomVoice={speak(d){played.push('kokoro:'+d.session_id);return Promise.resolve()},playEncoded(d){played.push('shared:'+d.audio_base64);return Promise.resolve()},cancel(){}}");
 const speech=(type,extra)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data:{session_id:'s',revision:1,utterance_id:'u',thread_id:'a',text:'Hola',...extra}}))})`);
 speech('voice-speech',{session_id:'otro-navegador'});
 await s.run('Promise.resolve()');
 assert.equal(s.run("played.join('|')"),'');
 // Its own copy of the same shared reply is played, and the paid audio needs no second request.
 speech('voice-speech',{});
 await s.run('Promise.resolve()');
 speech('voice-speech-audio',{utterance_id:'v',revision:2,audio_base64:'YQ=='});
 await s.run('Promise.resolve()');
 assert.equal(s.run("played.join('|')"),'kokoro:s|shared:YQ==');
});

test('A shared reply keeps one bubble when live delivery and history name different browsers',async()=>{
 const s=setup();
 s.context.window.roomVoice={speak(){return new Promise(()=>{})},cancel(){}};
 s.context.fetch=async path=>({ok:true,json:async()=>path==='/api/presentation/history'?{messages:[{
  id:'mobile:voice:shared',thread:'a',role:'assistant',text:'Respuesta compartida',name:'A',
  session:'mobile',revision:1,time:1,seq:1,status:'playing'
 }]}:{}});
 s.run("receiveBrowserSpeech({session_id:'s',revision:1,utterance_id:'shared',history_id:'mobile:voice:shared',thread_id:'a',text:'Respuesta compartida'})");
 assert.equal(s.run('history.length'),1,'the live event creates the bubble');
 await s.run('refreshHistory()');
 assert.equal(s.run('history.length'),1,'history reconciles with that same bubble');
 assert.equal(s.run('history[0].segment'),'mobile:voice:shared');
 s.run("history.push({...history[0],segment:'s:voice:shared',session:'s'})");
 assert.equal(s.run('history.length'),2,'an old tab may already contain both aliases');
 await s.run('refreshHistory()');
 assert.equal(s.run('history.length'),1,'refresh removes the pre-fix alias');
});

test('Stopping playback reports it for this browser and keeps the shared message',()=>{
 const s=setup(),posts=[];
 s.context.fetch=async(path,options)=>{posts.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}};
 s.run("window.roomVoice={cancel(){}};history=[{segment:'s:voice:u',thread:'a',role:'assistant',time:1,text:'Respuesta compartida'}];activeSpeech={session_id:'s',revision:1,utterance_id:'u',started:true};cancelBrowserSpeech()");
 assert.equal(posts[0].status,'cancelled_playing');
 assert.equal(posts[0].session_id,'s');
 // The text belongs to the room: this browser marks it interrupted for itself, never removes it.
 assert.equal(s.run('history.length'),1);
 assert.equal(s.run('history[0].text'),'Respuesta compartida');
 assert.equal(s.run('history[0].interrupted'),true);
});

test('The engine badge says what this call uses, in a few words',()=>{
 const s=setup();
 assert.equal(s.run("engineBadgeText({stt_provider:'openai',stt_model:'gpt-4o-transcribe',turn_end_mode:'smart_turn'},null)"),'OpenAI · gpt-4o-transcribe · smart-turn');
 assert.equal(s.run("engineBadgeText({stt_provider:'browser',stt_model:'onnx-community/whisper-base',turn_end_mode:'timer',user_speech_timeout:2.5},{model:'onnx-community/whisper-base',device:'wasm'})"),'Whisper base · CPU · silencio 2,5 s');
 assert.equal(s.run("engineBadgeText({stt_provider:'browser',stt_model:'onnx-community/whisper-tiny',turn_end_mode:'smart_turn'},{model:'onnx-community/whisper-tiny',device:'wasm',fallback_from:'webgpu'})"),'Whisper tiny · CPU (GPU falló) · smart-turn');
 s.run("showEngineBadge('x')");assert.equal(s.run("$('engine-badge').hidden"),false);s.run("showEngineBadge('')");assert.equal(s.run("$('engine-badge').hidden"),true);
});

test('One bubble per turn: bars while listening, slower while transcribing, kept through a merge, replaced by the text',()=>{
 const s=setup();const views=[];
 s.context.window.sidevoiceUI={setConversation:v=>views.push(v),setParticipants(){},setLanguageModels(){},setBootError(){}};
 s.run("roomBinding={thread_id:'a',title:'A'};sessionId='s';window.roomVoice={cancel(){}}");
 const emit=(type,data)=>s.run('message('+JSON.stringify(JSON.stringify({type,data}))+')');
 emit('voice-user-turn',{phase:'started',revision:1,thread_id:'a'});
 assert.equal(views.at(-1).pendingPhase,'listening');assert.equal(views.at(-1).pendingText,'');
 emit('user-stopped-speaking',{});assert.equal(views.at(-1).pendingPhase,'transcribing');
 emit('voice-user-turn',{phase:'started',revision:2,thread_id:'a'});assert.equal(views.at(-1).pendingPhase,'listening');
 emit('voice-user-turn',{phase:'cancelled',revision:1,thread_id:'a',text:'Pero bueno,',merged:true});
 assert.equal(views.at(-1).pendingPhase,'listening','a merged turn keeps the bubble open');
 emit('voice-user-turn',{phase:'finished',revision:2,thread_id:'a',text:'Pero bueno, sigo.'});
 assert.equal(views.at(-1).pendingPhase,'');assert.equal(views.at(-1).messages.at(-1).text,'Pero bueno, sigo.');
 emit('voice-user-turn',{phase:'started',revision:3,thread_id:'a'});emit('voice-user-turn',{phase:'cancelled',revision:3,thread_id:'a',text:''});
 assert.equal(views.at(-1).pendingPhase,'','a real cancel closes the bubble');
});

test('The waveform bubble reads the meter\'s own analyser and never opens a second audio graph',()=>{
 const s=setup();
 assert.equal(s.run('window.sidevoiceAudio.readWaveform()'),null,'no call, nothing to draw');
 s.run("analyser={fftSize:8,reads:0,getFloatTimeDomainData(target){this.reads++;for(let i=0;i<target.length;i++)target[i]=(i+1)/10}}");
 const first=s.run('window.sidevoiceAudio.readWaveform()');
 assert.equal(first.length,8,'the buffer follows the analyser it reads from');
 assert.deepEqual(Array.from(first).map(v=>Math.round(v*10)),[1,2,3,4,5,6,7,8]);
 assert.equal(s.run('window.sidevoiceAudio.readWaveform()===window.sidevoiceAudio.readWaveform()'),true,'one buffer, reused: a frame allocates nothing');
 assert.equal(s.run('analyser.reads'),3);
 assert.equal(s.run('audioContext'),null,'reading the waveform opens no audio context of its own');
 s.run('analyser=null');
 assert.equal(s.run('window.sidevoiceAudio.readWaveform()'),null,'a closed meter stops feeding the bubble');
});

test('The stages view lists the last turn in order with bars scaled to the longest stage',()=>{
 const s=setup();
 s.run("renderLatencyStages({reply_revision:4,input_ms:{endpoint_silence_ms:610,recognition_ms:900,transcript_to_delivery_ms:12},server_ms:{input_queued_to_reply_received_ms:9000},browser_ms:{audio_received_to_playback_scheduled_ms:40}})");
 const items=s.run("$('stats-stages').children.map(li=>[li.children[0].textContent,!!li.children[1].hidden,li.children[1].style.width||'',li.children[2].textContent])");
 assert.equal(JSON.stringify(items[0]),JSON.stringify(['Silencio hasta cerrar el turno',false,'7%','610 ms']));
 assert.equal(JSON.stringify(items[2]),JSON.stringify(['Whisper en este navegador',true,'','—']));
 assert.equal(JSON.stringify(items[6]),JSON.stringify(['Agente: entrega → primera respuesta',false,'100%','9.00 s']));
 assert.equal(JSON.stringify(items[4]),JSON.stringify(['Entregado → leído por la conversación',true,'','—']));
 assert.match(s.run("$('stats-stages-note').textContent"),/Turno 4/);
 // A harness that never acknowledges delivery (Claude Code's inbox) still yields a read mark: the stage falls back to queued → read.
 s.run("renderLatencyStages({reply_revision:5,server_ms:{input_queued_to_read_ms:5800,read_to_reply_received_ms:4200,input_queued_to_reply_received_ms:10000}})");
 const read=s.run("$('stats-stages').children.map(li=>[li.children[0].textContent,li.children[2].textContent])");
 assert.equal(JSON.stringify(read[4]),JSON.stringify(['Entregado → leído por la conversación','5.80 s']));
 assert.equal(JSON.stringify(read[5]),JSON.stringify(['Leído → primera respuesta','4.20 s']));
});

test('Aggregates summarize with nearest-rank percentiles and never turn a missing value into a zero',()=>{
 const s=setup();
 assert.equal(JSON.stringify(s.run('statsSummary([400,100,300,200])')),JSON.stringify({count:4,mean:250,p50:200,p90:400,max:400}));
 assert.equal(JSON.stringify(s.run('statsSummary([700])')),JSON.stringify({count:1,mean:700,p50:700,p90:700,max:700}));
 // Nearest rank: p50 and p90 are values that were measured, never the midpoint between two of them.
 assert.equal(s.run('statsSummary([10,20,30,40,50,60,70,80,90,100]).p90'),90);
 assert.equal(s.run('statsSummary([10,20,30,40,50,60,70,80,90,100,110]).p90'),100);
 assert.equal(s.run('statsSummary([10,20,30]).p50'),20);
 // Whatever is not a finite, non-negative number is not an observation, so it does not enter the sample.
 assert.equal(JSON.stringify(s.run("statsSummary([null,undefined,NaN,Infinity,-1,'20',true,20])")),JSON.stringify({count:1,mean:20,p50:20,p90:20,max:20}));
 assert.equal(JSON.stringify(s.run('statsSummary([])')),JSON.stringify({count:0,mean:null,p50:null,p90:null,max:null}));
 assert.equal(JSON.stringify(s.run('statsSummary(null)')),JSON.stringify({count:0,mean:null,p50:null,p90:null,max:null}));
 assert.equal(JSON.stringify(s.run('statsSummary([0,0])')),JSON.stringify({count:2,mean:0,p50:0,p90:0,max:0}),'a measured zero is a measurement');
});
test('Aggregates keep one row per stage, named as the last-turn view names them',()=>{
 const s=setup();
 const rows=s.run(`statsAggregate([
 {thread_id:'a',input_ms:{endpoint_silence_ms:600,recognition_ms:400},server_ms:{input_queued_to_reply_received_ms:3000,input_queued_to_read_ms:900},provider_ms:{request_to_complete_ms:200}},
 {thread_id:'a',input_ms:{endpoint_silence_ms:1000},server_ms:{input_queued_to_reply_received_ms:9000,delivery_accepted_to_read_ms:100}},
 null
 ]).map(row=>[row.key,row.count,row.mean,row.p50,row.p90,row.max])`);
 assert.equal(rows.length,s.run('LATENCY_STAGES.length'),'every stage keeps its row');
 assert.equal(JSON.stringify(rows[0]),JSON.stringify(['endpoint_silence',2,800,600,1000,1000]));
 assert.equal(JSON.stringify(rows[1]),JSON.stringify(['recognition',1,400,400,400,400]));
 assert.equal(JSON.stringify(rows[2]),JSON.stringify(['request_to_transcript',0,null,null,null,null]),'a stage nobody measured stays empty, not zero');
 assert.equal(JSON.stringify(rows[4]),JSON.stringify(['delivery_to_read',2,500,100,900,900]),'the read stage falls back to queued → read, as the last-turn view does');
 assert.equal(JSON.stringify(rows[6]),JSON.stringify(['input_queued_to_reply',2,6000,3000,9000,9000]));
 assert.equal(s.run("statsAggregate([]).every(row=>row.count===0&&row.max===null)"),true);
});
test('The aggregates section covers the whole session and splits per conversation only when there was more than one',()=>{
 const s=setup();
 const snapshot=`{replies:[
 {thread_id:'a',reply_revision:1,input_ms:{endpoint_silence_ms:600},server_ms:{input_queued_to_reply_received_ms:3000}},
 {thread_id:'a',reply_revision:2,input_ms:{endpoint_silence_ms:1000},server_ms:{input_queued_to_reply_received_ms:9000}},
 {thread_id:'b',reply_revision:3,server_ms:{input_queued_to_reply_received_ms:21000}}
 ]}`;
 s.run("people=[{thread_id:'a',title:'Claude'},{thread_id:'b',title:'Astra'}]");
 s.run('renderLatencyStats('+snapshot+",'a')");
 const captions=s.run("$('stats-aggregates').children.map(wrap=>wrap.children[0].children[0].textContent)");
 assert.equal(JSON.stringify(captions),JSON.stringify(['Toda la sesión · 3 respuestas medidas','Claude · 2 respuestas medidas','Astra · 1 respuesta medida']));
 const header=s.run("$('stats-aggregates').children[0].children[0].children[1].children[0].children.map(cell=>cell.textContent)");
 assert.equal(JSON.stringify(header),JSON.stringify(['Tramo','n','Media','p50','p90','Máx']));
 const session=s.run("$('stats-aggregates').children[0].children[0].children[2].children.map(row=>row.children.map(cell=>cell.textContent))");
 assert.equal(session.length,s.run('LATENCY_STAGES.length'));
 assert.equal(JSON.stringify(session[0]),JSON.stringify(['Silencio hasta cerrar el turno','2','800 ms','600 ms','1.00 s','1.00 s']));
 assert.equal(JSON.stringify(session[6]),JSON.stringify(['Agente: entrega → primera respuesta','3','11.00 s','9.00 s','21.00 s','21.00 s']),'the session table counts every conversation, not the selected one');
 assert.equal(JSON.stringify(session[2]),JSON.stringify(['Whisper en este navegador','—','—','—','—','—']),'what nobody measured stays a dash');
 assert.match(s.run("$('stats-aggregates-note').textContent"),/no se deben sumar/);
 assert.equal(s.run("$('stats-aggregates-copy').disabled"),false);
 // One conversation, one table.
 s.run("renderLatencyStats({replies:[{thread_id:'a',reply_revision:1,server_ms:{input_queued_to_reply_received_ms:3000}}]},'a')");
 assert.equal(s.run("$('stats-aggregates').children.length"),1);
 // No call, nothing measured: no invented rows and nothing to copy.
 s.run('renderLatencyStats(null,null)');
 assert.equal(s.run("$('stats-aggregates').children.length"),0);
 assert.match(s.run("$('stats-aggregates-note').textContent"),/Aún no hay respuestas medidas/);
 assert.equal(s.run("$('stats-aggregates-copy').disabled"),true);
});
test('Copying the aggregates puts a plain-text table on the clipboard and says so',async()=>{
 const s=setup();const copied=[];
 s.context.navigator={clipboard:{writeText:async text=>{copied.push(text)}}};
 s.run("people=[{thread_id:'a',title:'Claude'},{thread_id:'b',title:'Astra'}]");
 s.run(`renderLatencyStats({replies:[
 {thread_id:'a',reply_revision:1,input_ms:{endpoint_silence_ms:600},server_ms:{input_queued_to_reply_received_ms:3000}},
 {thread_id:'b',reply_revision:2,server_ms:{input_queued_to_reply_received_ms:21000}}
 ]},'a')`);
 await s.run('copyLatencyAggregates()');
 assert.equal(copied.length,1);
 const lines=copied[0].split('\n');
 assert.match(lines[0],/no se suman/);
 assert.match(lines[3],/^Tramo +n +Media +p50 +p90 +Máx$/);
 assert.match(lines[5],/^Silencio hasta cerrar el turno +1 +600 ms +600 ms +600 ms +600 ms$/);
 assert.equal(lines[3].length,lines[5].length,'the columns line up so the table reads as a table');
 assert.match(lines[4],/^-+ +-+ +-+ +-+ +-+ +-+$/);
 assert.match(copied[0],/Toda la sesión · 2 respuestas medidas/);
 assert.match(copied[0],/Claude · 1 respuesta medida/);
 assert.match(copied[0],/Astra · 1 respuesta medida/);
 assert.equal(s.run("$('stats-aggregates-copied').textContent"),'Copiado como texto.');
 // A browser that refuses the clipboard says so instead of pretending it copied.
 s.context.navigator={};
 await s.run('copyLatencyAggregates()');
 assert.match(s.run("$('stats-aggregates-copied').textContent"),/no dejó copiar/);
 s.run('renderLatencyStats(null,null)');
 await s.run('copyLatencyAggregates()');
 assert.equal(copied.length,1,'nothing measured, nothing copied');
 assert.match(s.run("$('stats-aggregates-copied').textContent"),/nada que copiar/);
});

test('Selecting a conversation is this tab\'s own choice: it names the session, is remembered per tab and comes back on reconnect',async()=>{
 const s=setup();const store={};const posted=[];
 s.context.sessionStorage={getItem:k=>store[k]??null,setItem(k,v){store[k]=v},removeItem(k){delete store[k]}};s.context.window.sidevoiceUI={setParticipants(){}};
 s.context.fetch=async(path,init)=>{posted.push([path,init?.body?JSON.parse(init.body):null]);
  if(path.includes('/select'))return {ok:true,json:async()=>({status:'activated',binding:{thread_id:'t-1',title:'Uno',binding_id:'b-1'}})};
  return {ok:true,json:async()=>({binding:{thread_id:'t-1',title:'Uno',binding_id:'b-1'},room:{revision:1},clients:[],call:null})}};
 s.run("sessionId='sess-1';ws={readyState:1};roomBinding=null;people=[{thread_id:'t-1',title:'Uno',available:true,reach:{state:'listening'}},{thread_id:'t-2',title:'Dos',available:true,reach:{state:'listening'}}]");
 await s.run('select')('t-1');
 const select=posted.find(([path])=>path.endsWith('/api/presentation/select'));
 assert.deepEqual(select[1],{thread_id:'t-1',session_id:'sess-1'},'the room is told which browser chose');
 assert.equal(store['sidevoice.selected'],'t-1','remembered for this tab only');
 assert.equal(s.run('rememberedThread')(),'t-1');
 // A new socket for this tab (reload, reconnect) goes back to the same conversation and never picks another.
 posted.length=0;s.run("roomBinding=null;sessionId='sess-2'");
 assert.equal(await s.run('reselectRemembered')(),true);
 assert.deepEqual(posted.find(([path])=>path.endsWith('/api/presentation/select'))[1],{thread_id:'t-1',session_id:'sess-2'});
 // With two conversations listening and nothing remembered, the tab chooses nothing by itself.
 delete store['sidevoice.selected'];posted.length=0;s.run("roomBinding=null");
 assert.equal(await s.run('reselectRemembered')(),false);
 assert.equal(await s.run('selectOnlyListeningConversation')(),false);
 assert.equal(posted.some(([path])=>path.endsWith('/api/presentation/select')),false);
});

test('The stats say which build the page runs and which the room serves, and flag a stale page',()=>{
 const s=setup();
 s.context.window.sidevoiceBuildId='page1';
 s.run("roomInfo={version:'0.3.0',web_build:'page1'}");
 assert.equal(JSON.stringify(s.run('versionFacts')()),JSON.stringify([['Versión de la página','page1'],['Versión que sirve la sala','page1 · al día'],['Servidor','0.3.0']]));
 s.run("roomInfo={version:'0.3.0',web_build:'page2'}");
 assert.equal(s.run('versionFacts')()[1][1],'page2 · hay una versión nueva, recarga');
 s.run("roomInfo=null");
 assert.equal(s.run('versionFacts')()[1][1],'—');
});

test('When the room goes away the call stays up: the socket is reopened by itself with the same hello and the mic survives',async()=>{
 const s=setup();const sockets=[];
 s.context.WebSocket=class{constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this)}send(m){this.sent.push(m)}close(){this.readyState=3}};
 s.context.WebSocket.OPEN=1;
 const joinLine=[];s.context.window.sidevoiceUI=new Proxy({},{get:(_,name)=>value=>{if(name==='setJoinStatus')joinLine.push(value?value.text:null)}});s.context.crypto={randomUUID:()=>'hello-id'};
 s.context.fetch=async()=>({ok:true,json:async()=>({binding:null,room:{revision:0},clients:[],call:null,participants:[]})});
 s.run("RECONNECT_DELAYS_MS.splice(0,RECONNECT_DELAYS_MS.length,1,1);startMeter=()=>{};stopMeter=()=>{};startCapture=async()=>{};keepScreenAwake=()=>{};window.roomVoice={unlock:async()=>{},cancel(){},context:{state:'running'}};window.roomTranscription={stop(){},start(){}};voicePreferences={stt_provider:'openai'};stream={getAudioTracks:()=>[{enabled:true}]};sessionId='old-session';ws={readyState:1}");
 s.context.sessionStorage={getItem:()=>'t-1',setItem(){},removeItem(){}};
 const epoch=s.run('connectEpoch');
 // The room restarts: the socket closes with a code that is not a refusal.
 const pending=s.run('lostConnection')({code:1006},epoch,{browserStt:false,sttRuntime:null});
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(sockets.length,1,'a new socket is opened after the first delay');
 assert.deepEqual(joinLine,['Reconectando con la sala…'],'the reconnection uses the join line, not the transcript status');
 const socket=sockets[0];socket.readyState=1;socket.onopen();
 const hello=JSON.parse(socket.sent[0]);
 assert.equal(hello.type,'client-ready');assert.equal(hello.data.conversation,'t-1','the remembered conversation travels in the hello');
 socket.onmessage({data:JSON.stringify({type:'voice-session',data:{session_id:'new-session',sample_rate:16000,channels:1,room:{version:'x',web_build:'y'}}})});
 await pending;
 assert.equal(s.run('sessionId'),'new-session');
 assert.equal(s.run('ws'),socket);
 assert.equal(s.run('stream')!==null,true,'the microphone stream was kept');
 assert.equal(s.run('reconnecting'),false);
 assert.equal(joinLine.at(-1),null,'and the line goes away once the room answers again');
 // A refusal is final: no retry, the call ends.
 let ended=false;s.run("disconnect=()=>{ws=null;globalThis.__ended=true}");
 await s.run('lostConnection')({code:1013},s.run('connectEpoch'),{browserStt:false,sttRuntime:null});
 assert.equal(s.run('globalThis.__ended'),true);
 assert.equal(sockets.length,1);
});

test('The engine badge carries the audio output health: recovering on a stall, failed on a refusal, clean once something plays',()=>{
 const s=setup();
 s.run("showEngineBadge('OpenAI · gpt-4o')");
 assert.equal(s.run("$('engine-badge').textContent"),'OpenAI · gpt-4o');
 s.run("noteOutputHealth('stall')");
 assert.equal(s.run("$('engine-badge').textContent"),'OpenAI · gpt-4o · audio ↻');
 assert.equal(s.run("$('engine-badge').dataset.output"),'recovering');
 s.run("noteOutputHealth('complete')");
 assert.equal(s.run("$('engine-badge').textContent"),'OpenAI · gpt-4o');
 s.run("noteOutputHealth('attach-refused')");
 assert.equal(s.run("$('engine-badge').textContent"),'OpenAI · gpt-4o · audio ✕');
 s.run("noteOutputHealth('cancel')");
 assert.equal(s.run("$('engine-badge').dataset.output"),'failed','a cancel says nothing about health');
 s.run("noteOutputHealth('play-encoded')");
 assert.equal(s.run("$('engine-badge').dataset.output"),'ok');
});

test('The echo light says whether the page can expect its own voice to be cancelled: mic AEC on and voice through the media element',()=>{
 const s=setup();
 const settings={echoCancellation:true};
 s.run("ws={readyState:1}");
 s.context.window.roomVoice={health:()=>({output:'element',element:{paused:false}})};
 s.context.__settings=settings;
 s.run("stream={getAudioTracks:()=>[{enabled:true,getSettings:()=>globalThis.__settings}]}");
 s.run('showEchoCover')();
 assert.equal(s.run("$('echo-cover').hidden"),false);
 assert.equal(s.run("$('echo-cover').dataset.state"),'on');
 s.context.window.roomVoice={health:()=>({output:'context',element:null})};
 s.run('showEchoCover')();
 assert.equal(s.run("$('echo-cover').dataset.state"),'partial');
 assert.match(s.run("$('echo-note').textContent"),/elemento de audio/);
 settings.echoCancellation=false;
 s.run('showEchoCover')();
 assert.equal(s.run("$('echo-cover').dataset.state"),'off');
 s.run("ws=null");s.run('showEchoCover')();
 assert.equal(s.run("$('echo-cover').hidden"),true,'no call, no light');
});

/* One indicator from the tap to the room: these two tests are the sequence a person reads, and what
 * takes its place when a step fails. */
function joining(s,{preferences={},capabilities={webgpu:false,wasm:true,models:['onnx-community/whisper-tiny']},prepareVoice,prepareWhisper,getUserMedia}={}){
 const published=[],sockets=[],track={enabled:true,stop(){},getSettings:()=>({echoCancellation:true}),applyConstraints:async()=>{}};
 s.context.window.sidevoiceUI=new Proxy({},{get:(_,name)=>value=>{if(name==='setJoinStatus')published.push(value?value.text:null)}});
 s.context.crypto={randomUUID:()=>'hello-id'};
 s.context.sessionStorage={getItem:()=>'t-1',setItem(){},removeItem(){}};
 s.context.WebSocket=class{constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this)}send(m){this.sent.push(m)}close(){this.readyState=3}};
 s.context.WebSocket.OPEN=1;
 s.context.fetch=async path=>({ok:true,json:async()=>
  path.includes('/languages')?{stt_provider:'browser',stt_model:'onnx-community/whisper-tiny',stt_device:'auto',default_model:'kokoro',tts_device:'auto',...preferences}
  :path.includes('/participants')?{participants:[{thread_id:'t-1',title:'Astra',available:true,reach:{state:'listening'}}]}
  :{binding:null,room:{revision:0},clients:[],call:null,participants:[]}});
 s.context.window.roomVoice={unlock:async()=>{},cancel(){},prepare:prepareVoice||(async()=>{s.handlers['voice-preparation']({detail:{phase:'loading',progress:42}})})};
 s.context.window.roomTranscription={capabilities:async()=>capabilities,start(){},stop(){},
  prepare:prepareWhisper||(async({model})=>{s.handlers['voice-preparation']({detail:{kind:'transcription',phase:'loading',progress:17}});return {model,device:'wasm'}})};
 s.context.navigator={mediaDevices:{getUserMedia:getUserMedia||(async()=>({getAudioTracks:()=>[track],getTracks:()=>[track]}))}};
 s.run("startMeter=()=>{};startCapture=async()=>{};keepScreenAwake=()=>{};$('mute').style.setProperty=()=>{};people=[{thread_id:'t-1',title:'Astra',available:true,reach:{state:'listening'}}]");
 return {published,sockets,tap:()=>s.run("$('connect').onclick")()};
}
async function firstSocket(sockets){for(let attempt=0;attempt<200&&!sockets.length;attempt++)await new Promise(resolve=>setTimeout(resolve,2));return sockets[0]}

test('The join names each step it is on, from the tap until the conversation is back',async()=>{
 const s=setup({strictDOM:true}),{published,sockets,tap}=joining(s);
 const joined=tap();
 const socket=await firstSocket(sockets);
 socket.readyState=1;socket.onopen();
 socket.onmessage({data:JSON.stringify({type:'voice-session',data:{session_id:'call-1',sample_rate:16000,channels:1}})});
 await joined;
 assert.deepEqual(published,[
  'Preparando audio',
  'Cargando Whisper','Cargando Whisper (17 %)',
  'Cargando el modelo de voz','Cargando el modelo de voz (42 %)',
  'Pidiendo el micrófono',
  'Entrando en la sala',
  'Volviendo a Astra',
  null
 ]);
});

test('A step that fails leaves its reason, and what to do, where the step was',async()=>{
 const denied=setup({strictDOM:true});
 const mic=joining(denied,{getUserMedia:async()=>{const error=Error('Permission denied');error.name='NotAllowedError';throw error}});
 await mic.tap();
 assert.equal(mic.published.at(-1),'El micrófono está bloqueado para esta página. Dale permiso en el navegador y vuelve a pulsar para entrar.');
 assert.equal(denied.run('connecting'),false);

 const device=setup({strictDOM:true});
 const model=joining(device,{prepareWhisper:async()=>{throw Error('WebGPU no disponible')}});
 await model.tap();
 assert.match(model.published.at(-1),/El modelo no se pudo cargar en este dispositivo \(WebGPU no disponible\)/);
 assert.match(model.published.at(-1),/Configuración/);

 const full=setup({strictDOM:true});
 const room=joining(full);
 const joined=room.tap();
 const socket=await firstSocket(room.sockets);
 socket.onclose({code:1013});
 await joined;
 assert.equal(room.published.at(-1),'La sala ya tiene el máximo de navegadores conectados. Espera a que salga alguien y vuelve a entrar.');
});

// ----- the ambient bed while the conversation works on this browser's turn (#42) -----
function presenceSetup(preferences='{}'){
 const s=setup(),calls=[],timers=new Map();let serial=0;
 s.context.setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id};
 s.context.clearTimeout=id=>timers.delete(id);
 s.context.fetch=async()=>({ok:true,json:async()=>({})});
 s.context.window.roomVoice={cancel(){},chime(kind){calls.push(['chime',kind]);return true},startPresence(options){calls.push(['start',options.reason,options.volume]);return true},stopPresence(reason){calls.push(['stop',reason]);return true}};
 s.context.window.sidevoiceUI={setParticipants(){},setBootError(){},setConversation(view){s.context.__view=view},setJoinStatus(){},setRoomState(){},setCall(){}};
 s.run("ws={readyState:1,close(){}};voicePreferences="+preferences);
 return {...s,calls,timers,
  emit:(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`),
  flush(){for(const [id,timer] of [...timers]){timers.delete(id);timer.fn()}}};
}
const OWN_TURN={revision:1,thread_id:'a',session_id:'s'};
test('The bed starts when the conversation reads this turn and ends at its first spoken reply',async()=>{
 const s=presenceSetup();
 s.emit('voice-user-turn',{...OWN_TURN,phase:'finished',text:'Hola'});
 s.emit('voice-input-receipt',{...OWN_TURN,status:'pending'});
 assert.deepEqual(s.calls,[],'queued is not in the conversation\'s hands yet');
 s.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 assert.deepEqual(s.calls,[['chime','read'],['start','read',0.035]]);
 assert.equal(s.run('presenceTurn'),'s:user-turn:1');
 let finish;s.context.window.roomVoice.playEncoded=()=>new Promise(resolve=>finish=resolve);
 const playing=s.run("receiveServerSpeech({session_id:'s',thread_id:'a',revision:1,utterance_id:'u',text:'Ya',audio_base64:'SUQz'})");
 assert.deepEqual(s.calls.at(-1),['stop','reply'],'the voice never shares the output with the bed');
 assert.equal(s.run('presenceTurn'),null);
 finish();await playing;
});
test('Without a read receipt the bed waits a moment after delivery, and a read overtakes that wait',()=>{
 const s=presenceSetup();
 s.emit('voice-input-receipt',{...OWN_TURN,status:'unconfirmed'});
 assert.deepEqual(s.calls,[],'a harness that never reports reads still gets the bed, just not instantly');
 assert.deepEqual([...s.timers.values()].map(timer=>timer.ms),[1500]);
 s.flush();
 assert.deepEqual(s.calls,[['start','unconfirmed',0.035]]);

 const later=presenceSetup();
 later.emit('voice-input-receipt',{...OWN_TURN,revision:2,status:'delivered'});
 later.emit('voice-input-receipt',{...OWN_TURN,revision:2,status:'read'});
 assert.deepEqual(later.calls,[['chime','read'],['start','read',0.035]]);
 later.flush();
 assert.deepEqual(later.calls,[['chime','read'],['start','read',0.035]],'the armed wait cannot start it a second time');
});
test('A delivery that failed, a new turn, the user speaking and losing the room all end the bed',()=>{
 const failed=presenceSetup();
 failed.emit('voice-input-receipt',{...OWN_TURN,status:'delivered'});
 failed.emit('voice-input-receipt',{...OWN_TURN,status:'not_sent'});
 failed.flush();
 assert.deepEqual(failed.calls,[],'nothing to say while it is working is not the same as nothing working');

 for(const [label,event,reason] of [
  ['another turn',['voice-user-turn',{...OWN_TURN,revision:2,phase:'started'}],'new_turn'],
  ['the user speaking',['user-started-speaking',{}],'user_speaking'],
  ['a cancelled turn',['voice-cancel',{...OWN_TURN,revision:2}],'cancelled'],
 ]){
  const s=presenceSetup();
  s.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
  s.emit(...event);
  assert.deepEqual(s.calls.at(-1),['stop',reason],label);
  assert.equal(s.run('presenceTurn'),null,label);
 }
 const dropped=presenceSetup();
 dropped.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 dropped.run("stream={getTracks:()=>[],getAudioTracks:()=>[]};disconnect()");
 assert.ok(dropped.calls.some(call=>call[0]==='stop'&&call[1]==='disconnected'));
});
test('The bed belongs to the turn this browser sent to the conversation it is looking at',()=>{
 const s=presenceSetup();
 s.emit('voice-input-receipt',{...OWN_TURN,thread_id:'other',status:'read'});
 s.emit('voice-input-receipt',{...OWN_TURN,session_id:'another-browser',status:'read'});
 assert.deepEqual(s.calls,[],'another conversation, or another browser in the room, is not this bed');
 s.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 assert.deepEqual(s.calls,[['chime','read'],['start','read',0.035]]);
});
test('The bed is a device setting: off means silent, and the stored volume is what plays',()=>{
 const off=presenceSetup("{presence_sound:'off'}");
 off.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 off.flush();
 assert.deepEqual(off.calls,[]);
 const loud=presenceSetup("{presence_volume:8}");
 loud.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 assert.deepEqual(loud.calls,[['chime','read'],['start','read',0.08]],'the stored percentage is a peak amplitude');
 const absurd=presenceSetup("{presence_volume:400}");
 absurd.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 assert.deepEqual(absurd.calls,[['chime','read'],['start','read',0.12]],'and it is bounded here as well as in the player');
});
test('Turning the bed off while it sounds silences it at once',async()=>{
 const s=presenceSetup();
 s.context.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
 s.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 s.run("ws=null;voiceCatalog={languages:[],models:[]};$('presence-sound').value='off';$('presence-volume').value='4';$('stt-device').value='auto'");
 await s.run("$('language-form').onsubmit({preventDefault(){}})");
 assert.deepEqual(s.calls.at(-1),['stop','setting_off']);
});
test('Saving the settings form stores every device setting, the ambient bed among them',async()=>{
 const s=setup();const stored=[];
 s.context.localStorage={getItem:()=>null,setItem:(key,value)=>stored.push([key,JSON.parse(value)]),removeItem(){}};
 s.run("ws=null;voicePreferences={stt_provider:'openai',stt_device:'auto'};voiceCatalog={languages:[],models:[]}");
 for(const [id,value] of [['stt-language','es'],['stt-device',''],['default-tts-language','es'],['tts-speed','1'],['ui-language','es'],
  ['tts-device','auto'],['default-model','kokoro'],['default-voice','ef_dora'],['audio-grace-seconds','2'],['presence-sound','on'],['presence-volume','5'],
  ['turn-end-mode','smart_turn'],['user-speech-timeout','2.5'],['smart-turn-min-silence','0.6'],['smart-turn-max-silence','3'],
  ['vad-confidence','0.6'],['vad-min-volume','0.35'],['vad-start-secs','0.2']])
  s.run(`$('${id}').value=${JSON.stringify(value)}`);
 await s.run("$('language-form').onsubmit({preventDefault(){}})");
 assert.ok(!s.run("$('settings-error').textContent"),'the form reached the end without throwing');
 assert.match(s.run("$('live').textContent"),/Preferencias guardadas/);
 const saved=stored.find(([key])=>key==='sidevoice.settings')?.[1];
 assert.ok(saved,'something was stored at all');
 assert.equal(saved.stt_device,'auto','a hidden select reading back empty keeps the last valid value');
 assert.equal(saved.vad_start_secs,0.2);
 assert.equal(saved.presence_sound,'on');
 assert.equal(saved.presence_volume,5);
});

test('The read receipt is announced: one short note, the dots, and the bed; the dots stay even with the sound off',()=>{
 const s=presenceSetup();
 s.emit('voice-user-turn',{...OWN_TURN,phase:'finished',text:'Hola'});
 assert.equal(s.run('workingOnTurn')(),false,'nothing is working on it until the conversation says so');
 s.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 assert.deepEqual(s.calls,[['chime','read'],['start','read',0.035]],'the note lands with the second tick, before the bed');
 assert.equal(s.run('workingOnTurn')(),true);
 assert.equal(s.context.__view.working,true,'the conversation side shows the three dots');
 s.run("stopPresence('reply')");
 assert.equal(s.run('workingOnTurn')(),false);
 assert.equal(s.context.__view.working,false);
 // With the sound turned off there is no note and no bed, and the dots still say what is happening.
 const silent=presenceSetup("{presence_sound:'off'}");
 silent.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
 assert.deepEqual(silent.calls,[]);
 assert.equal(silent.run('workingOnTurn')(),true);
 assert.equal(silent.context.__view.working,true);
});
test('Everything that ends the bed also takes the dots away',()=>{
 for(const [event,data] of [['voice-user-turn',{...OWN_TURN,revision:2,phase:'started'}],
                            ['voice-input-receipt',{...OWN_TURN,status:'not_sent'}]]){
  const s=presenceSetup();
  s.emit('voice-input-receipt',{...OWN_TURN,status:'read'});
  assert.equal(s.run('workingOnTurn')(),true,event);
  s.emit(event,data);
  assert.equal(s.run('workingOnTurn')(),false,event);
 }
});
