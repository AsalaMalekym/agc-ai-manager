import {imageFixture} from './image-fixture.js';
import {initCardRenderer} from '../src/image-card.js';
import {readFileSync} from 'node:fs';
await initCardRenderer(readFileSync(new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm',import.meta.url)));
import {startPhotoAuth,finishPhotoAuth} from '../src/photo-auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { eventJob } from '../worker.js';
import { ManagerState } from '../src/manager.js';
import { validText, duplicate, moderate, vk, safeCode, summarize, randomId, imageAttachment } from '../src/services.js';

class Storage {
  constructor() { this.data = new Map(); this.alarm = null; this.tail = Promise.resolve(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.data.delete(k); }
  async list({ prefix = '', limit = Infinity } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([k, v]) => [k, structuredClone(v)])); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  transaction(fn) { const p = this.tail.then(() => fn(this)); this.tail = p.catch(() => {}); return p; }
}
const allow = { decision: 'allow', category: 'safe', confidence: 0.99 };
const article = { sourceId: 'xbox', sourceName: 'Xbox Wire', url: 'https://news.xbox.com/en-us/2026/11/22/game/', title: 'Studio announces a new adventure game', publishedAt: Date.now(), body: 'The studio announced a new adventure game for Xbox and PC. Players will explore a fictional island and solve environmental puzzles. The developer says cooperative play will support two players. This announcement describes the planned features rather than a review of the finished game. No release date or pricing has been announced in this official article.' };
const draft = { skip: false, category: 'news', headline: {text:'Студия анонсировала приключенческую игру для Xbox и PC',quote:'The studio announced a new adventure game for Xbox and PC.'},facts:[{text:'Игрокам предстоит исследовать вымышленный остров и решать головоломки.',quote:'Players will explore a fictional island and solve environmental puzzles.'},{text:'Разработчик заявляет кооперативный режим для двух игроков.',quote:'The developer says cooperative play will support two players.'}] };
const verification = { decision: 'supported', duplicate: false, checks: [draft.headline,...draft.facts].map((c,index)=>({index,supported:true,quote:c.quote})) };
function setup(overrides = {}) {
  const storage = new Storage();
  const env = { ENVIRONMENT: 'production', KILL_SWITCH: 'off', AUTO_POST: 'on', AUTO_REPLY: 'on', COMMENT_REPLY: 'on',
    MODERATION: 'on', AUTO_DELETE: 'on', VK_GROUP_ID: '123', VK_TOKEN: 'group-token', VK_USER_TOKEN: 'user-token',
    VK_CALLBACK_SECRET: 'callback-secret', VK_CONFIRMATION_CODE: 'confirmation', DEEPSEEK_API_KEY: 'ai-key',
    AGC_ADMIN_KEY: 'a'.repeat(32), ...overrides };
  const manager = new ManagerState({ storage }, env);
  env.MANAGER = { idFromName: s => s, get: () => ({ fetch: (url, init) => manager.fetch(new Request(url, init)) }) };
  return { env, storage, manager };
}
function comment(id = 1, text = 'Админ, что нового?') { return { type: 'wall_reply_new', group_id: 123, secret: 'callback-secret', object: { id, post_id: 10, from_id: 42, text } }; }
function message(id = 1) { return { type: 'message_new', group_id: 123, secret: 'callback-secret', object: { message: { id: 0, conversation_message_id: id, peer_id: 42, from_id: 42, text: 'Привет!' } } }; }
function request(event) { return new Request('https://test/vk/callback', { method: 'POST', body: JSON.stringify(event) }); }
function mockProviders(t, outputs = [draft, verification, allow], handlers = {}) {
  const calls = []; let index = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const name = String(url); calls.push({ url: name, options });
    if (name.includes('deepseek')) {
      const output = outputs[index++];
      if (output instanceof Error) throw output;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: typeof output === 'string' ? output : JSON.stringify(output) } }] });
    }
    const method = name.split('/').at(-1);
    if (handlers[method]) return handlers[method](options);
    if (method === 'wall.post') return Response.json({ response: { post_id: 99 } });
    if (method === 'wall.get') return Response.json({ response: { items: [] } });
    return Response.json({ response: 1 });
  }); return calls;
}

