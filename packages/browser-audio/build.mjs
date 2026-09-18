import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {build} from 'esbuild';
import {mkdir,copyFile,readdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const out=new URL('./dist/',import.meta.url);await mkdir(new URL('./assets/',out),{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('./worker.js',import.meta.url))],outfile:fileURLToPath(new URL('./worker.js',out)),bundle:true,format:'esm',platform:'browser',external:['/voice-browser/assets/espeak-ng.js'],define:{'process.env.NODE_ENV':'"production"'},minify:true});
await build({entryPoints:[fileURLToPath(new URL('./stt-worker.js',import.meta.url))],outfile:fileURLToPath(new URL('./stt-worker.js',out)),bundle:true,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},minify:true});
for(const name of ['espeak-ng.js','espeak-ng.wasm'])await copyFile(join(dirname(require.resolve('espeak-ng/package.json')),'dist',name),new URL('./assets/'+name,out));
const ort=dirname(require.resolve('onnxruntime-web'));
for(const name of await readdir(ort))if(/\.wasm$|\.mjs$/.test(name))await copyFile(join(ort,name),new URL('./assets/'+name,out));
await copyFile(new URL('./index.html',import.meta.url),new URL('./index.html',out));

await copyFile(new URL('./room-client.js',import.meta.url),new URL('./room-client.js',out));

await copyFile(new URL('./room-i18n.js',import.meta.url),new URL('./room-i18n.js',out));
await copyFile(new URL('./stt-client.js',import.meta.url),new URL('./stt-client.js',out));
