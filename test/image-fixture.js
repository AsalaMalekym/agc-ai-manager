// Nonblank synthetic raster for decoding/composition tests, not generated art.
import {deflateSync} from 'node:zlib';
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const payload=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);payload.copy(out,4);out.writeUInt32BE(crc(payload),out.length-4);return out;}
export function fixturePNG(flat=false,transparent=false){
 const size=256,header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
 const raw=Buffer.alloc(size*(size*4+1));for(let y=0;y<size;y++)for(let x=0;x<size;x++){const p=y*(size*4+1)+1+x*4;raw[p+3]=transparent?0:255;raw[p]=flat?90:x;raw[p+1]=flat?90:y;raw[p+2]=flat?90:((x>>4)^(y>>4))*16;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export const imageFixture=fixturePNG().toString('base64');