test('text validation detects Cyrillic passwords and links; duplicate normalized', () => {
  assert.equal(validText('напиши пароль от аккаунта'), false); assert.equal(validText('переходи на example.ru'), false);
  assert.equal(validText('Хорошего дня!'), true); assert.equal(duplicate('Привет, МИР!', ['привет мир']), true);
});
test('callback rejects bad JSON, null, incorrect group, and missing secret including confirmation', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(new Request('https://test/vk/callback', { method: 'POST', body: '{' }), env)).status, 400);
  for (const e of [null, [], { ...comment(), group_id: 1 }, { type: 'confirmation', group_id: 123 }]) assert.equal((await worker.fetch(request(e), env)).status, 403);
  const r = await worker.fetch(request({ type: 'confirmation', group_id: 123, secret: 'callback-secret' }), env);
  assert.equal(await r.text(), 'confirmation');
});
test('oversized callback is rejected before parsing', async () => {
  const { env } = setup(); assert.equal((await worker.fetch(new Request('https://test/vk/callback', { method: 'POST', body: 'a'.repeat(17000) }), env)).status, 413);
});
test('dashboard exists; protected routes do not accept missing or short keys', async () => {
  const { env } = setup(); assert.equal((await worker.fetch(new Request('https://test/'), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://test/api/status'), env)).status, 401);
  env.AGC_ADMIN_KEY = 'short'; assert.equal((await worker.fetch(new Request('https://test/api/status', { headers: { authorization: 'Bearer short' } }), env)).status, 401);
});
test('event identities distinguish peers and support id=0 with conversation_message_id', () => {
  assert.ok(eventJob(message()));
  const other = message(); other.object.message.peer_id = 43; other.object.message.from_id = 43;
  assert.notEqual(eventJob(message()).id, eventJob(other).id);
  const own = comment(); own.object.from_id = -123; assert.equal(eventJob(own), null);
  const chat = message(); chat.object.message.peer_id = 2000000001; assert.equal(eventJob(chat), null);
});
test('concurrent duplicate callbacks create one durable task; ACK follows acceptance', async () => {
  const { env, storage } = setup();
  const responses = await Promise.all(Array.from({ length: 20 }, () => worker.fetch(request(message()), env)));
  assert.ok(responses.every(r => r.status === 200)); assert.equal((await storage.list({ prefix: 'queue:' })).size, 1);
});
test('storage failure returns 503 so VK retries instead of losing event', async () => {
  const { env } = setup(); env.MANAGER.get = () => ({ fetch: () => { throw Error('storage unavailable'); } });
  assert.equal((await worker.fetch(request(message()), env)).status, 503);
});
test('rate limiter caps one user at ten new events per hour', async () => {
  const { manager, storage } = setup(); for (let i = 0; i < 15; i++) await manager.enqueue(eventJob(message(i + 1)));
  assert.equal((await storage.list({ prefix: 'queue:' })).size, 10);
});
test('staging ignores incoming events and schedules even if switches are on', async () => {
  const { env, storage } = setup({ ENVIRONMENT: 'staging' });
  await worker.fetch(request(message()), env);
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.UTC(2026, 10, 22, 5) }, env, { waitUntil() { throw Error('must not run'); } });
  assert.equal((await storage.list({ prefix: 'queue:' })).size, 0);
});
test('one news post for repeated jobs and deterministic VK guid using community token', async t => {
  const { manager, storage } = setup({ VK_USER_TOKEN: undefined }), calls = mockProviders(t);
  for (let i = 0; i < 5; i++) await manager.enqueue({ article, kind: 'post', id: 'news:one' });
  await manager.alarm(); await manager.alarm();
  const sends = calls.filter(c => c.url.endsWith('wall.post')); assert.equal(sends.length, 1);
  assert.equal(sends[0].options.body.get('guid'), 'news:one');
  assert.equal(sends[0].options.body.get('access_token'), 'group-token');
  assert.match(sends[0].options.body.get('message'), /Источник: Xbox Wire/);
  assert.equal((await storage.get('history')).length, 1);
});
test('malformed moderation fails closed with no VK write', async t => {
  const { manager, storage } = setup(), calls = mockProviders(t, [draft, verification, { decision: 'allow' }]);
  await manager.enqueue({ article, kind: 'post', id: 'post:bad' }); await manager.alarm();
  assert.equal(calls.filter(c => c.url.includes('api.vk')).length, 0);
  assert.equal((await storage.get('done:post:bad')).code, 'MODERATION_INVALID');
});
test('rejected draft never reaches VK', async t => {
  const { manager } = setup(), calls = mockProviders(t, [draft, verification, { decision: 'reject', category: 'harassment', confidence: 0.99 }]);
  await manager.enqueue({ article, kind: 'post', id: 'post:reject' }); await manager.alarm();
  assert.equal(calls.filter(c => c.url.includes('api.vk')).length, 0);
});
test('pause during generation prevents pending publication', async t => {
  const { manager, storage } = setup(), calls = mockProviders(t);
  const original = manager.createPost.bind(manager);
  manager.createPost = async () => { const d = await original(); await storage.put('paused', true); return d; };
  await manager.enqueue({ article, kind: 'post', id: 'post:pause' }); await manager.alarm();
  assert.equal(calls.filter(c => c.url.endsWith('wall.post')).length, 0);
});
test('network timeout after send is uncertain, pauses, and is never replayed', async t => {
  const { manager, storage } = setup(), calls = mockProviders(t, [draft, verification, allow], { 'wall.post': () => { throw Error('timeout SECRET'); } });
  const job = { article, kind: 'post', id: 'post:timeout' }; await manager.enqueue(job); await manager.alarm();
  assert.equal((await storage.get('done:post:timeout')).status, 'uncertain'); assert.equal(await storage.get('paused'), true);
  await manager.enqueue(job); await manager.alarm(); assert.equal(calls.filter(c => c.url.endsWith('wall.post')).length, 1);
  assert.ok(!JSON.stringify(await storage.get('audit')).includes('SECRET'));
});
test('interrupted alarm does not replay in-flight job after object restart', async () => {
  const { manager, storage, env } = setup(); await manager.enqueue({ article, kind: 'post', id: 'post:crash' });
  const [key, job] = [...await storage.list({ prefix: 'queue:' })][0]; await storage.put(key, { ...job, status: 'processing' });
  await new ManagerState({ storage }, env).alarm();
  assert.equal((await storage.get('done:post:crash')).status, 'uncertain'); assert.equal(await storage.get('paused'), true);
});
test('moderation operates independently of auto replies and deletes only confident rejects', async t => {
  const { manager, storage } = setup({ AUTO_REPLY: 'off' });
  const calls = mockProviders(t, [{ decision: 'reject', category: 'scam', confidence: 0.99 }]);
  await manager.enqueue(eventJob(comment())); await manager.alarm();
  assert.equal(calls.filter(c => c.url.endsWith('wall.deleteComment')).length, 1);
  assert.equal((await storage.get('review')).length, 1);
});
test('uncertain moderation and attached media go to review without deletion', async t => {
  const { manager, storage } = setup(); const calls = mockProviders(t, [{ decision: 'reject', category: 'spam', confidence: 0.8 }]);
  await manager.enqueue(eventJob(comment())); await manager.alarm();
  const e = comment(2); e.object.attachments = [{ type: 'photo' }]; await manager.enqueue(eventJob(e)); await manager.alarm();
  assert.equal((await storage.get('review')).length, 2); assert.equal(calls.filter(c => c.url.includes('api.vk')).length, 0);
});
test('reply output receives independent moderation; deterministic random_id', async t => {
  const { manager } = setup(), calls = mockProviders(t, [allow, 'Привет! Мемы на месте.', allow]);
  const job = eventJob(message()); await manager.enqueue(job); await manager.alarm();
  const send = calls.find(c => c.url.endsWith('messages.send')); assert.ok(send);
  assert.equal(Number(send.options.body.get('random_id')), await randomId(job.id)); assert.equal(calls.length, 4);
});
test('budget is atomic and stops before the next AI call', async () => {
  const { manager, storage } = setup({ MAX_AI_CALLS_PER_DAY: '2' });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => manager.reserveAI()));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2); assert.equal((await storage.get('usage')).calls, 2);
});
test('three provider failures pause automation', async t => {
  const { manager, storage } = setup(); mockProviders(t, [Error('fail'), Error('fail'), Error('fail')]);
  for (let i = 0; i < 3; i++) { await manager.enqueue({ article, id: 'post:' + i, kind: 'post' }); await manager.alarm(); }
  assert.equal(await storage.get('paused'), true);
});
test('resume cancels accumulated queued jobs rather than dumping them into VK', async () => {
  const { manager, storage } = setup(); await manager.enqueue(eventJob(message())); await storage.put('paused', true);
  await manager.fetch(new Request('https://manager/resume'));
  assert.equal((await storage.list({ prefix: 'queue:' })).size, 0); assert.equal(await storage.get('paused'), false);
});
test('health does not claim active posting without posting credentials', async () => {
  const { env } = setup({ VK_USER_TOKEN: undefined, VK_TOKEN: undefined }); const d = await (await worker.fetch(new Request('https://test/health'), env)).json();
  assert.equal(d.postingActive, false); assert.equal(d.repliesActive, false); assert.ok(!JSON.stringify(d).includes('group-token'));
});
test('VK token routing and errors never expose provider payloads', async t => {
  const { env } = setup(); const calls = mockProviders(t, [], { 'wall.post': () => Response.json({ error: { error_code: 27, request_params: ['SECRET'] } }) });
  await assert.rejects(() => vk(env, 'wall.post'), /VK_API_27/); assert.equal(calls[0].options.body.get('access_token'), 'group-token');
  assert.equal(safeCode(Error('Bearer secret')), 'INTERNAL_ERROR');
});
test('analytics calculate engagement and Moscow hours without inventing reach', () => {
  const d = summarize([{ date: Date.UTC(2026, 10, 22, 5) / 1000, likes: { count: 10 }, comments: { count: 2 }, reposts: { count: 1 }, views: { count: 100 } }]);
  assert.equal(d.engagementPerView, 0.13); assert.equal(d.hours[8].posts, 1); assert.equal(summarize([]).engagementPerView, null);
});
test('image upload rejects arbitrary outbound destinations', async t => {
  const { env } = setup(); env.AI = { run: async () => ({ image: btoa('image') }) };
  mockProviders(t, [], { 'photos.getWallUploadServer': () => Response.json({ response: { upload_url: 'https://evil.example/upload' } }) });
  await assert.rejects(() => imageAttachment(env, 'cartoon'), /UPLOAD_HOST_REJECTED/);
});
test('missing posting token does not schedule repeated failures or break existing replies', async () => {
  const { env, storage } = setup({ VK_USER_TOKEN: undefined, VK_TOKEN: undefined }); const pending = [];
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.UTC(2026, 10, 22, 5) }, env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending); assert.equal((await storage.list({ prefix: 'queue:' })).size, 0);
});
test('missing user token sends rejected comments to review without breaking replies', async t => {
  const { manager, storage } = setup({ VK_USER_TOKEN: undefined });
  const calls = mockProviders(t, [{ decision: 'reject', category: 'scam', confidence: 0.99 }]);
  await manager.enqueue(eventJob(comment())); await manager.alarm();
  assert.equal(calls.filter(c => c.url.includes('api.vk')).length, 0); assert.equal((await storage.get('review')).length, 1);
  assert.equal(await manager.paused(), false);
});

