import {wallPhotoUploadURL} from './services.js';
export const PHOTO_APP_ID='54914147';
const REDIRECT='https://oauth.vk.com/blank.html';
const encoder=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function secret(env){if(typeof env.VK_APP_SECRET!=='string'||env.VK_APP_SECRET.trim().length<8)throw Error('VK_APP_SECRET_MISSING');return env.VK_APP_SECRET.trim();}
async function key(env){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode('AGC-photo-auth-v1:'+secret(env))),'AES-GCM',false,['encrypt','decrypt']);}
async function seal(env,token){const iv=crypto.getRandomValues(new Uint8Array(12));return {iv:b64(iv),cipher:b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),encoder.encode(token))))};}
export async function photoEnvironment(store,env){
 const record=await store.get('photoCredential');if(!record)return env;
 if(record.expiresAt!==null&&record.expiresAt<=Date.now())throw Error('PHOTO_TOKEN_EXPIRED');
 try {const token=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(record.iv)},await key(env),unb64(record.cipher)));return {...env,VK_PHOTO_TOKEN:token};}
 catch{throw Error('PHOTO_TOKEN_DECRYPT_FAILED');}
}
export async function startPhotoAuth(store,env){
 secret(env);const state=b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 await store.put('photoAuthPending',{state,expiresAt:Date.now()+600000});
 const url=new URL('https://oauth.vk.com/authorize');url.search=new URLSearchParams({client_id:PHOTO_APP_ID,display:'page',redirect_uri:REDIRECT,scope:'photos',response_type:'code',v:'5.199',state}).toString();
 return {ok:true,authorizeUrl:url.href};
}
function parseRedirect(value){
 if(typeof value!=='string'||value.length>8192)throw Error('PHOTO_AUTH_URL_INVALID');
 let url;try{url=new URL(value.trim());}catch{throw Error('PHOTO_AUTH_URL_INVALID');}
 if(url.protocol!=='https:'||!['oauth.vk.com','oauth.vk.ru'].includes(url.hostname)||url.pathname!=='/blank.html'||url.username||url.password||url.port)throw Error('PHOTO_AUTH_URL_INVALID');
 const params=new URLSearchParams(url.hash?url.hash.slice(1):url.search);
 if(params.has('error'))throw Error('PHOTO_AUTH_DENIED');
 const code=params.get('code'),state=params.get('state');
 if(params.getAll('code').length!==1||params.getAll('state').length!==1||!code||!/^[A-Za-z0-9._~-]{8,2048}$/.test(code)||!state)throw Error('PHOTO_AUTH_URL_INVALID');
 return {code,state};
}
export async function finishPhotoAuth(store,env,value){
 const appSecret=secret(env),{code,state}=parseRedirect(value);
 // Consume once before any network request: parallel submissions cannot reuse a code.
 await store.transaction(async tx=>{const pending=await tx.get('photoAuthPending');if(!pending||pending.expiresAt<Date.now()||pending.state!==state)throw Error('PHOTO_AUTH_STATE_INVALID');await tx.delete('photoAuthPending');});
 const response=await fetch('https://oauth.vk.com/access_token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),body:new URLSearchParams({client_id:PHOTO_APP_ID,client_secret:appSecret,redirect_uri:REDIRECT,code})});
 if(!response.ok)throw Error('PHOTO_AUTH_EXCHANGE_FAILED');
 const data=await response.json();
 if(data.error){const errors={invalid_client:'PHOTO_AUTH_CLIENT_REJECTED',invalid_grant:'PHOTO_AUTH_CODE_EXPIRED',invalid_request:'PHOTO_AUTH_REQUEST_REJECTED'};throw Error(errors[data.error]||'PHOTO_AUTH_EXCHANGE_FAILED');}
 if(typeof data.access_token!=='string'||data.access_token.length<20||data.access_token.length>4096||!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<0)throw Error('PHOTO_AUTH_RESPONSE_INVALID');
 const issuedAt=Date.now(),expiresAt=Number(data.expires_in)===0?null:issuedAt+Number(data.expires_in)*1000;
 // Read-only verification uses the very server that obtained the token.
 await wallPhotoUploadURL({...env,VK_PHOTO_TOKEN:data.access_token});
 const encrypted=await seal(env,data.access_token);
 await store.transaction(async tx=>{
  await tx.put('photoCredential',{...encrypted,issuedAt,expiresAt});
  const previous=await tx.get('imageState')||{};
  await tx.put('imageState',{...previous,tokenKind:'server',uploadVerified:true,checkedAt:Date.now(),lastError:null,authReason:null,diagnosticsVersion:1,nextAttempt:0});
 });
 return {ok:true,uploadVerified:true,expiresAt};
}
