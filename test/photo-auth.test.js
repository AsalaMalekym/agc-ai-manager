import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {startPhotoAuth,finishPhotoAuth,photoEnvironment} from '../src/photo-auth.js';
import {PHOTO_SERVER_HTML} from '../src/photo-server.js';
import {ManagerState} from '../src/manager.js';
import worker from '../worker.js';
class Store {
 constructor(){this.data=new Map();this.tail=Promise.resolve();}
 async get(k){return structuredClone(this.data.get(k));}
 async put(k,v){this.data.set(k,structuredClone(v));}
 async delete(k){this.data.delete(k);}
 transaction(fn){const p=this.tail.then(()=>fn(this));this.tail=p.catch(()=>{});return p;}
}
const env={VK_APP_SECRET:'private-app-secret',VK_PHOTO_TOKEN:'old-photo',VK_TOKEN:'community',VK_GROUP_ID:'123',ENVIRONMENT:'production',KILL_SWITCH:'off',GENERATE_IMAGES:'on',AI:{}};
const token='private-server-photo-token-do-not-expose';
async function redirect(store,options=env){const s=await startPhotoAuth(store,options),state=new URL(s.authorizeUrl).searchParams.get('state');return 'https://oauth.vk.ru/blank.html#'+new URLSearchParams({code:'one-use-code',state});}
function mock(t,{failure=false,expires=3600}={}){const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),options});if(String(url).includes('/access_token'))return Response.json({access_token:token,expires_in:expires,user_id:42});return Response.json(failure?{error:{error_code:5,error_msg:'access_token was given to another ip address SECRET'}}:{response:{upload_url:'https://pu.vk.com/upload'}});});return calls;}
test('server OAuth exchanges code privately, verifies group, encrypts token, and uses it only for photo environment',async t=>{
 const store=new Store(),calls=mock(t),url=await redirect(store);const result=await finishPhotoAuth(store,env,url);
 assert.equal(result.ok,true);assert.ok(result.expiresAt>Date.now());assert.equal(calls.length,2);
 assert.equal(calls[0].url,'https://oauth.vk.com/access_token');assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.body.get('client_secret'),env.VK_APP_SECRET);assert.equal(calls[0].options.body.get('code'),'one-use-code');
 assert.equal(calls[1].options.body.get('access_token'),token);assert.equal(calls[1].options.body.get('group_id'),'123');
 assert.ok(!JSON.stringify([...store.data]).includes(token));assert.ok(!JSON.stringify([...store.data]).includes('one-use-code'));
 const imageEnv=await photoEnvironment(store,env);assert.equal(imageEnv.VK_PHOTO_TOKEN,token);assert.equal(imageEnv.VK_TOKEN,'community');assert.equal(env.VK_PHOTO_TOKEN,'old-photo');
 const manager=new ManagerState({storage:store},env),status=await manager.imageStatus();assert.equal(status.tokenKind,'server');assert.equal(status.serverTokenConfigured,true);assert.ok(!JSON.stringify(status).includes(token));
 await assert.rejects(()=>finishPhotoAuth(store,env,url),/PHOTO_AUTH_STATE_INVALID/);assert.equal(calls.length,2);
});
test('missing secret, wrong origin/state, expiry and duplicate submission do not exchange credentials',async t=>{
 const store=new Store(),calls=mock(t);await assert.rejects(()=>startPhotoAuth(store,{}),/VK_APP_SECRET_MISSING/);
 const url=await redirect(store);await assert.rejects(()=>finishPhotoAuth(store,env,url.replace('oauth.vk.ru','evil.example')),/PHOTO_AUTH_URL_INVALID/);
 const wrong=new URL(url);wrong.hash=new URLSearchParams({code:'one-use-code',state:'wrong'}).toString();await assert.rejects(()=>finishPhotoAuth(store,env,wrong.href),/PHOTO_AUTH_STATE_INVALID/);
 assert.equal(calls.length,0);
 const pending=await store.get('photoAuthPending');await store.put('photoAuthPending',{...pending,expiresAt:0});await assert.rejects(()=>finishPhotoAuth(store,env,url),/PHOTO_AUTH_STATE_INVALID/);
 const next=await redirect(store);const results=await Promise.allSettled([finishPhotoAuth(store,env,next),finishPhotoAuth(store,env,next)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls.length,2);
});
test('IP rejection leaves old credentials and state intact; expired or corrupted tokens fail closed',async t=>{
 const store=new Store();mock(t,{failure:true});await store.put('imageState',{tokenKind:'photo',lastError:'OLD'});
 const url=await redirect(store);await assert.rejects(()=>finishPhotoAuth(store,env,url),e=>e.message==='VK_API_5'&&e.authReason==='IP_RESTRICTED');assert.equal(await store.get('photoCredential'),undefined);assert.equal((await store.get('imageState')).lastError,'OLD');
 t.mock.restoreAll();mock(t);await finishPhotoAuth(store,env,await redirect(store));const record=await store.get('photoCredential');
 await assert.rejects(()=>photoEnvironment(store,{...env,VK_APP_SECRET:'rotated-secret'}),/PHOTO_TOKEN_DECRYPT_FAILED/);
 await store.put('photoCredential',{...record,expiresAt:1});await assert.rejects(()=>photoEnvironment(store,env),/PHOTO_TOKEN_EXPIRED/);
 const manager=new ManagerState({storage:store},env);assert.equal((await manager.imageStatus()).active,false);assert.equal((await manager.imageStatus()).tokenExpired,true);
});
test('photo server page script parses and all exchange endpoints require admin authentication',async()=>{
 new vm.Script(PHOTO_SERVER_HTML.match(/<script>([\s\S]*?)<\/script>/)[1]);
 for(const path of ['/api/photo-auth/start','/api/photo-auth/finish']){const r=await worker.fetch(new Request('https://test'+path,{method:'POST',body:'{}'}),{...env,AGC_ADMIN_KEY:'a'.repeat(32)});assert.equal(r.status,401);}
 const page=await worker.fetch(new Request('https://test/photo-server'),env);assert.equal(page.status,200);assert.equal(page.headers.get('x-frame-options'),'DENY');assert.equal(page.headers.get('cache-control'),'no-store');
});