test('facts scheduler waits for news, deduplicates jobs, and yields to ready news', async () => {
  const { manager, storage } = setup({ AUTO_FACTS:'on' });
  await manager.scheduleFacts();assert.equal((await storage.list({prefix:'queue:'})).size,0);
  await storage.put('factsState',{startedAt:Date.now()-3*3600000});
  await storage.put('history',[{topic:'news',sourceUrl:article.url,at:Date.now()-3600000}]);
  await manager.scheduleFacts();assert.equal((await storage.list({prefix:'queue:'})).size,0);
  await storage.put('history',[]);
  await manager.enqueue({id:'news:priority',kind:'post',article});await manager.scheduleFacts();
  assert.equal((await storage.list({prefix:'queue:'})).size,1);
  assert.equal(await manager.factCanPublish(),false);
  const [key,job]=[...await storage.list({prefix:'queue:'})][0];await manager.finish(key,job,'skipped');
  await manager.scheduleFacts();await manager.scheduleFacts();assert.equal((await storage.list({prefix:'queue:'})).size,1);
  assert.equal([...await storage.list({prefix:'queue:'})][0][1].kind,'fact');
});
test('verified fact sends once, updates separate counters and retains source deduplication', async t => {
  const {manager,storage}=setup({AUTO_FACTS:'on'}),calls=mockProviders(t,[]);
  const lastNewsAt=Date.now()-3*3600000;await storage.put('factsState',{startedAt:lastNewsAt,lastNewsAt});
  manager.createFactPost=async()=>({text:'🎮 Игровой факт\nПодтверждённая история создания острова.',topic:'fact',sourceUrl:article.url,sourceUrls:[article.url]});
  const job={id:'fact:test',kind:'fact'};await manager.enqueue(job);await manager.alarm();await manager.enqueue(job);await manager.alarm();
  assert.equal(calls.filter(c=>c.url.endsWith('wall.post')).length,1);
  const state=await storage.get('factsState');assert.equal(state.sent,1);assert.equal(state.lastNewsAt,lastNewsAt);
  assert.equal((await storage.list({prefix:'factUsed:'})).size,1);assert.equal((await storage.get('factHistory')).length,1);
  assert.equal((await manager.factStatus()).eligible,false);
});
test('news arriving during fact generation prevents the send', async t => {
  const {manager,storage}=setup({AUTO_FACTS:'on'}),calls=mockProviders(t,[]);
  await storage.put('factsState',{startedAt:Date.now()-3*3600000});
  manager.createFactPost=async()=>{await manager.enqueue({id:'news:arrival',kind:'post',article});return {text:'Факт',topic:'fact',sourceUrl:article.url};};
  await manager.enqueue({id:'fact:race',kind:'fact'});await manager.alarm();
  assert.equal(calls.filter(c=>c.url.endsWith('wall.post')).length,0);assert.equal((await storage.get('done:fact:race')).status,'deferred');
});
test('fact generation errors do not pause news but uncertain sends still pause', async t => {
  const {manager,storage}=setup({AUTO_FACTS:'on'});await storage.put('factsState',{startedAt:Date.now()-3*3600000});
  manager.createFactPost=async()=>{throw Error('AI_UNAVAILABLE');};
  for(let i=0;i<3;i++){await manager.enqueue({id:'fact:error'+i,kind:'fact'});await manager.alarm();}
  assert.equal(await manager.paused(),false);
  mockProviders(t,[],{'wall.post':()=>{throw Error('timeout');}});
  manager.createFactPost=async()=>({text:'Проверенный факт',topic:'fact',sourceUrl:article.url});
  await manager.enqueue({id:'fact:uncertain',kind:'fact'});await manager.alarm();
  assert.equal((await storage.get('done:fact:uncertain')).status,'uncertain');assert.equal(await manager.paused(),true);
});
test('facts disabled switch and eighth publication block generation entirely', async()=>{
 const {manager,storage,env}=setup();await storage.put('factsState',{startedAt:Date.now()-3*3600000});
 manager.createFactPost=async()=>{throw Error('must not generate');};
 assert.equal(await manager.publish({id:'fact:off',kind:'fact'}),'deferred');env.AUTO_FACTS='on';
 const day=new Date(Date.now()+3*3600000).toISOString().slice(0,10);
 await storage.put('factsState',{startedAt:Date.now()-3*3600000,day,sent:8});
 assert.equal(await manager.publish({id:'fact:cap',kind:'fact'}),'deferred');
});

