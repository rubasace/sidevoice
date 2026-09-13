const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
function setup(){
 class Element{constructor(){this.children=[];this.dataset={};this.style={};this.classList={add(){},remove(){}};this.parentElement=this}addEventListener(){}removeAttribute(){}closest(){return null}querySelector(){return null}append(...children){this.children.push(...children)}replaceChildren(){this.children=[]}remove(){}setAttribute(){}click(){this.onclick?.()}}
 const elements=new Map(),handlers={};const context=vm.createContext({Element,console,Date,JSON,Math,Uint8Array,sessionStorage:{getItem:()=>null,setItem(){}},document:{getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)},createElement:()=>new Element(),addEventListener(){}},window:{addEventListener:(name,fn)=>handlers[name]=fn},fetch:()=>new Promise(()=>{}),setInterval(){},cancelAnimationFrame(){},requestAnimationFrame(){}});
 const source=fs.readFileSync(__dirname+'/presentation.html','utf8').split('<script>')[1].split('</script>')[0];vm.runInContext(source,context);
 vm.runInContext("roomBinding={thread_id:'a',title:'A'};sessionId='s'",context);
 return {context,handlers,Element,run:code=>vm.runInContext(code,context)};
}
test('TTS announcement/completion is one row; intentional repetitions remain separate',()=>{
 const s=setup();
 const emit=(spoken,id)=>s.run(`message(${JSON.stringify(JSON.stringify({type:'bot-output',data:{text:'Hola',spoken,segment_id:id,aggregated_by:'sentence'}}))})`);
 emit(false,1);emit(true,2);assert.equal(s.run('history.length'),1);
 emit(false,3);emit(true,4);assert.equal(s.run('history.length'),2);
});
test('Command D toggles and holding space restores mute on release or loss of focus',()=>{
 const s=setup();s.run("var track={enabled:true};stream={getAudioTracks:()=>[track]};pc={}");
 const key=code=>({code,metaKey:code==='KeyD',target:new s.Element(),preventDefault(){}});
 s.handlers.keydown(key('KeyD'));assert.equal(s.run('track.enabled'),false);
 s.handlers.keydown(key('Space'));assert.equal(s.run('track.enabled'),true);
 s.handlers.keyup(key('Space'));assert.equal(s.run('track.enabled'),false);
 s.handlers.keydown(key('Space'));s.handlers.blur();assert.equal(s.run('track.enabled'),false);
 s.handlers.keydown(key('KeyD'));assert.equal(s.run('track.enabled'),true);
});
test('Keyboard shortcuts ignore typing and auto-repeat',()=>{
 const s=setup();s.run("var track={enabled:true};stream={getAudioTracks:()=>[track]};pc={}");
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
test('Delivery tick follows the matching receipt and does not imply read',()=>{
 const s=setup();const emit=(type,data)=>s.run(`message(${JSON.stringify(JSON.stringify({type,data}))})`);
 emit('voice-user-turn',{phase:'finished',revision:1,thread_id:'a',text:'Hola'});
 assert.equal(s.run('history[0].delivery'),undefined);
 emit('voice-input-receipt',{revision:1,thread_id:'other',status:'delivered'});
 assert.equal(s.run('history[0].delivery'),undefined);
 emit('voice-input-receipt',{revision:1,thread_id:'a',status:'pending'});
 assert.equal(s.run('history[0].delivery'),'pending');
 emit('voice-input-receipt',{revision:1,thread_id:'a',status:'delivered'});
 assert.equal(s.run('history[0].delivery'),'delivered');
});

test('Space repeats and release suppress native button activation without toggling the mic',()=>{
 const s=setup();s.run("var track={enabled:false};stream={getAudioTracks:()=>[track]};pc={}");
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
 s.run("pc={};$('text-message').value='Un mensaje escrito';roomBinding.binding_id='binding-a'");
 s.context.fetch=async(path,options)=>{if(options){sent.push(JSON.parse(options.body));s.run("$('text-message').value='Ya escribiendo el siguiente'");return {ok:true,json:async()=>({accepted:true})}}return {ok:true,json:async()=>({messages:[]})}};
 await s.run("$('text-composer').onsubmit({preventDefault(){}})");
 assert.equal(sent[0].thread_id,'a');assert.equal(sent[0].text,'Un mensaje escrito');
 assert.equal(s.run("$('text-message').value"),'Ya escribiendo el siguiente');
});

test('Text entry is unavailable when viewing a different inactive history',()=>{
 const s=setup();s.run("pc={};viewedThread='b';updateComposer()");
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
 var stopped=0,closed=0,paused=0;
 $('mute').style.setProperty=()=>{};
 $('audio').pause=()=>paused++;
 window.roomVoice={cancel(){}};
 pc={close(){closed++}};
 stream={getTracks:()=>[{stop(){stopped++}}]};
 connecting=true;history=[{text:'keep'}];
 disconnect();
 `);
 assert.equal(s.run('stopped'),1);
 assert.equal(s.run('closed'),1);
 assert.equal(s.run('paused'),1);
 assert.equal(s.run('pc'),null);
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
