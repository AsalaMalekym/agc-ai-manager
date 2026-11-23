import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, parseFeed, fetchFeed, createNews, newsId, CATEGORIES } from '../src/news.js';
import { ManagerState } from '../src/manager.js';
import worker from '../worker.js';

const now = Date.now();
const source = SOURCES[0];
const body = 'The studio has announced a new cooperative adventure game for PlayStation 5. Players can explore a fictional island together and solve environmental puzzles. The announcement describes planned features and does not confirm a release date. The developer says the game will support two players. No pricing or availability in other regions was announced.';
const article = { sourceId: source.id, sourceName: source.name, url: 'https://blog.playstation.com/2026/11/22/adventure/', title: 'A new cooperative adventure game announced', body, publishedAt: now - 1000 };
const output = { skip: false, category: 'news', headline: { text: 'Анонсирована кооперативная игра для PlayStation 5', quote: 'The studio has announced a new cooperative adventure game for PlayStation 5.' }, facts: [
  { text: 'Игрокам предстоит вместе исследовать вымышленный остров и решать головоломки.', quote: 'Players can explore a fictional island together and solve environmental puzzles.' },
  { text: 'Разработчик заявляет поддержку двух игроков.', quote: 'The developer says the game will support two players.' }
] };
const verdict = { decision: 'supported', duplicate: false, checks: [output.headline, ...output.facts].map((c, index) => ({ index, supported: true, quote: c.quote })) };
const moderate = async () => ({ decision: 'allow', confidence: .99 });
function model(values) { const calls = []; const call = async (...args) => { calls.push(args); return structuredClone(values.shift()); }; call.calls = calls; return call; }
function rss(items = [article]) { return `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Official news</title>${items.map(a => `<item><title>${a.title}</title><link>${a.url}</link><pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate><content:encoded><![CDATA[<p>${a.body}</p>]]></content:encoded></item>`).join('')}</channel></rss>`; }
class Storage {
  data = new Map(); alarm = null; tail = Promise.resolve();
  async get(k) { return structuredClone(this.data.get(k)); }
  async put(k, v) { this.data.set(k, structuredClone(v)); }
  async list({ prefix = '', limit = 10000 } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).sort().slice(0, limit)); }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) this.data.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(a) { this.alarm = a; }
  transaction(fn) { const result = this.tail.then(() => fn(this)); this.tail = result.catch(() => {}); return result; }
}
function setup() {
  const storage = new Storage(), env = { ENVIRONMENT: 'production', KILL_SWITCH: 'off', AUTO_POST: 'on', VK_TOKEN: 'group', VK_GROUP_ID: '123', DEEPSEEK_API_KEY: 'mock', AGC_ADMIN_KEY: 'a'.repeat(32) };
  const manager = new ManagerState({ storage }, env);
  env.MANAGER = { idFromName: s => s, get: () => ({ fetch: (u, o) => manager.fetch(new Request(u, o)) }) };
  return { storage, manager, env };
}

