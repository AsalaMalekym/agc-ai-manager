import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, createFetchMock } from 'miniflare';
import { SOURCES } from '../src/news.js';

test('Worker and SQLite Durable Object boot under workerd; admin controls persist', async () => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let sends = 0;
  for (const content of [JSON.stringify({decision:'allow',category:'safe',confidence:0.99}), 'Привет! Следим за игровыми новостями.', JSON.stringify({decision:'allow',category:'safe',confidence:0.99})]) {
    fetchMock.get('https://api.deepseek.com').intercept({path:'/chat/completions',method:'POST'}).reply(200, JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
  }
  fetchMock.get('https://api.vk.com').intercept({ path: '/method/messages.send', method: 'POST' }).reply(200, () => { sends++; return JSON.stringify({response:1}); }).persist();
  const bundle = await build({ entryPoints: [new URL('../worker.js', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare({ fetchMock, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-30', durableObjects: { MANAGER: { className: 'ManagerState', useSQLite: true } },
    bindings: { ENVIRONMENT: 'production', KILL_SWITCH: 'off', VK_GROUP_ID: '123', AGC_ADMIN_KEY: 'a'.repeat(32),
      VK_CALLBACK_SECRET: 'secret', VK_CONFIRMATION_CODE: 'confirm', AUTO_REPLY: 'on', AUTO_POST: 'on',
      VK_TOKEN: 'group', VK_USER_TOKEN: 'user', DEEPSEEK_API_KEY: 'mock' } });
  try {
    const response = await mf.dispatchFetch('https://test/health'); assert.equal(response.status, 200);
    const health = await response.json(); assert.equal(health.stateConfigured, true); assert.equal(health.postingActive, true);
    const headers = { Authorization: 'Bearer ' + 'a'.repeat(32) };
    const pause = await mf.dispatchFetch('https://test/api/pause', { method: 'POST', headers }); assert.equal(pause.status, 200);
    assert.equal((await (await mf.dispatchFetch('https://test/health')).json()).postingActive, false);
    const status = await (await mf.dispatchFetch('https://test/api/status', { headers })).json(); assert.equal(status.paused, true);
    assert.equal(status.audit.at(-1).type, 'paused');
    const confirmation = await mf.dispatchFetch('https://test/vk/callback', { method: 'POST', body: JSON.stringify({ type: 'confirmation', group_id: 123, secret: 'secret' }) });
    assert.equal(await confirmation.text(), 'confirm');
    const resume = await mf.dispatchFetch('https://test/api/resume', { method: 'POST', headers }); assert.equal(resume.status, 200);
    assert.equal((await (await mf.dispatchFetch('https://test/health')).json()).postingActive, true);
    const event = {type:'message_new',group_id:123,secret:'secret',object:{message:{id:1,from_id:42,peer_id:42,text:'Привет!'}}};
    const callbacks = await Promise.all(Array.from({length:10}, () => mf.dispatchFetch('https://test/vk/callback', {method:'POST',body:JSON.stringify(event)})));
    assert.ok(callbacks.every(r => r.status === 200));
    for (let i=0; i<40 && sends===0; i++) await new Promise(r=>setTimeout(r,100));
    const completed = await (await mf.dispatchFetch('https://test/api/status',{headers})).json();
    assert.equal(sends,1,JSON.stringify(completed));
    assert.equal(completed.usage.calls,3);

  } finally { await mf.dispose(); }
});

test('real SQLite alarms discover a new RSS article, fact-check and publish it once with community auth', async () => {
  const fetchMock = createFetchMock(); fetchMock.disableNetConnect();
  const source = SOURCES[0]; let reads = 0, sends = 0;
  const body = 'A new adventure game has been announced for PlayStation 5. Players will explore a fictional island and solve environmental puzzles. The studio says cooperative play supports two players. The announcement does not provide a release date or regional pricing. These are planned features described by the developer, not a review of a released game.';
  const quote1 = 'A new adventure game has been announced for PlayStation 5.';
  const quote2 = 'Players will explore a fictional island and solve environmental puzzles.';
  const quote3 = 'The studio says cooperative play supports two players.';
  const draft = { skip: false, category: 'news', headline: { text: 'Для PlayStation 5 анонсирована новая приключенческая игра', quote: quote1 }, facts: [{ text: 'Игрокам предстоит исследовать вымышленный остров и решать головоломки.', quote: quote2 }, { text: 'Студия заявляет поддержку кооператива для двух игроков.', quote: quote3 }] };
  fetchMock.get('https://blog.playstation.com').intercept({ path: '/feed/', method: 'GET' }).reply(200, () => {
    reads++;
    const items = reads === 1 ? '' : `<item><title>New adventure game for PlayStation 5</title><link>https://blog.playstation.com/2026/11/22/new-adventure/</link><pubDate>${new Date().toUTCString()}</pubDate><description>${body}</description></item>`;
    return `<rss><channel><title>Official news</title>${items}</channel></rss>`;
  }).persist();
  fetchMock.get('https://news.xbox.com').intercept({ path: '/en-us/feed/', method: 'GET' }).reply(200, '<rss><channel><title>Xbox Wire</title></channel></rss>').persist();
  for (const content of [draft, { decision: 'supported', duplicate: false, checks: [quote1, quote2, quote3].map((quote, index) => ({ index, supported: true, quote })) }, { decision: 'allow', category: 'safe', confidence: .99 }]) {
    fetchMock.get('https://api.deepseek.com').intercept({ path: '/chat/completions', method: 'POST' }).reply(200, JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }));
  }
  fetchMock.get('https://api.vk.com').intercept({ path: '/method/wall.post', method: 'POST' }).reply(200, async options => {
    const params = new URLSearchParams(await new Response(options.body).text()); assert.equal(params.get('access_token'), 'community');
    assert.equal(params.get('owner_id'), '-123'); assert.equal(params.get('from_group'), '1');
    assert.match(params.get('message'), /Источник: PlayStation Blog/); sends++;
    return JSON.stringify({ response: { post_id: 77 } });
  }).persist();
  const bundle = await build({ entryPoints: [new URL('../worker.js', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare({ fetchMock, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-30', durableObjects: { MANAGER: { className: 'ManagerState', useSQLite: true } },
    bindings: { ENVIRONMENT: 'production', KILL_SWITCH: 'off', AUTO_POST: 'on', VK_TOKEN: 'community', VK_GROUP_ID: '123', DEEPSEEK_API_KEY: 'mock', AGC_ADMIN_KEY: 'a'.repeat(32) } });
  try {
    const ns = await mf.getDurableObjectNamespace('MANAGER'), stub = ns.get(ns.idFromName('group:123'));
    const enqueue = id => stub.fetch('https://manager/enqueue', { method: 'POST', body: JSON.stringify({ id, kind: 'scan' }) });
    const status = async () => (await stub.fetch('https://manager/status')).json();
    await enqueue('scan:baseline');
    for (let i = 0; i < 60 && !(await status()).news; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await status()).news.sources[0].baseline, true, JSON.stringify(await status())); assert.equal(sends, 0);
    await enqueue('scan:new');
    for (let i = 0; i < 100 && !(await status()).recent.length; i++) await new Promise(r => setTimeout(r, 100));
    const completed = await status(); assert.equal(sends, 1, JSON.stringify(completed)); assert.equal(completed.recent[0].postId, 77); assert.equal(completed.usage.calls, 3);
    await enqueue('scan:new'); await enqueue('scan:again');
    for (let i = 0; i < 60 && (await status()).queue; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(sends, 1);
    const health = await (await mf.dispatchFetch('https://test/health')).json(); assert.equal(health.lastPublication.url, 'https://vk.com/wall-123_77');
  } finally { await mf.dispose(); }
});
