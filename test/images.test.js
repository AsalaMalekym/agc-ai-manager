import test from 'node:test';
import assert from 'node:assert/strict';
import {createImagePrompt} from '../src/images.js';
import {validUploadURL,imageAttachment,vk} from '../src/services.js';
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
