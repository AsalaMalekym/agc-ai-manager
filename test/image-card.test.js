import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {Resvg} from '@resvg/resvg-wasm';
import {initCardRenderer,cardCopy,renderImageCard,rasterSize} from '../src/image-card.js';
import {fixturePNG} from './image-fixture.js';
import {CARD_FONTS} from '../src/card-fonts.js';
await initCardRenderer(readFileSync(new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm',import.meta.url)));
const copy={headline:'Разработчики рассказали, как создавали остров из бумажных макетов',label:'ИГРОВОЙ ФАКТ',topic:'fact'};
function decode(bytes){const r=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024"><image width="1024" height="1024" xlink:href="data:image/png;base64,${Buffer.from(bytes).toString('base64')}"/></svg>`);const out=r.render();const pixels=new Uint8Array(out.pixels);out.free();r.free();return pixels;}
test('card text comes from the checked headline, never the sources or invented image claims',()=>{
 const draft={topic:'news',headline:'Патч добавит новый остров',text:'Новости\nДругой текст\nИсточник: Xbox\nhttps://example.com\n#новости'};
 assert.equal(cardCopy(draft).headline,draft.headline);
 assert.equal(cardCopy({topic:'meme',text:'😄 Игровой мем · вымышленная ситуация\n\n🎮 Игрок: берегу зелье.\n📌 Титры: всё ещё берегу.\n\n#ИгровыеМемы'}).headline,'Игрок: берегу зелье. Титры: всё ещё берегу.');
 assert.throws(()=>cardCopy({topic:'news',text:'Новости\nhttps://evil.test'}),/COPY_INVALID/);
});
test('empty, transparent, malformed and unreasonable images cannot be uploaded as cards',async()=>{
 await assert.rejects(()=>renderImageCard(fixturePNG(true),'image/png',copy),/IMAGE_BLANK/);
 await assert.rejects(()=>renderImageCard(fixturePNG(false,true),'image/png',copy),/IMAGE_BLANK/);
 const corrupt=fixturePNG().slice(0,30);await assert.rejects(()=>renderImageCard(corrupt,'image/png',copy),/IMAGE_BLANK/);
 for(const dimension of [1,255,2049,0xffffffff]){const b=fixturePNG();b.writeUInt32BE(dimension,16);assert.throws(()=>rasterSize(b,'image/png'),/DIMENSIONS_INVALID/);}
});
test('PNG card preserves artwork and renders Cyrillic as visible glyphs, not an empty text panel',async()=>{
 const png=await renderImageCard(fixturePNG(),'image/png',copy);assert.deepEqual(rasterSize(png,'image/png'),{width:1024,height:1024});
 const px=decode(png);let light=0,color=0;for(let y=100;y<950;y++)for(let x=64;x<930;x++){const p=(y*1024+x)*4;if(y>700&&px[p]>220&&px[p+1]>220&&px[p+2]>220)light++;if(y<500&&px[p+1]>80)color++;}
 assert.ok(light>5000,'Cyrillic glyphs must render');assert.ok(color>100000,'artwork must survive composition');
});
test('long meme, quote punctuation, Latin game titles and XML-like text remain bounded and render',async()=>{
 for(const headline of ['Baldur’s Gate 3: Larian Studios рассказала о разработке','Игрок: '+('Я сохраню это зелье на потом. '.repeat(18)), 'Новая игра <script> & "цитата" — это текст']){
  const png=await renderImageCard(fixturePNG(),'image/png',{...copy,headline,creative:true});assert.deepEqual(rasterSize(png,'image/png'),{width:1024,height:1024});
 }
 await assert.rejects(()=>renderImageCard(fixturePNG(),'image/png',{...copy,headline:'Очень длинный текст '.repeat(300)}),/OVERFLOW/);
});

test('Flux-style JPEG input becomes a valid PNG card without changing the verified headline',async()=>{
 const jpeg=Buffer.from(readFileSync(new URL('./fixtures/artwork.jpg.base64',import.meta.url),'utf8'),'base64');
 assert.deepEqual(rasterSize(jpeg,'image/jpeg'),{width:320,height:256});
 const png=await renderImageCard(jpeg,'image/jpeg',copy);assert.deepEqual(rasterSize(png,'image/png'),{width:1024,height:1024});
});

test('mixed-script typography uses real glyphs for Latin branding, Russian and punctuation',()=>{
 const paths=text=>{const r=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text y="60" font-family="AGC Latin, AGC Cyrillic" font-weight="700" font-size="40">${text}</text></svg>`,{font:{fontBuffers:CARD_FONTS.map(s=>Buffer.from(s,'base64')),defaultFontFamily:'AGC Latin'}});try{return r.toString().match(/ d="([^"]+)"/g)?.join('')||'';}finally{r.free();}};
 const missing=paths('\u0378');
 for(const char of 'AG|CNEWS0123456789НовостиЁ:?—·-'){
  const rendered=paths(char);assert.ok(rendered.length>20,char+' must have outlines');assert.notEqual(rendered,missing,char+' must not be a missing-glyph box');
 }
});

test('dilemma preserves both choices and meme cards use a distinct light panel',async()=>{
 const draft={topic:'discussion',question:'Быстрый матч или приключение: как проведёте вечер?',choiceOptions:['Матч с друзьями','Одиночная игра и исследование мира']};
 const c=cardCopy(draft);assert.deepEqual(c.options,draft.choiceOptions);assert.equal(c.headline,draft.question);
 const dark=decode(await renderImageCard(fixturePNG(),'image/png',c));
 let cyan=0,pink=0;for(let y=700;y<970;y++)for(let x=60;x<960;x++){const p=(y*1024+x)*4;if(x<490&&dark[p]<120&&dark[p+1]>180&&dark[p+2]>220)cyan++;if(x>530&&dark[p]>200&&dark[p+1]>100&&dark[p+1]<190&&dark[p+2]>220)pink++;}
 assert.ok(cyan>200&&pink>200,'both choice boxes must remain visible in the lower panel');
 const light=decode(await renderImageCard(fixturePNG(),'image/png',{...copy,topic:'meme',creative:true}));
 const p=(960*1024+500)*4;assert.ok(light[p]>220&&light[p+1]>220&&light[p+2]>200,'meme has a light readable panel');
});
