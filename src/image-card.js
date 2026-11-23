import {initWasm,Resvg} from '@resvg/resvg-wasm';
import {CARD_FONTS} from './card-fonts.js';
import {limitEmoji} from './post-format.js';

const LABELS={news:'ИГРОВЫЕ НОВОСТИ',release:'РЕЛИЗЫ И ОБНОВЛЕНИЯ',fact:'ИГРОВОЙ ФАКТ',overview:'ОБ ИГРЕ',selection:'ПОДБОРКА ИГР',esports:'КИБЕРСПОРТ',technology:'ИГРОВЫЕ ТЕХНОЛОГИИ',development:'КАК СОЗДАЮТ ИГРЫ',culture:'ИГРОВАЯ КУЛЬТУРА',analysis:'РАЗБОР ИИ',meme:'ИГРОВОЙ МЕМ',discussion:'ОБСУДИМ?'};
let ready,fonts;
export async function initCardRenderer(module) {
  if(!ready)ready=(async()=>{
    await initWasm(module || (await import('@resvg/resvg-wasm/index_bg.wasm')).default);
    fonts=CARD_FONTS.map(s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)));
  })();
  return ready;
}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const clean=s=>limitEmoji(String(s),0).replace(/#[\p{L}\p{N}_]+/gu,'').replace(/\s+/gu,' ').trim();
export function cardCopy(draft) {
  // Reuse already checked copy; do not ask a model to invent image claims.
  const creative=['meme','discussion'].includes(draft.topic);
  const lines=String(draft.text||'').split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const headline=clean(draft.headline || (creative?lines.slice(1).filter(s=>!s.startsWith('#')).join(' '):lines[1]));
  if(!headline || headline.length>650 || /https?:\/\//i.test(headline))throw Error('IMAGE_CARD_COPY_INVALID');
  return {headline,label:LABELS[draft.topic]||'МИР ВИДЕОИГР',creative,topic:draft.topic};
}
function renderer(svg){return new Resvg(svg,{font:{fontBuffers:fonts,defaultFontFamily:'Roboto'},imageRendering:0});}
export function rasterSize(bytes,mime){
  let width=0,height=0;
  if(mime==='image/png'&&bytes.length>=24){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);width=v.getUint32(16);height=v.getUint32(20);}
  else if(mime==='image/jpeg'){
    for(let p=2;p+8<bytes.length;){
      if(bytes[p++]!==255)continue;let marker=bytes[p++];while(marker===255&&p<bytes.length)marker=bytes[p++];
      if(marker===217||marker===218)break;if(marker===216||marker===1||(marker>=208&&marker<=215))continue;
      const length=(bytes[p]<<8)|bytes[p+1];if(length<2||p+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=(bytes[p+3]<<8)|bytes[p+4];width=(bytes[p+5]<<8)|bytes[p+6];break;}p+=length;
    }
  }
  if(width<256||height<256||width>2048||height>2048)throw Error('IMAGE_DIMENSIONS_INVALID');
  return {width,height};
}
function verifyArtwork(dataURL){
  // Actually decode to a small raster. Invalid/transparent/flat images must not
  // silently become a text card with an empty background.
  const r=renderer(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><image xlink:href="${dataURL}" width="64" height="64" preserveAspectRatio="none"/></svg>`);let rendered;
  try{
    rendered=r.render();const px=rendered.pixels;let visible=0,sum=0,squares=0;const colors=new Set();
    for(let i=0;i<px.length;i+=4){if(px[i+3]<240)continue;visible++;const l=(px[i]+px[i+1]+px[i+2])/3;sum+=l;squares+=l*l;colors.add((px[i]>>4)*256+(px[i+1]>>4)*16+(px[i+2]>>4));}
    if(visible<4000||colors.size<4||squares/visible-(sum/visible)**2<16)throw Error('IMAGE_BLANK');
  }finally{rendered?.free();r.free();}
}
function measure(text,size){
  const r=renderer(`<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text x="0" y="120" font-family="Roboto" font-weight="700" font-size="${size}">${escape(text)}</text></svg>`);
  let box;try{box=r.innerBBox();return box?.width||0;}finally{box?.free();r.free();}
}
function fitLines(text,maxHeight){
  const words=text.split(/\s+/),cache=new Map();
  const width=(s,size)=>{const k=size+':'+s;if(!cache.has(k))cache.set(k,measure(s,size));return cache.get(k);};
  for(let size=62;size>=22;size-=2){
    const lines=[];let line='';
    for(const word of words){
      if(width(word,size)>864){
        if(line){lines.push(line);line='';}
        for(const char of word){if(width(line+char,size)>864){lines.push(line);line='';}line+=char;}
      }else if(line&&width(line+' '+word,size)>864){lines.push(line);line=word;}else line+=(line?' ':'')+word;
    }
    if(line)lines.push(line);
    if(lines.length*size*1.18<=maxHeight)return {lines,size};
  }
  throw Error('IMAGE_CARD_TEXT_OVERFLOW');
}
export async function renderImageCard(bytes,mime,copy) {
  rasterSize(bytes,mime);
  await initCardRenderer();
  const {lines,size}=fitLines(copy.headline,copy.creative?480:340);
  const panelHeight=Math.max(320,lines.length*size*1.18+190),top=1024-panelHeight;
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const dataURL=`data:${mime};base64,${btoa(binary)}`;
  verifyArtwork(dataURL);
  const colors=copy.topic==='esports'?['#ffb433','#ff604b']:copy.topic==='fact'?['#42edcf','#3996ff']:['#b36aff','#607bff'];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024">
  <defs><linearGradient id="panel" x2="0" y2="1"><stop stop-color="#0b1024" stop-opacity="0.9"/><stop offset="1" stop-color="#070a18"/></linearGradient><linearGradient id="accent"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
  <rect width="1024" height="1024" fill="#0b1024"/>
  <image xlink:href="${dataURL}" width="1024" height="1024" preserveAspectRatio="xMidYMid slice"/>
  <rect x="44" y="36" width="240" height="58" rx="18" fill="#080c20" fill-opacity="0.85"/>
  <text x="66" y="75" fill="white" font-family="Roboto" font-weight="700" font-size="30">AG|C <tspan fill="${colors[0]}">NEWS</tspan></text>
  <rect y="${top}" width="1024" height="${panelHeight}" fill="url(#panel)"/>
  <rect x="64" y="${top+30}" width="72" height="6" rx="3" fill="url(#accent)"/>
  <text x="64" y="${top+74}" fill="${colors[0]}" font-family="Roboto" font-weight="700" font-size="23" letter-spacing="2">${escape(copy.label)}</text>
  ${lines.map((line,i)=>`<text x="64" y="${top+110+size+i*size*1.18}" fill="white" font-family="Roboto" font-weight="700" font-size="${size}">${escape(line)}</text>`).join('')}
  <text x="64" y="990" fill="#adb6d2" font-family="Roboto" font-weight="700" font-size="17">ИИ-ИЛЛЮСТРАЦИЯ · ${copy.creative?'ИГРОВАЯ СИТУАЦИЯ':'НЕ СКРИНШОТ ИГРЫ'}</text>
  <rect x="960" y="${top+48}" width="6" height="${Math.max(100,panelHeight-110)}" rx="3" fill="url(#accent)"/>
  </svg>`;
  const r=renderer(svg);let image;
  try{image=r.render();return new Uint8Array(image.asPng());}finally{image?.free();r.free();}
}
