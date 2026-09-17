#!/usr/bin/env node
/** Dev probe for the browser link, no microphone needed: opens the call socket, takes the call id the
 * room announces, streams two seconds of silence and checks that the room reports that call as
 * connected, then as disconnected once the socket closes.
 * Usage: node voice_poc/probe_browser_socket.mjs [http://127.0.0.1:8767] */
const base=(process.argv[2]||'http://127.0.0.1:8767').replace(/\/$/,'');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const room=async()=>(await fetch(base+'/api/presentation')).json();
let failures=0;
const check=(condition,label)=>{console.log((condition?'ok   ':'FAIL ')+label);if(!condition)failures++};

const socket=new WebSocket(base.replace(/^http/,'ws')+'/api/presentation/ws');
socket.binaryType='arraybuffer';
const received=[];
const session=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('no voice-session within 120 s')),120000);
 socket.onopen=()=>socket.send(JSON.stringify({label:'rtvi-ai',type:'client-ready',id:'probe',data:{}}));
 socket.onerror=()=>reject(new Error('socket error'));
 socket.onclose=event=>reject(new Error('closed before voice-session (code '+event.code+')'));
 socket.onmessage=event=>{const message=JSON.parse(event.data);received.push(message.type);if(message.type==='voice-session'){clearTimeout(timer);resolve(message.data)}};
});
socket.onclose=null;
check(received.at(-1)==='voice-session','the room announces voice-session after any preparation events');
check(typeof session.session_id==='string'&&session.session_id.length>0,'voice-session carries a call id: '+session.session_id);
const bytesPerFrame=session.sample_rate*session.channels*2/50;
for(let i=0;i<100;i++){socket.send(new ArrayBuffer(bytesPerFrame));await sleep(20)}
const during=await room();
check(during.call?.id===session.session_id&&during.call?.connected===true,'GET /api/presentation reports the announced call as connected');
check(!('ice_servers' in during),'the snapshot no longer advertises ICE servers');
socket.close();
await sleep(1500);
const after=await room();
check(after.call?.id===session.session_id&&after.call?.connected===false,'closing the socket disconnects that call');
console.log('room events seen while streaming:',received.join(', ')||'none');
process.exit(failures?1:0);