test('raising AI budget to 1000 resumes waiting leads without resetting usage', async()=>{
 const {manager,storage}=setup({MAX_AI_CALLS_PER_DAY:'1000'}),day=new Date().toISOString().slice(0,10);
 await storage.put('usage',{day,calls:250});await storage.put('pendingLeads',[{url:'a',reason:'AI_DAILY_LIMIT',nextAttempt:Date.now()+999999,evidenceKey:'old'},{url:'b',reason:'SOURCE_CONTRADICTION',nextAttempt:999}]);
 await storage.put('factsState',{lastOutcome:'AI_DAILY_LIMIT',nextAttempt:Date.now()+999999});await manager.recoverBudget();
 const leads=await storage.get('pendingLeads');assert.equal(leads[0].reason,'AWAITING_VERIFICATION');assert.ok(leads[0].nextAttempt<=Date.now());assert.equal(leads[1].reason,'SOURCE_CONTRADICTION');
 assert.equal((await storage.get('usage')).calls,250);assert.equal((await storage.get('factsState')).nextAttempt,0);
 await storage.put('usage',{day,calls:999});await manager.reserveAI();await assert.rejects(()=>manager.reserveAI(),/AI_DAILY_LIMIT/);assert.equal((await storage.get('usage')).calls,1000);
});
test('mixed scheduling respects the last fact and continues other themes after eight facts',async()=>{
 const {manager,storage}=setup({AUTO_MIXED:'on',AUTO_FACTS:'on'}),day=new Date(Date.now()+3*3600000).toISOString().slice(0,10);
 await storage.put('factsState',{startedAt:Date.now()-5*3600000,day,sent:8});
 await storage.put('history',[{topic:'fact',sourceUrl:article.url,at:Date.now()-3600000}]);await manager.scheduleFacts();assert.equal((await storage.list({prefix:'queue:'})).size,0);
 await storage.put('history',[{topic:'fact',sourceUrl:article.url,at:Date.now()-3*3600000}]);await manager.scheduleFacts();assert.equal((await storage.list({prefix:'queue:'})).size,1);
 assert.equal((await manager.contentStatus()).targetIntervalMinutes,120);
});
test('mixed publication counts an esports story separately from the fact quota',async t=>{
 const {manager,storage}=setup({AUTO_MIXED:'on',AUTO_FACTS:'on'});mockProviders(t,[]);
 const day=new Date(Date.now()+3*3600000).toISOString().slice(0,10);await storage.put('factsState',{startedAt:Date.now()-3*3600000,day,sent:8});
 manager.createFactPost=async()=>({text:'Киберспорт: проверенная история турнира',topic:'esports',sourceUrl:article.url});
 await manager.enqueue({id:'mixed:esports',kind:'fact'});await manager.alarm();assert.equal((await storage.get('factsState')).sent,8);assert.equal((await manager.contentStatus()).eligible,false);
});

