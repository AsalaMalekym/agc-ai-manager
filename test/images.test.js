import test from 'node:test';
import assert from 'node:assert/strict';
import {createImagePrompt} from '../src/images.js';
import {validUploadURL,imageAttachment,vk} from '../src/services.js';
import {imageFixture} from './image-fixture.js';
const prompt='A stylized original gaming illustration showing a fictional adult explorer solving a glowing puzzle on a floating island.';
test('image prompt comes from the post and must pass validation and moderation',async()=>{
 const draft={topic:'news',text:'Проверенная новость об игре с островом и головоломками.'};
 const result=await createImagePrompt(draft,async(system,data)=>{assert.equal(data.text,draft.text);return {prompt};},async()=>({decision:'allow',confidence:1}));assert.match(result,/floating island/);
 await assert.rejects(()=>createImagePrompt(draft,async()=>({prompt:'https://evil.example '+prompt}),async()=>assert.fail()),/IMAGE_PROMPT_INVALID/);
 await assert.rejects(()=>createImagePrompt(draft,async()=>({prompt}),async()=>({decision:'review',confidence:1})),/IMAGE_PROMPT_REJECTED/);
});
test('upload hosts reject credentials, ports, non-HTTPS and lookalike domains',()=>{
 for(const value of ['http://pu.vk.com/u','https://pu.vk.com.evil.com/u','https://x:y@pu.vk.com/u','https://pu.vk.com:444/u','http://127.0.0.1/u','not a url'])assert.throws(()=>validUploadURL(value),/UPLOAD_HOST_REJECTED/);
 assert.equal(validUploadURL('https://pu.vk.com/u').hostname,'pu.vk.com');
});
test('invalid generator output is rejected before any upload',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('Invalid image must never be uploaded'));
 for(const image of ['not base64!',btoa('<html>Not an image</html>'),''])await assert.rejects(()=>imageAttachment({AI:{run:async()=>({image})}},prompt,{uploadURL:'https://pu.vk.com/u'}),/IMAGE_INVALID/);
});

test('VK auth diagnostics classify rejection without exposing response secrets',async t=>{
 let message='';t.mock.method(globalThis,'fetch',async()=>Response.json({error:{error_code:5,error_msg:message,request_params:[{value:'SECRET'}]}}));
 for(const [detail,reason] of [['access_token was given to another ip address','IP_RESTRICTED'],['access_token has expired','TOKEN_EXPIRED'],['invalid session','INVALID_SESSION'],['invalid access_token','INVALID_TOKEN'],['method is unavailable with server auth','TOKEN_CONTEXT_UNSUPPORTED'],['unknown SECRET','AUTH_FAILED']]){
  message=detail;await assert.rejects(()=>vk({VK_PHOTO_TOKEN:'SECRET'},'photos.getWallUploadServer'),e=>{assert.equal(e.message,'VK_API_5');assert.equal(e.authReason,reason);assert.ok(!JSON.stringify(e).includes('SECRET'));return true;});
 }
});

test('HTTP 500 upload rejection retries the same artwork once, without regenerating or saving twice',async t=>{
 let generated=0,uploaded=0,saved=0,composed=0,writes=0;const bodies=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).includes('photos.saveWallPhoto')){saved++;return Response.json({response:[{id:1,owner_id:-123}]});}
  uploaded++;bodies.push(new Uint8Array(await options.body.get('photo').arrayBuffer()));
  return uploaded===1?new Response('upstream SECRET',{status:500}):Response.json({server:1,photo:'photo',hash:'hash'});
 });
 const result=await imageAttachment({VK_PHOTO_TOKEN:'secret',AI:{run:async()=>{generated++;return {image:imageFixture};}}},prompt,{
  uploadURL:'https://pu.vk.com/upload',beforeWrite:async()=>{writes++;},compose:async bytes=>{composed++;return bytes;}
 });
 assert.equal(result,'photo-123_1');assert.equal(generated,1);assert.equal(composed,1);assert.equal(uploaded,2);assert.equal(saved,1);assert.equal(writes,3);assert.deepEqual(bodies[0],bodies[1]);
});
test('upload retries are bounded and error metadata never contains response body or signed URL',async t=>{
 let uploads=0;t.mock.method(globalThis,'fetch',async()=>{uploads++;return new Response('SECRET',{status:502});});
 await assert.rejects(()=>imageAttachment({AI:{run:async()=>({image:imageFixture})}},prompt,{uploadURL:'https://pu.vk.com/upload?secret=SECRET'}),error=>{
  assert.equal(error.message,'IMAGE_UPLOAD_FAILED');assert.equal(error.httpStatus,502);assert.equal(error.uploadAttempts,2);assert.ok(!JSON.stringify(error).includes('SECRET'));return true;
 });assert.equal(uploads,2);
});
test('permanent failures, redirects, rate limits and long Retry-After are not immediately retried',async t=>{
 let response,uploads=0;t.mock.method(globalThis,'fetch',async()=>{uploads++;return response;});
 for(const status of [302,400,401,403,413,429,503]){
  response=new Response('SECRET',{status,headers:{'retry-after':'120',location:'https://evil.example/'}});uploads=0;
  await assert.rejects(()=>imageAttachment({AI:{run:async()=>({image:imageFixture})}},prompt,{uploadURL:'https://pu.vk.com/upload'}),error=>error.httpStatus===status&&error.uploadAttempts===1);
  assert.equal(uploads,1);
 }
});
test('pause before the upload retry prevents further writes',async t=>{
 let uploads=0,checks=0;t.mock.method(globalThis,'fetch',async()=>{uploads++;return new Response('',{status:504});});
 await assert.rejects(()=>imageAttachment({AI:{run:async()=>({image:imageFixture})}},prompt,{uploadURL:'https://pu.vk.com/upload',beforeWrite:async()=>{if(++checks===2)throw Error('WRITES_DISABLED');}}),/WRITES_DISABLED/);
 assert.equal(uploads,1);
});
