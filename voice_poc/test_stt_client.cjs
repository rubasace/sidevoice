const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');

function setup(){
 let now=3000;const sent=[];
 const context=vm.createContext({
  console,Float32Array,Int16Array,ArrayBuffer,DOMException,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail}},
  performance:{now:()=>now},crypto:{randomUUID:()=> 'turn-1'},WebSocket:{OPEN:1},Worker:class{},
  window:{dispatchEvent(){},sidevoiceSessionId:()=> 'session-1'},
 });
 vm.runInContext(fs.readFileSync(__dirname+'/browser_audio/stt-client.js','utf8'),context);
 const client=context.window.roomTranscription;client.runtime={model:'model',device:'webgpu'};client.socket={readyState:1,send:value=>sent.push(JSON.parse(value))};
 return {client,sent,setNow:value=>now=value};
}

test('silence received during inference does not discard and repeat a final transcript',async()=>{
 const {client,sent}=setup(),voice=new Float32Array(1600);voice.fill(.2);
 client.turn={id:'turn-1',chunks:[voice],samples:voice.length,lastVoice:0,voiceRevision:1,transcribing:false,sequence:0};
 let requests=0;client._request=async()=>{requests++;const silence=new Float32Array(320);client.turn.chunks.push(silence);client.turn.samples+=silence.length;return {text:'Hola',elapsed_ms:100,device:'webgpu',model:'model'}};
 await client._finish();
 assert.equal(requests,1);
 assert.deepEqual(sent.map(item=>item.type),['voice-input-transcript','voice-input-end']);
 assert.equal(sent[0].data.text,'Hola');
 assert.equal(client.turn,null);
});

test('new voiced audio invalidates an in-flight snapshot',async()=>{
 const {client,sent,setNow}=setup(),voice=new Float32Array(1600);
 client.turn={id:'turn-1',chunks:[voice],samples:voice.length,lastVoice:0,voiceRevision:1,transcribing:false,sequence:0};
 client._request=async()=>{client.turn.voiceRevision++;client.turn.lastVoice=2900;setNow(3000);return {text:'Prematuro',elapsed_ms:100,device:'webgpu',model:'model'}};
 await client._finish();
 assert.deepEqual(sent,[]);
 assert.equal(client.turn.transcribing,false);
});
