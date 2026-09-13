import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

const room=process.env.VOICE_ROOM_URL||'http://127.0.0.1:8767';
const registry=process.env.VOICE_GATEWAY_DIR||fileURLToPath(new URL('../../.voice-poc/gateways/',import.meta.url));
const instance=randomUUID(), messages=new Map();
let owner=null,title=null,base=null,ready=false;
const instructions=await readFile(new URL('./instructions.md',import.meta.url),'utf8');
const mcp=new Server({name:'voice-room',version:'0.1.0'},{
 capabilities:{tools:{},experimental:{'claude/channel':{}}},instructions
});
const schemas=[
 {name:'activate',description:'Connect this actual Claude session to the voice room, only when requested.',inputSchema:{type:'object',properties:{session_id:{type:'string',description:'Actual CLAUDE_SESSION_ID supplied by the voice-presentation skill.'},title:{type:'string'}},required:['session_id','title']}},
 {name:'status',description:'Read voice room status. Does not activate or change focus.',inputSchema:{type:'object',properties:{}}},
 {name:'speak',description:'Publish a concise spoken presentation alongside the full normal written answer. Preserve incoming session_id and revision.',inputSchema:{type:'object',properties:{text:{type:'string'},session_id:{type:'string'},revision:{type:'integer',minimum:0},utterance_id:{type:'string'},language:{type:'string',enum:['es','en','fr','it','pt','hi']}},required:['text','session_id','revision','utterance_id','language']}}
];
async function request(path,body){
 const response=await fetch(room+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 const value=await response.json();if(!response.ok)throw Error(value.detail||'Voice room request failed');return value;
}
async function activate(){
 if(!owner)throw Error('Invoke /voice-presentation to bind this actual Claude session first.');
 return request('/api/presentation/activate',{thread_id:owner,title,gateway_url:base,gateway_instance:instance});
}
async function bind(session,name){
 if(!/^[a-f0-9-]{36}$/.test(session)||!name?.trim()||name.length>200)throw Error('Actual session UUID and a short title required');
 if(owner&&owner!==session)throw Error('This channel is already bound to another session');
 const file=registry+'/'+session+'.json';
 try{
  const prior=JSON.parse(await readFile(file,'utf8'));
  if(prior.instance_id!==instance){
   let identity;
   try{identity=await fetch(prior.url+'/identity',{signal:AbortSignal.timeout(1000)}).then(r=>r.json())}catch{}
   if(identity?.thread_id===session&&identity.instance_id===prior.instance_id)throw Error('This session already has a live voice channel; close that session before resuming it here.');
  }
 }catch(e){if(e.code!=='ENOENT')throw e}
 owner=session;title=name;
 await mkdir(registry,{recursive:true});
 const tmp=file+'.'+instance+'.tmp';
 await writeFile(tmp,JSON.stringify({thread_id:owner,title,url:base,instance_id:instance,harness:'claude'}),{mode:0o600});
 await rename(tmp,file);
 return activate();
}
mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:schemas}));
mcp.setRequestHandler(CallToolRequestSchema,async({params})=>{
 try{
  const a=params.arguments||{};let result;
  if(params.name==='activate')result=await bind(a.session_id,a.title);
  else if(params.name==='status')result=await request('/api/presentation');
  else if(params.name==='speak'){
   if(!owner)throw Error('Activate voice for this session first.');
   result=await request('/api/presentation/speak',{...a,thread_id:owner});
   result={status:'published',text_saved:result.text_saved===true};
  }else throw Error('Unknown tool');
  return {content:[{type:'text',text:JSON.stringify(result)}]};
 }catch(e){return {isError:true,content:[{type:'text',text:e.message}]}}
});
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>30000)throw Error('Request too large')}return JSON.parse(text)}
const listener=http.createServer(async(req,res)=>{
 const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
 try{
  if(req.headers.origin)return send(403,{error:'Use the local room server'});
  if(req.url==='/identity'&&req.method==='GET')return send(200,{thread_id:owner,instance_id:instance,harness:'claude',durable_delivery:true,room_control:true});
  if(req.url==='/activate'&&req.method==='POST')return send(200,await activate());
  if(req.url!=='/presentation/message'||req.method!=='POST')return send(404,{error:'Not found'});
  const input=await body(req);
  if(!ready||!owner||input.thread_id!==owner)return send(409,{error:'Wrong or disconnected Claude session'});
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000||typeof input.message_id!=='string'||!input.message_id||typeof input.session_id!=='string'||!Number.isSafeInteger(input.revision)||input.revision<0)throw Error('Invalid message');
  const key=input.message_id,fingerprint=JSON.stringify([input.thread_id,input.text,input.session_id,input.revision,input.channel]);
  const prior=messages.get(key);
  if(prior&&prior.fingerprint!==fingerprint)throw Error('Message ID reused with different content');
  if(!prior){
   const promise=mcp.notification({method:'notifications/claude/channel',params:{
    content:input.text,meta:{thread_id:owner,session_id:input.session_id,revision:String(input.revision),message_id:key,channel:input.channel==='room-control'?'room-control':'voice'}
   }});
   messages.set(key,{fingerprint,promise});
   if(messages.size>2048)messages.delete(messages.keys().next().value);
  }
  await messages.get(key).promise;
  return send(200,{status:'sent',message_id:key});
 }catch(e){return send(409,{error:e.message})}
});
await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
base='http://127.0.0.1:'+listener.address().port;
mcp.oninitialized=()=>{ready=true};
await mcp.connect(new StdioServerTransport());
async function cleanup(){
 ready=false;
 if(owner){const path=registry+'/'+owner+'.json';try{const saved=JSON.parse(await readFile(path,'utf8'));if(saved.instance_id===instance)await unlink(path)}catch{}}
 listener.close();process.exit(0);
}
process.stdin.on('end',cleanup);process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);
