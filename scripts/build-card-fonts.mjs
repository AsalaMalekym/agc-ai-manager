import {readFile,writeFile} from 'node:fs/promises';
import wawoff2 from 'wawoff2';
// Give subsets separate families: fontdb otherwise selects one same-name face
// and cannot fall back from Cyrillic to Latin punctuation (or vice versa).
function renameFamily(input,family){
  const font=Buffer.from(input);let nameRecord,headOffset;
  for(let i=0;i<font.readUInt16BE(4);i++){const p=12+i*16,tag=font.toString('ascii',p,p+4);if(tag==='name')nameRecord=p;if(tag==='head')headOffset=font.readUInt32BE(p+8);}
  if(nameRecord===undefined||headOffset===undefined)throw Error('Invalid font tables');
  const start=font.readUInt32BE(nameRecord+8),count=font.readUInt16BE(start+2),strings=start+font.readUInt16BE(start+4);
  const header=Buffer.alloc(6+count*12),parts=[];header.writeUInt16BE(count,2);header.writeUInt16BE(header.length,4);let length=0;
  for(let i=0;i<count;i++){
    const p=start+6+i*12,target=6+i*12,id=font.readUInt16BE(p+6),platform=font.readUInt16BE(p);
    font.copy(header,target,p,p+12);
    let value=font.subarray(strings+font.readUInt16BE(p+10),strings+font.readUInt16BE(p+10)+font.readUInt16BE(p+8));
    const replacement=[1,16].includes(id)?family:id===6?family.replaceAll(' ','')+'-Bold':id===4?family+' Bold':null;
    if(replacement){value=Buffer.from(replacement,platform===0||platform===3?'utf16le':'ascii');if(platform===0||platform===3)value.swap16();}
    header.writeUInt16BE(value.length,target+8);header.writeUInt16BE(length,target+10);parts.push(value);length+=value.length;
  }
  const name=Buffer.concat([header,...parts]),offset=(font.length+3)&~3,out=Buffer.alloc(offset+((name.length+3)&~3));font.copy(out);name.copy(out,offset);
  const checksum=(b,start,end)=>{let sum=0;for(let p=start;p<end;p+=4)sum=(sum+b.readUInt32BE(p))>>>0;return sum;};
  out.writeUInt32BE(offset,nameRecord+8);out.writeUInt32BE(name.length,nameRecord+12);out.writeUInt32BE(checksum(out,offset,out.length),nameRecord+4);
  out.writeUInt32BE(0,headOffset+8);out.writeUInt32BE((0xb1b0afba-checksum(out,0,out.length))>>>0,headOffset+8);return out;
}
const fonts=[];
// The WASM decompressor shares memory; copy each result before the next call.
for(const subset of ['latin','cyrillic']){
  const bytes=Buffer.from(await wawoff2.decompress(await readFile(new URL(`../node_modules/@fontsource/roboto/files/roboto-${subset}-700-normal.woff2`,import.meta.url))));
  if(bytes.readUInt32BE(0)!==0x00010000)throw Error('Invalid decoded font');
  fonts.push(renameFamily(bytes,subset==='latin'?'AGC Latin':'AGC Cyrillic').toString('base64'));
}
await writeFile(new URL('../src/card-fonts.js',import.meta.url),'// Generated Roboto 700 subsets, SIL OFL 1.1; source: @fontsource/roboto.\nexport const CARD_FONTS = '+JSON.stringify(fonts)+';\n');