test('discovery is paced hourly, leaves publication reserve, and never resets spent daily usage',async()=>{
 const {manager,storage}=setup({MAX_AI_CALLS_PER_DAY:'1000'}),day=new Date().toISOString().slice(0,10);
 for(let i=0;i<30;i++)await manager.reserveAI('discovery');
 await assert.rejects(()=>manager.reserveAI('discovery'),/AI_DISCOVERY_HOURLY_LIMIT/);
 await manager.reserveAI();assert.equal((await storage.get('usage')).calls,31);
 await storage.put('usage',{day,calls:800,roles:{discovery:700,interactive:100}});
 await assert.rejects(()=>manager.reserveAI('discovery'),/AI_DISCOVERY_DAILY_LIMIT/);
 await assert.rejects(()=>manager.reserveAI('interactive'),/AI_REPLY_DAILY_LIMIT/);
 await manager.reserveAI();assert.equal((await storage.get('usage')).calls,801);
 await storage.put('usage',{day,calls:1000});await manager.recoverBudget();
 await assert.rejects(()=>manager.reserveAI(),/AI_DAILY_LIMIT/);assert.equal((await storage.get('usage')).calls,1000);
});
test('creative publication uses the real wall pipeline and persists cadence without fake sources',async t=>{
 const {manager,storage}=setup({AUTO_MIXED:'on'});
 await storage.put('factsState',{startedAt:Date.now()-3*3600000,cursor:12});
 const outputs=[{text:'Игрок: сохраню редкое зелье для действительно сложного босса.\nФинальные титры: зелье всё ещё ждёт своего звёздного часа.',concept:'Зелье сохранено до финальных титров'},
 {safe:true,gaming:true,noFactualClaims:true,original:true,formatMatches:true},allow];
 const calls=mockProviders(t,outputs);
 assert.equal(await manager.publish({kind:'fact',id:'creative-one'}),'sent');
 const record=(await storage.get('history'))[0];assert.equal(record.topic,'meme');assert.equal(record.postId,99);assert.equal(record.sourceUrl,undefined);
 assert.equal((await storage.list({prefix:'factUsed:'})).size,0);
 assert.equal((await manager.contentStatus()).eligible,false);
 assert.equal(await manager.publish({kind:'fact',id:'creative-two'}),'deferred');
 assert.equal(calls.filter(c=>c.url.endsWith('wall.post')).length,1);
});
test('discussion replies include parent context and read-only analytics token never writes',async t=>{
 const {manager,storage}=setup({VK_READ_TOKEN:'read-only'});
 await storage.put('history',[{postId:10,topic:'discussion',text:'Что предпочитаете: сюжет или исследование?',at:Date.now()}]);
 const calls=mockProviders(t,[allow,'Исследование даёт простор для собственного темпа. Что вам нравится искать?',allow]);
 assert.equal(await manager.processEvent({id:'discussion-reply',event:comment(2,'Мне нравится исследование мира')}),'sent');
 const aiCall=calls.filter(c=>c.url.includes('deepseek'))[1];assert.match(JSON.parse(aiCall.options.body).messages[1].content,/Что предпочитаете/);
 await manager.analytics();
 assert.equal(calls.find(c=>c.url.endsWith('wall.get')).options.body.get('access_token'),'read-only');
 assert.equal(calls.find(c=>c.url.endsWith('wall.createComment')).options.body.get('access_token'),'group-token');
});

