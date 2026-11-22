import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { DEFAULT_SOCIAL, validateSocial, socialSources, parseTelegram, fetchSocial, parsePrimary, resolveEvidence, verifyLead, primarySource, secondaryURL } from '../src/social.js';
import { ManagerState } from '../src/manager.js';
import { newsId } from '../src/news.js';
import { DASHBOARD } from '../src/dashboard.js';
import worker from '../worker.js';
const now = Date.now();
const source = socialSources({telegram:['stopgamenews'],vk:[],x:[],bluesky:[]})[0];
const sourceURL = 'https://www.nintendo.com/us/whatsnew/new-island-game/';
const text = 'Nintendo announced a cooperative island adventure for two players.';
const body = text + ' Players explore a fictional island and solve environmental puzzles together. The studio describes these as planned features and does not announce a release date. No other platforms or regional prices are confirmed in this announcement. The game is currently in development and these features may change.';
const article = {sourceId:'nintendo-us',sourceName:'Nintendo',url:sourceURL,title:'New island adventure announced by Nintendo',body,publishedAt:now-1000};
const item = {...source,sourceId:source.id,sourceName:source.name,url:'https://t.me/stopgamenews/2',text,publishedAt:now-1000,links:[sourceURL],classification:{decision:'news',claims:[text],searchTerms:['Nintendo']},attempts:0,nextAttempt:0};
function html(date=new Date(now-1000).toISOString()) { return `<html><head><meta property="og:title" content="${article.title}"><meta property="article:published_time" content="${date}"></head><body><main><article><p>${body}</p></article></main></body></html>`; }
function telegram(id=1,date=new Date(now-1000).toISOString(),handle='stopgamenews') { return `<div class="tgme_widget_message text_not_supported" data-post="${handle}/${id}"><div class="tgme_widget_message_text js-message_text">${text}<br><a href="${sourceURL}">Source</a></div><a><time datetime="${date}"></time></a></div>`; }
class Storage {
 data=new Map(); alarm=null; tail=Promise.resolve();
 async get(k){return structuredClone(this.data.get(k));} async put(k,v){this.data.set(k,structuredClone(v));}
 async list({prefix='',limit=10000}={}){return new Map([...this.data].filter(([k])=>k.startsWith(prefix)).sort().slice(0,limit));}
 async delete(k){for(const key of Array.isArray(k)?k:[k])this.data.delete(key);} async getAlarm(){return this.alarm;} async setAlarm(v){this.alarm=v;}
 transaction(fn){const r=this.tail.then(()=>fn(this));this.tail=r.catch(()=>{});return r;}
}
function setup(extra={}) {const storage=new Storage(),env={ENVIRONMENT:'production',KILL_SWITCH:'off',AUTO_POST:'on',VK_GROUP_ID:'123',VK_TOKEN:'community',AGC_ADMIN_KEY:'a'.repeat(32),...extra};const manager=new ManagerState({storage},env);env.MANAGER={idFromName:s=>s,get:()=>({fetch:(u,o)=>manager.fetch(new Request(u,o))})};return {storage,manager,env};}

