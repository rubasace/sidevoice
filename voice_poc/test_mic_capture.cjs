const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
function load(contextRate){
 const posted=[],registered={};
 class AudioWorkletProcessor{constructor(){this.port={postMessage:data=>posted.push(data)}}}
 const context=vm.createContext({AudioWorkletProcessor,Float32Array,Int16Array,Math,sampleRate:contextRate,registerProcessor:(name,cls)=>registered[name]=cls});
 vm.runInContext(fs.readFileSync(__dirname+'/mic_capture.js','utf8'),context);
 return {run:code=>vm.runInContext(code,context),posted,registered};
}
const ramp=(start,n,slope)=>Float32Array.from({length:n},(_,i)=>start+i*slope);
test('Downsampling keeps a linear signal exact and continuous across block boundaries',()=>{
 const m=load(48000);const Resampler=m.run('Resampler');
 const whole=new Resampler(48000,16000).process(ramp(0,256,0.001));
 const split=new Resampler(48000,16000);const parts=[...split.process(ramp(0,128,0.001)),...split.process(ramp(0.128,128,0.001))];
 assert.equal(whole.length,parts.length);
 for(const [i,v] of whole.entries())assert.ok(Math.abs(v-parts[i])<1e-6,`sample ${i}`);
 for(let i=1;i<parts.length;i++)assert.ok(Math.abs((parts[i]-parts[i-1])-0.003)<1e-6,`step ${i}`);
 assert.ok(Math.abs(whole.length-256/3)<=1);
});
test('Equal rates pass the block through untouched and 44.1 kHz still lands on the target rate',()=>{
 const m=load(16000);const Resampler=m.run('Resampler');
 const block=ramp(0,128,0.01);assert.equal(new Resampler(16000,16000).process(block),block);
 const odd=new Resampler(44100,16000);let produced=0;for(let i=0;i<100;i++)produced+=odd.process(ramp(0,128,0)).length;
 assert.ok(Math.abs(produced-12800*16000/44100)<=2);
});
test('Samples clip to the int16 range without wrapping',()=>{
 const m=load(48000);const toInt16=m.run('toInt16');
 assert.deepEqual([...toInt16(Float32Array.from([0,1,-1,2,-2,0.5]))],[0,32767,-32768,32767,-32768,16383]);
});
test('The processor posts 20 ms chunks at the room rate and stays scheduled',()=>{
 const m=load(48000);const MicCapture=m.registered['mic-capture'];
 const processor=new MicCapture({processorOptions:{sampleRate:16000}});
 for(let i=0;i<24;i++)assert.equal(processor.process([[new Float32Array(128)]]),true);
 assert.equal(m.posted.length,3);
 for(const chunk of m.posted){assert.equal(chunk.byteLength,640);assert.ok(new Int16Array(chunk).every(v=>v===0))}
 assert.equal(processor.process([[]]),true);assert.equal(m.posted.length,3);
});