test('budget exhaustion retains unsent news for reset without blocking ready scans or retrying a VK send',async t=>{
 const {manager,storage}=setup();
 const day=new Date().toISOString().slice(0,10);await storage.put('usage',{day,calls:1000});
 await manager.enqueue({id:'budget-news',kind:'post',article});await manager.alarm();
 assert.equal((await storage.get('done:budget-news')).status,'waiting_budget');
 const [key,job]=[...(await storage.list({prefix:'queue:'}))][0];assert.ok(job.notBefore>Date.now());
 const calls=mockProviders(t);await manager.alarm();assert.equal(calls.length,0);
 let scans=0;manager.scanNews=async()=>{scans++;return 'scanned';};
 await manager.enqueue({id:'ready-scan',kind:'scan'});assert.ok((await storage.getAlarm())<job.notBefore);
 await manager.alarm();assert.equal(scans,1);assert.equal((await storage.get('done:budget-news')).status,'waiting_budget');
 await storage.put('usage',{day:'2000-01-01',calls:1000});await storage.put(key,{...job,notBefore:Date.now()-1,created:Date.now()});
 await manager.alarm();assert.equal((await storage.get('done:budget-news')).status,'sent');assert.equal(calls.filter(c=>c.url.endsWith('wall.post')).length,1);
 assert.equal((await storage.list({prefix:'queue:'})).size,0);
});

