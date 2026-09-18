const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');

function wavBase64(samples,rate=16000,channels=1){
 const data=new Int16Array(samples),bytes=new Uint8Array(44+data.byteLength),view=new DataView(bytes.buffer);
 const text=(offset,value)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i)};
 text(0,'RIFF');view.setUint32(4,36+data.byteLength,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,rate,true);view.setUint32(28,rate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,data.byteLength,true);
 bytes.set(new Uint8Array(data.buffer),44);
 return Buffer.from(bytes).toString('base64');
}
function setup(){
 let now=3000;const sent=[];
 const context=vm.createContext({
  console,Float32Array,Int16Array,Uint8Array,DataView,ArrayBuffer,DOMException,atob:value=>Buffer.from(value,'base64').toString('binary'),
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail}},
  performance:{now:()=>now},WebSocket:{OPEN:1},Worker:class{},
  window:{dispatchEvent(){},sidevoiceSessionId:()=> 'session-1'},
 });
 vm.runInContext(fs.readFileSync(__dirname+'/stt-client.js','utf8'),context);
 const client=context.window.roomTranscription;client.runtime={model:'model',device:'webgpu'};
 client.start({socket:{readyState:1,send:value=>sent.push(JSON.parse(value))},language:'auto'});
 return {client,sent,context,setNow:value=>now=value};
}

test('a finished turn from the room is transcribed and answered with its metrics',async()=>{
 const {client,sent,setNow}=setup();let received;
 client._request=async(type,data)=>{received={type,...data};setNow(3250);return {text:'Hola desde el navegador',elapsed_ms:120,device:'webgpu',model:'model'}};
 await client.transcribe({request_id:'req-1',audio_base64:wavBase64(new Array(16000).fill(1000)),language:null});
 assert.equal(received.type,'transcribe');assert.equal(received.model,'model');assert.equal(received.language,'auto');
 assert.equal(new Float32Array(received.audio).length,16000);
 assert.deepEqual(sent.map(item=>item.type),['voice-transcript']);
 assert.equal(sent[0].data.request_id,'req-1');assert.equal(sent[0].data.session_id,'session-1');
 assert.equal(sent[0].data.text,'Hola desde el navegador');
 assert.deepEqual({...sent[0].data.metrics},{audio_ms:1000,recognition_ms:120,request_to_transcript_ms:250,device:'webgpu',model:'model'});
});

test('the room language wins over the browser default and a resampled WAV keeps its duration',async()=>{
 const {client,sent}=setup();let received;
 client._request=async(type,data)=>{received=data;return {text:'Bonjour',elapsed_ms:10,device:'webgpu',model:'model'}};
 await client.transcribe({request_id:'req-2',audio_base64:wavBase64(new Array(48000).fill(0),48000),language:'fr'});
 assert.equal(received.language,'fr');
 assert.equal(new Float32Array(received.audio).length,16000);
 assert.equal(sent[0].data.metrics.audio_ms,1000);
});

test('degenerate symbol repetition is reported instead of reaching the agent',async()=>{
 const {client,sent}=setup();
 client._request=async()=>({text:'* '.repeat(200),elapsed_ms:100,device:'webgpu',model:'model'});
 await client.transcribe({request_id:'req-3',audio_base64:wavBase64(new Array(1600).fill(0))});
 assert.deepEqual(sent.map(item=>item.type),['voice-transcript-error']);
 assert.equal(sent[0].data.request_id,'req-3');
 assert.match(sent[0].data.error,/degenerada/);
});

test('an unprepared model answers with an error rather than silence',async()=>{
 const {client,sent}=setup();client.runtime=null;
 await client.transcribe({request_id:'req-4',audio_base64:wavBase64(new Array(1600).fill(0))});
 assert.deepEqual(sent.map(item=>item.type),['voice-transcript-error']);
 assert.match(sent[0].data.error,/no está preparado/);
});

test('stopping the provider drops an in-flight answer and rejects pending work',async()=>{
 const {client,sent}=setup();
 client._request=()=>new Promise(resolve=>setTimeout(()=>resolve({text:'Tarde',elapsed_ms:1,device:'webgpu',model:'model'}),5));
 const pending=client.transcribe({request_id:'req-5',audio_base64:wavBase64(new Array(1600).fill(0))});
 client.stop();
 await pending;
 assert.deepEqual(sent,[]);
 assert.equal(client.enabled,false);
});