test('social configuration accepts only bounded platform handles, never arbitrary endpoints',()=>{
 assert.equal(socialSources(DEFAULT_SOCIAL).length,12);
 for(const bad of [{telegram:['http://127.0.0.1']},{...DEFAULT_SOCIAL,x:['a/b']},{...DEFAULT_SOCIAL,bluesky:['localhost']},{...DEFAULT_SOCIAL,telegram:Array(9).fill('validname')},{...DEFAULT_SOCIAL,evil:[]}])assert.throws(()=>validateSocial(bad),/SOCIAL_CONFIG_INVALID/);
});
test('Telegram parser extracts dated channel posts, links and skips foreign/stale content',()=>{
 const rows=parseTelegram(telegram()+telegram(2,new Date(now-4*86400000).toISOString())+telegram(3,undefined,'otherchannel'),source,now);
 assert.equal(rows.length,1);assert.equal(rows[0].url,'https://t.me/stopgamenews/1');assert.deepEqual(rows[0].links,[sourceURL]);
 assert.throws(()=>parseTelegram('<html>Login required</html>',source),/TELEGRAM_PREVIEW_UNAVAILABLE/);
});
test('primary policy rejects UGC, spoofed hosts, credentials, IPs and noneditorial pages',()=>{
 for(const url of ['https://www.nintendo.com.evil.test/us/whatsnew/x','https://user:pass@www.nintendo.com/us/whatsnew/x','http://www.nintendo.com/us/whatsnew/x','https://127.0.0.1/','https://steamcommunity.com/app/1/discussions/1','https://www.nintendo.com/us/','https://t.me/nintendo/1'])assert.equal(primarySource(url),null);
 assert.equal(primarySource(sourceURL+'?tracking=1').url,sourceURL);
 assert.equal(secondaryURL('https://stopgame.ru/newsdata/123/title'),'https://stopgame.ru/newsdata/123/title');
});
test('official HTML needs article text and fresh publication metadata, not a modification date',()=>{
 assert.equal(parsePrimary(html(),sourceURL,now).body,body);
 for(const content of [html('invalid'),html(new Date(now-4*86400000).toISOString()),html().replace('article:published_time','article:modified_time'),html().replace(/<article>.*<\/article>/,'')])assert.throws(()=>parsePrimary(content,sourceURL,now),/NEWS_SOURCE_INVALID/);
});
test('secondary page leads to original evidence; random external links are never fetched',async t=>{
 const seen=[];
 t.mock.method(globalThis,'fetch',async url=>{seen.push(String(url));return new Response(String(url).includes('stopgame')?`<article><a href="https://127.0.0.1/">secret</a><a href="${sourceURL}">original</a></article>`:html(),{headers:{'content-type':'text/html'}});});
 const rows=await resolveEvidence({...item,links:['https://stopgame.ru/newsdata/123/title','https://evil.test/']});
 assert.equal(rows.length,1);assert.equal(rows[0].sourceId,'nintendo-us');assert.deepEqual(seen,['https://stopgame.ru/newsdata/123/title',sourceURL]);
});
test('redirect from an official host to an external host cannot supply evidence',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});});
 assert.deepEqual(await resolveEvidence(item),[]);assert.equal(calls,1);
});
test('no original, uncertain verdict and invented quotations all keep a lead unpublished',async()=>{
 let calls=0;assert.equal((await verifyLead(item,[],async()=>{calls++;})).reason,'NO_PRIMARY_SOURCE');assert.equal(calls,0);
 for(const decision of ['uncertain','reject'])assert.ok((await verifyLead(item,[article],async()=>({decision,sourceUrl:sourceURL,checks:[]}))).reason);
 for(const check of [{claim:text,quote:'This quotation was never present in the original source.'},{claim:'An invented social claim from a different post.',quote:text}])assert.equal((await verifyLead(item,[article],async()=>({decision:'supported',sourceUrl:sourceURL,checks:[check]}))).reason,'INVALID_EVIDENCE');
 const ok=await verifyLead(item,[article],async()=>({decision:'supported',sourceUrl:sourceURL,checks:[{claim:text,quote:text}]}));assert.equal(ok.article.url,sourceURL);
});
test('VK reading uses the separate read token and sanitized provider errors',async t=>{
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.body.get('access_token'),'read');assert.equal(options.body.get('filter'),'owner');return new Response(JSON.stringify({error:{error_code:27,error_msg:'SECRET TOKEN VALUE'}}));});
 await assert.rejects(()=>fetchSocial({platform:'vk',handle:'igromania'},{VK_READ_TOKEN:'read',VK_TOKEN:'community'}),/^Error: VK_API_27$/);
});
test('X makes zero requests until paid access is explicitly configured',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('Unexpected paid request');});
 await assert.rejects(()=>fetchSocial({platform:'x'}, {X_BEARER_TOKEN:'token'}),/X_READ_DISABLED/);
 await assert.rejects(()=>fetchSocial({platform:'x'}, {X_READ_ENABLED:'on'}),/X_TOKEN_MISSING/);
});
test('X uses since_id and retains pagination until all pages are accepted',async t=>{
 const source={platform:'x',handle:'example',id:'x:example',name:'X'};let reserve=0,refund=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{const u=new URL(url);assert.equal(u.searchParams.get('since_id'),'10');assert.equal(options.headers.authorization,'Bearer secret');return new Response(JSON.stringify({data:[{id:'30',text,created_at:new Date(now).toISOString()}],meta:{next_token:'next',result_count:1}}));});
 const result=await fetchSocial(source,{X_READ_ENABLED:'on',X_BEARER_TOKEN:'secret'},{userId:'123',sinceId:'10'},{reserveX:async n=>{reserve+=n;return 'day';},refundX:async(day,n)=>{refund+=n;}});
 assert.equal(result.cache.sinceId,'10');assert.equal(result.cache.latest,'30');assert.equal(result.cache.page,'next');assert.equal(reserve,10);assert.equal(refund,9);
});
test('X daily reservations are atomic and a previous-day refund cannot lower today usage',async()=>{
 const {manager,storage}=setup({X_MAX_READS_PER_DAY:'10'});
 const rows=await Promise.allSettled([manager.reserveX(10),manager.reserveX(10)]);assert.equal(rows.filter(r=>r.status==='fulfilled').length,1);
 await manager.refundX('old-day',10);assert.equal((await storage.get('xUsage')).units,10);
 await manager.refundX(rows.find(r=>r.status==='fulfilled').value,9);assert.equal((await storage.get('xUsage')).units,1);
});
test('Bluesky reads a public author feed and ignores reposts',async t=>{
 const post={uri:'at://did:plc:abc/app.bsky.feed.post/abc123',author:{handle:'gematsu.com'},record:{text,createdAt:new Date(now).toISOString(),facets:[{features:[{uri:sourceURL}]}]}};
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(new URL(url).hostname,'public.api.bsky.app');return new Response(JSON.stringify({feed:[{post},{post,reason:{}}]}));});
 const rows=await fetchSocial({platform:'bluesky',handle:'gematsu.com',id:'bluesky:gematsu.com',name:'Gematsu'},{});assert.equal(rows.leads.length,1);assert.deepEqual(rows.leads[0].links,[sourceURL]);
});
test('first social scan baselines; new posts enter only the verification queue',async t=>{
 const {manager,storage}=setup();await storage.put('socialConfig',{telegram:['stopgamenews'],vk:[],x:[],bluesky:[]});let id=1;
 t.mock.method(globalThis,'fetch',async()=>new Response(telegram(id)));
 await manager.scanSocial();assert.deepEqual(await storage.get('pendingLeads'),[]);assert.equal((await storage.list({prefix:'queue:'})).size,0);
 const state=await storage.get('socialState:telegram:stopgamenews');state.nextPoll=0;await storage.put('socialState:telegram:stopgamenews',state);id=2;
 await manager.scanSocial();const jobs=[...(await storage.list({prefix:'queue:'})).values()];assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'lead');assert.equal((await storage.get('pendingLeads')).length,1);
});
test('full pending queue keeps unseen social posts eligible instead of losing them',async t=>{
 const {manager,storage}=setup();await storage.put('socialConfig',{telegram:['stopgamenews'],vk:[],x:[],bluesky:[]});
 await storage.put('socialSeen:telegram:stopgamenews',[]);await storage.put('pendingLeads',Array.from({length:100},(_,i)=>({...item,url:'https://t.me/stopgamenews/'+(100+i),nextAttempt:now+3600000})));
 t.mock.method(globalThis,'fetch',async()=>new Response(telegram(2)));await manager.scanSocial();assert.deepEqual(await storage.get('socialSeen:telegram:stopgamenews'),[]);
 assert.equal((await storage.get('socialState:telegram:stopgamenews')).status.backlog,true);
});
test('an unconfirmed social rumor stays pending without VK writes or pausing the editor',async t=>{
 const {manager,storage}=setup();await storage.put('pendingLeads',[{...item,links:[]}]);
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('No outgoing request expected');});
 assert.equal(await manager.processLead({leadUrl:item.url}),'awaiting_evidence');assert.equal((await storage.get('pendingLeads'))[0].reason,'NO_EVIDENCE_FOUND');assert.equal(await manager.paused(),false);assert.equal((await storage.list({prefix:'queue:'})).size,0);
});
test('verified reposts from two social accounts enqueue a single primary-identified news job',async t=>{
 const {manager,storage}=setup();await storage.put('pendingLeads',[item,{...item,url:'https://t.me/stopgamenews/3'}]);
 t.mock.method(globalThis,'fetch',async()=>new Response(html(),{headers:{'content-type':'text/html'}}));manager.callAI=async()=>({decision:'supported',sourceUrl:sourceURL,checks:[{claim:text,quote:text}]});
 assert.equal(await manager.processLead({leadUrl:item.url}),'verified');assert.equal(await manager.processLead({leadUrl:'https://t.me/stopgamenews/3'}),'duplicate');
 const jobs=[...(await storage.list({prefix:'queue:'})).values()];assert.equal(jobs.length,1);assert.equal(jobs[0].id,await newsId(sourceURL));assert.equal(jobs[0].kind,'post');assert.equal(jobs[0].discovery.url,item.url);
});
test('configuration is authenticated and UI script remains syntactically valid',async()=>{
 const {env,storage}=setup();const config={telegram:['stopgamenews'],vk:[],x:[],bluesky:[]};
 assert.equal((await worker.fetch(new Request('https://test/api/sources',{method:'POST',body:JSON.stringify(config)}),env)).status,401);
 const r=await worker.fetch(new Request('https://test/api/sources',{method:'POST',headers:{authorization:'Bearer '+env.AGC_ADMIN_KEY},body:JSON.stringify(config)}),env);assert.equal(r.status,200);assert.deepEqual(await storage.get('socialConfig'),config);
 new Script(DASHBOARD.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('unchanged evidence is not repeatedly sent to the model for a pending rumor',async t=>{
 const {manager,storage}=setup();await storage.put('pendingLeads',[item]);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>new Response(html(),{headers:{'content-type':'text/html'}}));manager.callAI=async()=>{calls++;return {decision:'uncertain'};};
 await manager.processLead({leadUrl:item.url});await manager.processLead({leadUrl:item.url});
 assert.equal(calls,1);assert.equal((await storage.get('pendingLeads'))[0].reason,'INSUFFICIENT_EVIDENCE');
});