const imagePrompt='A stylized painted island with two fictional adult explorers cooperating to solve a glowing stone puzzle, expressive blue and purple light, clean contours and an original editorial composition.';
const imageBytes=imageFixture;
function mockImageProviders(t, outputs=[draft,verification,allow,{prompt:imagePrompt},allow], overrides={}) {
 const calls=mockProviders(t,outputs,{
  'photos.getWallUploadServer':()=>Response.json({response:{upload_url:'https://pu.vk.com/upload'}}),
  upload:()=>Response.json({server:1,photo:'[{"photo":"saved"}]',hash:'hash'}),
  'photos.saveWallPhoto':()=>Response.json({response:[{owner_id:-123,id:456}]}),...overrides
 });return calls;
}
test('generated image and verified text are sent in one post, counted in the global 2000 budget and labelled',async t=>{
 let generated=0;const {manager,storage}=setup({GENERATE_IMAGES:'on',MAX_AI_CALLS_PER_DAY:'2000',VK_PHOTO_TOKEN:'photo-token',AI:{run:async(model,input)=>{generated++;assert.equal(input.steps,4);assert.match(input.prompt,/island/);return {image:imageBytes};}}});
 const calls=mockImageProviders(t);
 assert.equal(await manager.publish({id:'illustrated-news',kind:'post',article}),'sent');
 assert.equal(generated,1);const post=calls.find(c=>c.url.endsWith('wall.post')).options.body;
 assert.equal(post.get('attachments'),'photo-123_456');assert.match(post.get('message'),/Иллюстрация сгенерирована ИИ/);assert.equal(post.get('access_token'),'group-token');
 assert.equal(calls.find(c=>c.url.endsWith('photos.saveWallPhoto')).options.body.get('access_token'),'photo-token');
 assert.equal(calls.find(c=>c.url.endsWith('/upload')).options.body.get('photo').type,'image/png');
 assert.equal((await storage.get('usage')).calls,6);assert.equal((await storage.get('usage')).roles.image,1);
 assert.equal((await manager.imageStatus()).active,true);assert.ok((await manager.imageStatus()).lastPublishedAt);
 assert.equal((await storage.get('history'))[0].illustration.status,'attached');
});
test('VK upload permission is probed before spending on images; text publishes and diagnostic is honest',async t=>{
 const {manager,storage}=setup({GENERATE_IMAGES:'on',VK_USER_TOKEN:undefined,AI:{run:()=>assert.fail('Must not generate without upload access')}});
 const calls=mockImageProviders(t,[draft,verification,allow],{'photos.getWallUploadServer':()=>Response.json({error:{error_code:27}})});
 assert.equal(await manager.publish({id:'text-fallback',kind:'post',article}),'sent');
 const post=calls.find(c=>c.url.endsWith('wall.post')).options.body;
 assert.equal(post.has('attachments'),false);assert.doesNotMatch(post.get('message'),/Иллюстрация сгенерирована ИИ/);
 assert.equal((await storage.get('usage')).calls,3);assert.equal((await manager.imageStatus()).lastError,'VK_API_27');assert.equal((await manager.imageStatus()).active,false);
 const count=calls.length;await manager.probeImages();assert.equal(calls.length,count);
});
test('pause while the image generates prevents upload and publication',async t=>{
 const {manager,storage}=setup({GENERATE_IMAGES:'on',AI:{run:async()=>{await storage.put('paused',true);return {image:imageBytes};}}});
 const calls=mockImageProviders(t);
 await assert.rejects(()=>manager.publish({id:'paused-image',kind:'post',article}),/WRITES_DISABLED/);
 assert.equal(calls.some(c=>c.url.endsWith('/upload')||c.url.endsWith('wall.post')),false);
});
test('failed image upload falls back to text; ambiguous wall send is still paused and never retried',async t=>{
 const {manager,storage}=setup({GENERATE_IMAGES:'on',AI:{run:async()=>({image:imageBytes})}});
 const calls=mockImageProviders(t,undefined,{upload:()=>new Response('',{status:502}),'wall.post':()=>{throw Error('timeout');}});
 await manager.enqueue({id:'uncertain-illustration',kind:'post',article});await manager.alarm();
 assert.equal((await manager.imageStatus()).lastError,'IMAGE_UPLOAD_FAILED');assert.equal(await manager.paused(),true);
 assert.equal((await storage.get('done:uncertain-illustration')).status,'uncertain');
 await manager.alarm();assert.equal(calls.filter(c=>c.url.endsWith('wall.post')).length,1);
});
test('raising the budget wakes deferred news immediately without resetting consumed requests',async()=>{
 const {manager,storage}=setup({MAX_AI_CALLS_PER_DAY:'2000'}),day=new Date().toISOString().slice(0,10),later=Date.now()+3600000;
 await storage.put('usage',{day,calls:1000});await storage.put('done:budget',{status:'waiting_budget'});
 await storage.put('queue:1:budget',{id:'budget',kind:'post',article,status:'queued',created:later,notBefore:later});
 await manager.recoverBudget();const job=await storage.get('queue:1:budget');assert.equal(job.notBefore,0);assert.ok(job.created<=Date.now());assert.equal((await storage.get('usage')).calls,1000);
 await storage.put('usage',{day,calls:1999});await manager.reserveAI();await assert.rejects(()=>manager.reserveAI(),/AI_DAILY_LIMIT/);assert.equal((await storage.get('usage')).calls,2000);
});

