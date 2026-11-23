import test from 'node:test';
import assert from 'node:assert/strict';
import {startPhotoConnect} from '../client/photo-connect.js';
import worker from '../worker.js';
const secret='test-user-token-that-never-leaves-the-page';
function setup({embedded=true,scope='photos',result={response:{upload_url:'https://pu.vk.com/upload'}},appId='54914147'}={}){
 const elements={},calls=[],listeners={};let copied;
 const document={getElementById:id=>elements[id]||=( {value:'',hidden:false,disabled:false,focus(){},select(){}} )};
 const window={location:{search:'?vk_app_id='+appId},navigator:{clipboard:{writeText:async value=>{copied=value;}}},addEventListener:(name,fn)=>listeners[name]=fn};
 const bridge={isEmbedded:()=>embedded,send:async(method,params)=>{calls.push({method,params});if(method==='VKWebAppGetAuthToken')return {access_token:secret,scope};if(method==='VKWebAppCallAPIMethod'){if(result instanceof Error)throw result;return result;}return {};}};
 startPhotoConnect(bridge,document,window);return{elements,calls,listeners,bridge,copy:()=>copied};
}
test('photo connector asks only photos after explicit click and validates upload access without posting',async()=>{
 const {elements:e,calls,listeners,copy}=setup();assert.equal(calls.length,0);await e.connect.onclick();
 assert.deepEqual(calls.map(c=>c.method),['VKWebAppInit','VKWebAppGetAuthToken','VKWebAppCallAPIMethod']);
 assert.deepEqual(calls[1].params,{app_id:54914147,scope:'photos'});assert.equal(calls[2].params.method,'photos.getWallUploadServer');assert.equal(calls[2].params.params.group_id,243571492);
 assert.equal(e.token.value,secret);assert.equal(e.token.type,'password');assert.equal(e.result.hidden,false);
 await e.copy.onclick();assert.equal(copy(),secret);listeners.pagehide();assert.equal(e.token.value,'');assert.equal(e.result.hidden,true);
});
test('direct visits, wrong app, missing scope and API errors never reveal a usable token',async()=>{
 for(const options of [{embedded:false},{appId:'1'},{scope:'friends'},{result:{error:{error_code:1051,error_msg:secret}}},{result:{response:{}}}]){
  const {elements:e,calls}=setup(options);await e.connect.onclick();assert.equal(e.token.value,'');assert.equal(e.result.hidden,true);assert.ok(!e.status.textContent.includes(secret));
  if(options.embedded===false||options.appId==='1')assert.equal(calls.length,0);
 }
});
test('closing while awaiting VK prevents a late token from returning to the page',async()=>{
 const {elements:e,listeners,bridge}=setup(),send=bridge.send;
 bridge.send=async(m,p)=>{const r=await send(m,p);if(m==='VKWebAppCallAPIMethod')listeners.pagehide();return r;};
 await e.connect.onclick();assert.equal(e.token.value,'');assert.equal(e.result.hidden,true);
});
test('helper can be framed only by VK, serves bundled script and never exposes admin APIs',async()=>{
 const r=await worker.fetch(new Request('https://test/photo-connect'),{});assert.equal(r.status,200);const html=await r.text();assert.match(html,/54914147/);assert.match(html,/VK_PHOTO_TOKEN/);
 assert.match(r.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(r.headers.get('content-security-policy'),/frame-ancestors https:\/\/vk.com/);assert.equal(r.headers.get('cache-control'),'no-store');
 const js=await worker.fetch(new Request('https://test/photo-connect.js'),{});assert.equal(js.status,200);assert.match(await js.text(),/VKWebAppGetAuthToken/);
 const admin=await worker.fetch(new Request('https://test/api/status'),{});assert.equal(admin.status,401);
});
