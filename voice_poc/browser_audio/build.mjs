import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {mkdir,copyFile,readdir} from 'node:fs/promises';
const out=new URL('./dist/',import.meta.url);await mkdir(new URL('./assets/',out),{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('./worker.js',import.meta.url))],outfile:fileURLToPath(new URL('./worker.js',out)),bundle:true,format:'esm',platform:'browser',external:['/voice-browser/assets/espeak-ng.js'],define:{'process.env.NODE_ENV':'"production"'},minify:true});
await build({entryPoints:[fileURLToPath(new URL('./stt-worker.js',import.meta.url))],outfile:fileURLToPath(new URL('./stt-worker.js',out)),bundle:true,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},minify:true});
for(const name of ['espeak-ng.js','espeak-ng.wasm'])await copyFile(new URL('./node_modules/espeak-ng/dist/'+name,import.meta.url),new URL('./assets/'+name,out));
const ort=new URL('./node_modules/onnxruntime-web/dist/',import.meta.url);
for(const name of await readdir(ort))if(/\.wasm$|\.mjs$/.test(name))await copyFile(new URL(name,ort),new URL('./assets/'+name,out));
await copyFile(new URL('./index.html',import.meta.url),new URL('./index.html',out));

await copyFile(new URL('./room-client.js',import.meta.url),new URL('./room-client.js',out));

await copyFile(new URL('./room-i18n.js',import.meta.url),new URL('./room-i18n.js',out));
await copyFile(new URL('./stt-client.js',import.meta.url),new URL('./stt-client.js',out));