test('RSS parser retains original article and rejects stale/future/foreign/missing dates', () => {
  const rows = parseFeed(rss([article, { ...article, publishedAt: now - 4 * 86400000 }, { ...article, publishedAt: now + 3600000 }, { ...article, url: 'https://evil.example/item' }]), source, now);
  assert.equal(rows.length, 1); assert.equal(rows[0].body, body);
  assert.equal(parseFeed(rss().replace(/<pubDate>.*?<\/pubDate>/, ''), source, now).length, 0);
});
test('RSS refuses DTD/entity expansion, malformed XML and oversized payloads', () => {
  for (const xml of ['<!DOCTYPE rss [<!ENTITY x "boom">]>' + rss(), '<rss><channel>', 'x'.repeat(2000001)]) assert.throws(() => parseFeed(xml, source), /NEWS_FEED_INVALID/);
});
test('feed uses conditional requests and treats 304 as unchanged', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, source.feed); assert.equal(options.redirect, 'manual'); assert.equal(options.headers['if-none-match'], 'etag');
    return new Response(null, { status: 304 });
  });
  assert.equal((await fetchFeed(source, { etag: 'etag' })).unchanged, true);
});
test('validated article renders only checked facts plus deterministic source, for all four rubrics', async () => {
  for (const category of Object.keys(CATEGORIES)) {
    const ai = model([{ ...output, category }, verdict]);
    const post = await createNews(article, [], ai, moderate, now);
    assert.match(post.text, /Источник: PlayStation Blog/); assert.ok(post.text.includes(article.url+'\n\n#'));
    assert.ok(post.text.startsWith(CATEGORIES[category])); assert.equal(ai.calls.length, 2);
    assert.deepEqual(ai.calls[1][1].claims, [output.headline, ...output.facts].map(c => c.text));
  }
});
test('fabricated writer quote is rejected before fact checking or publication', async () => {
  const bad = structuredClone(output); bad.facts[0].quote = 'This sentence does not exist in the source.';
  const ai = model([bad]); await assert.rejects(() => createNews(article, [], ai, moderate, now), /NEWS_EVIDENCE_INVALID/); assert.equal(ai.calls.length, 1);
});
test('unsupported dates, missing verdicts and fabricated verifier quotes fail closed', async () => {
  for (const bad of [{ ...verdict, decision: 'uncertain' }, { ...verdict, checks: verdict.checks.slice(1) }, { ...verdict, checks: verdict.checks.map(c => ({ ...c, supported: false })) }, { ...verdict, checks: verdict.checks.map(c => ({ ...c, quote: 'A completely fabricated quotation from nowhere.' })) }]) {
    await assert.rejects(() => createNews(article, [], model([output, bad]), moderate, now), /NEWS_FACTCHECK_REJECTED/);
  }
});
test('no source, an old source and external URLs never reach AI', async () => {
  const ai = model([]);
  for (const bad of [undefined, { ...article, publishedAt: now - 4 * 86400000 }, { ...article, url: 'https://evil.example/' }]) await assert.rejects(() => createNews(bad, [], ai, moderate, now), /NEWS_SOURCE_INVALID/);
  assert.equal(ai.calls.length, 0);
});
test('irrelevant articles and duplicate events are skipped without posting', async () => {
  assert.equal(await createNews(article, [], model([{ skip: true }]), moderate, now), null);
  assert.equal(await createNews(article, [], model([output, { ...verdict, duplicate: true }]), moderate, now), null);
});
test('first scan establishes baseline; new articles enqueue once; failed sources stay independent', async t => {
  const { storage, manager } = setup(); let items = [article];
  t.mock.method(globalThis, 'fetch', async url => String(url) === source.feed ? new Response(rss(items), { headers: { etag: 'v1' } }) : new Response('down', { status: 503 }));
  await manager.scanNews(); assert.equal((await storage.list({ prefix: 'queue:' })).size, 0);
  const next = { ...article, url: 'https://blog.playstation.com/2026/11/22/new-game/', title: 'Another official game announcement' };
  items = [next, article]; await manager.scanNews(); await manager.scanNews();
  const jobs = [...(await storage.list({ prefix: 'queue:' })).values()]; assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, await newsId(next.url)); assert.equal(jobs[0].article.body, body);
  const status = await storage.get('newsStatus'); assert.equal(status.sources[0].ok, true); assert.equal(status.sources[1].ok, false);
  assert.equal(await manager.paused(), false);
});
test('an unparseable response does not establish the baseline', async t => {
  const { storage, manager } = setup(); t.mock.method(globalThis, 'fetch', async () => new Response('<html>Blocked</html>'));
  await manager.scanNews(); assert.equal(await storage.get('seenNews:playstation'), undefined);
});
test('queue backpressure keeps uncached articles eligible for the next scan', async t => {
  const { storage, manager } = setup();
  await storage.put('seenNews:playstation', []);
  for (let i = 0; i < 100; i++) await storage.put(`queue:${i}`, { kind: 'event' });
  t.mock.method(globalThis, 'fetch', async url => String(url) === source.feed ? new Response(rss(), { headers: { etag: 'new' } }) : new Response('', { status: 503 }));
  await manager.scanNews(); assert.equal(await storage.get('feedCache:playstation'), undefined); assert.deepEqual(await storage.get('seenNews:playstation'), []);
});
test('minute schedules and protected manual scan use the same durable deduplication', async () => {
  const { storage, env } = setup(), pending = [];
  assert.equal((await worker.fetch(new Request('https://test/api/scan', { method: 'POST' }), env)).status, 401);
  for (let i = 0; i < 3; i++) await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  await worker.fetch(new Request('https://test/api/scan', { method: 'POST', headers: { authorization: 'Bearer ' + env.AGC_ADMIN_KEY } }), env);
  assert.equal((await storage.list({ prefix: 'queue:' })).size, 1);
  const health = await (await worker.fetch(new Request('https://test/health'), env)).json();
  assert.equal(health.postingActive, true); assert.equal(health.postingTokenType, 'community'); assert.equal(health.pollIntervalSeconds, 60);
});
test('legacy meme jobs are discarded and AI budget exhaustion does not require manual resume next day', async () => {
  const { manager, storage } = setup();
  assert.equal(await manager.publish({ id: 'post:legacy' }), 'skipped');
  manager.createPost = async () => { throw Error('AI_DAILY_LIMIT'); };
  await manager.enqueue({ id: 'news:budget', kind: 'post', article }); await manager.alarm();
  assert.equal(await manager.paused(), false); assert.equal((await storage.get('done:news:budget')).code, 'AI_DAILY_LIMIT');
});

 test('news formatting and grounded hashtags reach moderation without extra AI calls', async()=>{
  const draft=structuredClone(output);draft.hashtagTerms=['PlayStation 5','Rockstar'];draft.facts[0].emoji='🌍';draft.facts[1].emoji='🎮';
  const ai=model([draft,verdict]);let moderated='';
  const post=await createNews(article,[],ai,async text=>{moderated=text;return {decision:'allow',confidence:1};},now);
  assert.deepEqual(post.hashtags,['#ИгровыеНовости','#PlayStation5']);
  assert.ok(post.text.endsWith('#ИгровыеНовости #PlayStation5'));
  assert.match(post.text,/\n\n🌍 Игрокам/);assert.match(post.text,/\n\n🎮 Разработчик/);
  assert.ok(moderated.includes('#PlayStation5'));assert.ok(!moderated.includes('Rockstar'));
  assert.equal(ai.calls.length,2);
 });
