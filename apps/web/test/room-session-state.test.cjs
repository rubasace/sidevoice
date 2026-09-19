const test=require('node:test'),assert=require('node:assert/strict');
const moduleReady=import('../src/state/room-session-state.js');
function facts(api,patch={}){return {...api.initialSessionFacts(),ws:{},sessionId:'s',roomBinding:{thread_id:'a'},...patch}}
function turn(patch={}){return {session:'s',thread:'a',status:'read',...patch}}

test('A harness report, including idle, overrides every receipt, reply and microphone state',async()=>{
 const api=await moduleReady;
 for(const busy of [false,true])for(const userLive of [false,true])for(const botLive of [false,true])for(const final of [false,true]){
  const s=facts(api,{harness:{a:busy},userLive,botLive,turns:{one:turn({final})}});
  assert.equal(api.working(s),busy);
 }
});
test('Harness activity belongs to its conversation; another conversation cannot light these dots',async()=>{
 const api=await moduleReady;
 assert.equal(api.working(facts(api,{harness:{b:true}})),false);
 assert.equal(api.working(facts(api,{harness:{a:true,b:false}})),true);
});
test('A final marker settles only its own turn, and late receipts cannot reopen it',async()=>{
 const api=await moduleReady;let s=facts(api,{turns:{'s:user-turn:1':turn(),'s:user-turn:2':turn()}});
 s.turns=api.recordReply(s,{session_id:'s',thread_id:'a',revision:2,reply_revision:1,final:true});
 assert.equal(api.working(s),true);
 s.turns=api.recordReply(s,{session_id:'s',thread_id:'a',revision:2,final:true});
 assert.equal(api.working(s),false);
 s.turns=api.recordReceipt(s,'s:user-turn:2','read',100);
 assert.equal(api.working(s),false);
});
test('A progress reply establishes work without a receipt; a final reply defaults to final',async()=>{
 const api=await moduleReady;const s=facts(api);
 s.turns=api.recordReply(s,{session_id:'s',thread_id:'a',revision:1,final:false});
 assert.equal(api.working(s),true);
 s.turns=api.recordReply(s,{session_id:'s',thread_id:'a',revision:1});
 assert.equal(api.working(s),false);
});
test('Read means working immediately; delivery means working after the fallback deadline',async()=>{
 const api=await moduleReady;
 for(const status of ['delivered','unconfirmed']){
  const s=facts(api,{now:100});s.turns=api.recordReceipt(s,'one',status,100);
  assert.equal(api.working(s),false);s.now=1599;assert.equal(api.working(s),false);
  s.now=1600;assert.equal(api.working(s),true);
 }
 assert.equal(api.working(facts(api,{turns:{one:turn()}})),true);
});
test('Failed delivery and another browser never count as this conversation working',async()=>{
 const api=await moduleReady;
 for(const patch of [{status:'pending'},{status:'not_sent'},{status:'channel_closed'},{session:'other'},{thread:'b'}])
  assert.equal(api.working(facts(api,{turns:{one:turn(patch)}})),false);
});
test('The ambient breath is exactly working plus silence, at one fixed default level',async()=>{
 const api=await moduleReady;
 for(const busy of [false,true])for(const userLive of [false,true])for(const botLive of [false,true])for(const activeSpeech of [null,{}])for(const previewJob of [null,{}])for(const sound of ['on','off',undefined]){
  const s=facts(api,{harness:{a:busy},userLive,botLive,activeSpeech,previewJob,voicePreferences:{presence_sound:sound,presence_volume:8}});
  assert.equal(api.sessionStatus(s).bed,busy&&!userLive&&!botLive&&!activeSpeech&&!previewJob&&sound!=='off');
 }
 assert.equal(api.PRESENCE_LEVEL,.1);
});
test('Reconnecting, switching, and leaving cannot play ambient audio',async()=>{
 const api=await moduleReady;
 for(const patch of [{ws:null},{reconnecting:true},{switching:true},{switchingSession:true},{switchingTranscription:true}])
  assert.equal(api.sessionStatus(facts(api,{harness:{a:true},...patch})).bed,false);
});
test('The person and room speaking are independent of harness work and tab transcription',async()=>{
 const api=await moduleReady;
 const v=api.sessionStatus(facts(api,{harness:{a:true},userLive:true,botLive:true,pendingPhase:'transcribing'}));
 assert.equal(v.speaker,'user');assert.equal(v.conversation,'working');assert.equal(v.tab,'transcribing');
 assert.equal(api.sessionStatus(facts(api,{botLive:true})).conversation,'speaking');
 assert.equal(api.sessionStatus(facts(api)).conversation,'idle');
});
test('A waveform belongs only to the viewed active input, and cancelled input cannot be cancelled again',async()=>{
 const api=await moduleReady;const s=facts(api,{userTurn:{thread:'a',key:'user-turn:1'},pendingPhase:'listening'});
 assert.equal(api.conversationView(s).pendingPhase,'listening');
 s.pendingPhase='transcribing';assert.equal(api.conversationView(s).pendingPhase,'transcribing');
 s.viewedThread='b';assert.equal(api.conversationView(s).pendingPhase,'');assert.equal(api.conversationView(s).pendingCancellable,false);
 s.viewedThread=null;s.cancelledInput=true;assert.equal(api.conversationView(s).pendingPhase,'');assert.equal(api.conversationView(s).pendingCancellable,false);
});
test('Join progress, returning subject and failure text are derived from the same join facts',async()=>{
 const api=await moduleReady;const s=facts(api);
 for(const [step,text] of Object.entries(api.JOIN_STEPS))assert.equal(api.joinView({...s,joinStep:step,joinSubject:'A'}).text,text+(step==='conversation'?'A':''));
 assert.equal(api.joinView({...s,joinStep:'whisper',joinProgress:16.7}).text,'Cargando Whisper (17 %)');
 assert.deepEqual(api.joinView({...s,joinStep:'room',joinFailure:'No permission'}),{step:'failed',text:'No permission',progress:null,failed:true});
 assert.equal(api.joinView(s),null);
});
test('Echo coverage reports observed AEC and sink facts without inferring detector performance',async()=>{
 const {echoCoverage}=await moduleReady;
 for(const [patch,expected] of [[{connected:false},''],[{track:false},''],[{aec:false},'off'],[{aec:undefined},'partial'],[{health:{output:'context'}},'partial'],[{health:{output:'element',element:{paused:true}}},'partial'],[{},'on']])
  assert.equal(echoCoverage({connected:true,track:true,aec:true,health:{output:'element'},...patch}).state,expected);
});
test('The engine badge derives processing, fallback and output health from runtime facts',async()=>{
 const api=await moduleReady;const s=facts(api,{engineReady:true,voicePreferences:{stt_provider:'browser',stt_model:'whisper-base'},sttRuntime:{device:'wasm',fallback_from:'webgpu'},outputHealth:'recovering'});
 assert.match(api.engineView(s).text,/Whisper base · CPU \(GPU falló\) · smart-turn · audio ↻/);
 assert.equal(api.engineView({...s,engineReady:false}).text,'');
});
test('Two ticks require read; transport delivery and unconfirmed delivery each have one',async()=>{
 const {receiptView}=await moduleReady;
 assert.equal(receiptView('read').symbol,'✓✓');
 for(const status of ['delivered','unconfirmed'])assert.equal(receiptView(status).symbol,'✓');
 for(const status of ['pending','sending'])assert.equal(receiptView(status).symbol,'◷');
 for(const status of ['uncertain','not_sent'])assert.equal(receiptView(status).symbol,'!');
});
test('Playback and replay labels are projections of the utterance facts, preserving its full text',async()=>{
 const api=await moduleReady;const row={role:'assistant',segment:'h',thread:'a',text:'All the text',time:1};
 const s=facts(api,{history:[row],activeSpeech:{history_id:'h'},replayMarks:{h:'queued'}});
 assert.equal(api.conversationView(s).messages[0].playback,'pending');
 s.activeSpeech={history_id:'h',started:true};assert.equal(api.conversationView(s).messages[0].playback,'playing');
 s.activeSpeech=null;s.replayMarks={h:'done'};const message=api.conversationView(s).messages[0];
 assert.equal(message.playback,'complete');assert.equal(message.replayNote,'Repetido al volver');assert.equal(message.text,row.text);
});
test('One store transition publishes one coherent projection, without calls from a handler to render or sound',async()=>{
 const api=await moduleReady;const store=api.createRoomSessionStore(facts(api));const seen=[];store.subscribe(s=>seen.push(s));
 store.batch(()=>{store.facts.harness={a:true};store.facts.userLive=true});
 assert.equal(seen.length,1);assert.equal(seen[0].session.working,true);assert.equal(seen[0].session.bed,false);
 store.facts.userLive=false;assert.equal(seen[1].session.bed,true);
 assert.equal(seen[0].facts.userLive,true,'prior snapshots do not change');
});
