import {build as esbuild} from 'esbuild';
import {readFileSync} from 'node:fs';
export const build=options=>esbuild({...options,plugins:[{name:'card-wasm',setup(b){b.onResolve({filter:/@resvg\/resvg-wasm\/index_bg\.wasm$/},()=>({path:'./card.wasm',external:true}));}}]});
export const workerModules=bundle=>[
 {type:'ESModule',path:new URL('../worker.js',import.meta.url).pathname,contents:bundle.outputFiles[0].text},
 {type:'CompiledWasm',path:new URL('../card.wasm',import.meta.url).pathname,contents:readFileSync(new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm',import.meta.url))}
];