test('stored server photo token is used for images while wall publication keeps community credentials',async t=>{
 const {manager,storage,env}=setup({VK_APP_SECRET:'private-protected-key',GENERATE_IMAGES:'on',AI:{run:async()=>({image:imageBytes})}});
 const calls=mockImageProviders(t,undefined,{'access_token':()=>Response.json({access_token:'server-photo-token-for-tests',expires_in:3600})});
 const auth=await startPhotoAuth(storage,env),state=new URL(auth.authorizeUrl).searchParams.get('state');
 await finishPhotoAuth(storage,env,'https://oauth.vk.ru/blank.html#'+new URLSearchParams({code:'one-use-code',state}));
 assert.equal(await manager.publish({id:'server-photo-publish',kind:'post',article}),'sent');
 for(const c of calls.filter(c=>c.url.includes('/method/photos.')))assert.equal(c.options.body.get('access_token'),'server-photo-token-for-tests');
 assert.equal(calls.find(c=>c.url.endsWith('wall.post')).options.body.get('access_token'),'group-token');
 assert.equal((await manager.imageStatus()).active,true);
 const status=await (await manager.fetch(new Request('https://manager/status'))).text();assert.ok(!status.includes('server-photo-token-for-tests'));assert.ok(!status.includes('private-protected-key'));
});

test('blank or repeated artwork is skipped while verified text still publishes',async t=>{
 const {fixturePNG}=await import('./image-fixture.js');
 for(const [code,bytes] of [['IMAGE_BLANK',fixturePNG(true)],['IMAGE_DUPLICATE',fixturePNG()]]){
  await t.test(code,async t=>{
   const {manager,storage}=setup({GENERATE_IMAGES:'on',VK_PHOTO_TOKEN:'photos',AI:{run:async()=>({image:bytes.toString('base64')})}});
   if(code==='IMAGE_DUPLICATE'){
    const artworkHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    await storage.put('history',[{text:'Совсем другой материал о турнире',illustration:{artworkHash}}]);
   }
   const calls=mockImageProviders(t);
   assert.equal(await manager.publish({id:code,kind:'post',article}),'sent');
   const sent=calls.find(c=>c.url.endsWith('wall.post')).options.body;
   assert.equal(sent.get('attachments'),null);assert.ok(!sent.get('message').includes('Иллюстрация сгенерирована ИИ'));
   assert.ok(!calls.some(c=>c.url.endsWith('/upload')));assert.equal((await manager.imageStatus()).lastError,code);
   assert.equal((await storage.get('history')).at(-1).illustration.code,code);
  });
 }
});
