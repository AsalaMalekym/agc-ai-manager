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

test('real alarms verify a Telegram lead against Nintendo, then check every generated claim before publishing', async () => {
  const fetchMock=createFetchMock();fetchMock.disableNetConnect();let reads=0,sends=0;
  const primary='https://www.nintendo.com/us/whatsnew/island-adventure/';
  const quote1='Nintendo announced a cooperative island adventure for two players.';
  const quote2='Players explore a fictional island and solve environmental puzzles together.';
  const quote3='The studio has not announced a release date for this new game.';
  const body=quote1+' '+quote2+' '+quote3+' The studio describes these as planned features. No additional platforms or regional pricing were confirmed. These are announcements from the developer, not an independent review of a completed game.';
  fetchMock.get('https://t.me').intercept({path:'/s/stopgamenews',method:'GET'}).reply(200,()=>{
    reads++;return `<div class="tgme_widget_message" data-post="stopgamenews/${reads===1?1:2}"><div class="tgme_widget_message_text">${quote1}<a href="${primary}">Official source</a></div><time datetime="${new Date().toISOString()}"></time></div>`;
  }).persist();
  for(const source of SOURCES){const url=new URL(source.feed);fetchMock.get(url.origin).intercept({path:url.pathname,method:'GET'}).reply(200,'<rss><channel><title>Official news</title></channel></rss>').persist();}
  fetchMock.get('https://www.nintendo.com').intercept({path:'/us/whatsnew/island-adventure/',method:'GET'}).reply(200,()=>`<html><head><meta property="og:title" content="Nintendo announces a new island game"><meta property="article:published_time" content="${new Date().toISOString()}"></head><body><article>${body}</article></body></html>`,{headers:{'content-type':'text/html'}}).persist();
  const draft={skip:false,category:'news',headline:{text:'Nintendo анонсировала кооперативное приключение для двух игроков',quote:quote1},facts:[{text:'Игрокам предстоит исследовать вымышленный остров и вместе решать головоломки.',quote:quote2},{text:'Студия пока не объявила дату выхода новой игры.',quote:quote3}]};
  for(const content of [{decision:'news',reason:'gaming_news',claims:[quote1],searchTerms:['Nintendo']},{decision:'supported',sourceUrl:primary,checks:[{claim:quote1,quote:quote1}]},draft,{decision:'supported',duplicate:false,checks:[quote1,quote2,quote3].map((quote,index)=>({index,supported:true,quote}))},{decision:'allow',category:'safe',confidence:.99}]){
    fetchMock.get('https://api.deepseek.com').intercept({path:'/chat/completions',method:'POST'}).reply(200,JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]}));
  }
  fetchMock.get('https://api.vk.com').intercept({path:'/method/wall.post',method:'POST'}).reply(200,async options=>{
    const params=new URLSearchParams(await new Response(options.body).text());assert.ok(params.get('message').endsWith(primary));assert.match(params.get('message'),/Источник: Nintendo/);sends++;return JSON.stringify({response:{post_id:88}});
  });
  const bundle=await build({entryPoints:[new URL('../worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const mf=new Miniflare({fetchMock,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{MANAGER:{className:'ManagerState',useSQLite:true}},bindings:{ENVIRONMENT:'production',KILL_SWITCH:'off',AUTO_POST:'on',VK_TOKEN:'community',VK_GROUP_ID:'123',DEEPSEEK_API_KEY:'mock',AGC_ADMIN_KEY:'a'.repeat(32)}});
  try{
    const ns=await mf.getDurableObjectNamespace('MANAGER'),stub=ns.get(ns.idFromName('group:123'));
    const config=()=>stub.fetch('https://manager/sources',{method:'POST',body:JSON.stringify({telegram:['stopgamenews'],vk:[],x:[],bluesky:[]})});
    const status=async()=>(await stub.fetch('https://manager/status')).json();
    const enqueue=id=>stub.fetch('https://manager/enqueue',{method:'POST',body:JSON.stringify({id,kind:'scan'})});
    await config();await enqueue('scan:social-baseline');
    for(let i=0;i<60&&!(await status()).news;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal((await status()).news.sources[2].baseline,true);assert.equal(sends,0);
    await config();await enqueue('scan:social-new');
    for(let i=0;i<140&&!(await status()).recent.length;i++)await new Promise(r=>setTimeout(r,100));
    const result=await status();assert.equal(sends,1,JSON.stringify(result));assert.equal(result.usage.calls,5);assert.equal(result.pendingLeads.length,0);assert.equal(result.recent[0].discovery.url,'https://t.me/stopgamenews/2');assert.equal(result.paused,false);
  }finally{await mf.dispose();}
});

test('real SQLite alarms publish a social lead corroborated by two editorial sites without an official article', async () => {
  const fetchMock=createFetchMock();fetchMock.disableNetConnect();let reads=0,sends=0;
  const primary='https://stopgame.ru/newsdata/123456/island_adventure';
  const second='https://www.gematsu.com/2026/11/island-adventure';
  const quote1='Nintendo announced a cooperative island adventure for two players.';
  const quote2='Players explore a fictional island and solve environmental puzzles together.';
  const quote3='The studio has not announced a release date for this new game.';
  const body=quote1+' '+quote2+' '+quote3+' The studio describes these as planned features. No additional platforms or regional pricing were confirmed. These are announcements from the developer, not an independent review of a completed game.';
  fetchMock.get('https://t.me').intercept({path:'/s/stopgamenews',method:'GET'}).reply(200,()=>{
    reads++;return `<div class="tgme_widget_message" data-post="stopgamenews/${reads===1?1:2}"><div class="tgme_widget_message_text">${quote1}<a href="${primary}">Official source</a></div><time datetime="${new Date().toISOString()}"></time></div>`;
  }).persist();
  for(const source of SOURCES){const url=new URL(source.feed);fetchMock.get(url.origin).intercept({path:url.pathname,method:'GET'}).reply(200,'<rss><channel><title>Official news</title></channel></rss>').persist();}
  fetchMock.get('https://stopgame.ru').intercept({path:'/newsdata/123456/island_adventure',method:'GET'}).reply(200,()=>`<html><head><meta property="og:title" content="Nintendo announces a new island game"><meta property="article:published_time" content="${new Date().toISOString()}"></head><body><article>${body}</article></body></html>`,{headers:{'content-type':'text/html'}}).persist();
  const secondBody=quote1+' '+quote2+' '+quote3+' Our newsroom contacted the publishing team for a separate confirmation. They verified the cooperative announcement during an interview. Availability and pricing remain unspecified, and development is ongoing. The team declined to discuss its longer term roadmap.';
  fetchMock.get('https://www.gematsu.com').intercept({path:'/feed',method:'GET'}).reply(200,()=>`<rss><channel><item><title>Nintendo island adventure announced</title><link>${second}</link><pubDate>${new Date().toUTCString()}</pubDate><description>Cooperative adventure for two players.</description></item></channel></rss>`).persist();
  fetchMock.get('https://www.gematsu.com').intercept({path:'/2026/11/island-adventure',method:'GET'}).reply(200,()=>`<html><meta property="og:title" content="Nintendo island adventure announced"><meta property="article:published_time" content="${new Date().toISOString()}"><article>${secondBody}</article></html>`,{headers:{'content-type':'text/html'}}).persist();
  const draft={skip:false,category:'news',headline:{text:'Nintendo анонсировала кооперативное приключение для двух игроков',quote:quote1},facts:[{text:'Игрокам предстоит исследовать вымышленный остров и вместе решать головоломки.',quote:quote2},{text:'Студия пока не объявила дату выхода новой игры.',quote:quote3}]};
  for(const content of [{decision:'news',reason:'gaming_news',claims:[quote1],searchTerms:['Nintendo']},{decision:'supported',sourceUrls:[primary,second],relationship:'independent',checks:[{index:0,evidence:[{url:primary,quote:quote1},{url:second,quote:quote1}]}]},draft,{decision:'supported',duplicate:false,checks:[quote1,quote2,quote3].map((quote,index)=>({index,supported:true,quote,corroboratingQuote:quote}))},{decision:'allow',category:'safe',confidence:.99}]){
    fetchMock.get('https://api.deepseek.com').intercept({path:'/chat/completions',method:'POST'}).reply(200,JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]}));
  }
  fetchMock.get('https://api.vk.com').intercept({path:'/method/wall.post',method:'POST'}).reply(200,async options=>{
    const params=new URLSearchParams(await new Response(options.body).text());assert.ok(params.get('message').includes(primary));assert.ok(params.get('message').includes(second));sends++;return JSON.stringify({response:{post_id:88}});
  });
  const bundle=await build({entryPoints:[new URL('../worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const mf=new Miniflare({fetchMock,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{MANAGER:{className:'ManagerState',useSQLite:true}},bindings:{ENVIRONMENT:'production',KILL_SWITCH:'off',AUTO_POST:'on',VK_TOKEN:'community',VK_GROUP_ID:'123',DEEPSEEK_API_KEY:'mock',AGC_ADMIN_KEY:'a'.repeat(32)}});
  try{
    const ns=await mf.getDurableObjectNamespace('MANAGER'),stub=ns.get(ns.idFromName('group:123'));
    const config=()=>stub.fetch('https://manager/sources',{method:'POST',body:JSON.stringify({telegram:['stopgamenews'],vk:[],x:[],bluesky:[]})});
    const status=async()=>(await stub.fetch('https://manager/status')).json();
    const enqueue=id=>stub.fetch('https://manager/enqueue',{method:'POST',body:JSON.stringify({id,kind:'scan'})});
    await config();await enqueue('scan:social-baseline');
    for(let i=0;i<60&&!(await status()).news;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal((await status()).news.sources[2].baseline,true);assert.equal(sends,0);
    await config();await enqueue('scan:social-new');
    for(let i=0;i<140&&!(await status()).recent.length;i++)await new Promise(r=>setTimeout(r,100));
    const result=await status();assert.equal(sends,1,JSON.stringify(result));assert.equal(result.usage.calls,5);assert.equal(result.pendingLeads.length,0);assert.equal(result.recent[0].discovery.url,'https://t.me/stopgamenews/2');assert.equal(result.paused,false);assert.equal(result.editor.counts.verified,1);assert.equal(result.editor.counts.published,1);
  }finally{await mf.dispose();}
});

test('real alarms follow a DTF redirect wrapper to a press release and publish one attributed news post', async () => {
  const fetchMock=createFetchMock();fetchMock.disableNetConnect();let reads=0,sends=0;
  const primary='https://www.gamespress.com/Island-Adventure---New-Announcement';
  const quote1='Nintendo announced a cooperative island adventure for two players.';
  const quote2='Players explore a fictional island and solve environmental puzzles together.';
  const quote3='The studio has not announced a release date for this new game.';
  const body=quote1+' '+quote2+' '+quote3+' The studio describes these as planned features. No additional platforms or regional pricing were confirmed. These are announcements from the developer, not an independent review of a completed game.';
  fetchMock.get('https://t.me').intercept({path:'/s/stopgamenews',method:'GET'}).reply(200,()=>{
    reads++;return `<div class="tgme_widget_message" data-post="stopgamenews/${reads===1?1:2}"><div class="tgme_widget_message_text">${quote1}<a href="https://dtf.ru/games/5398691">Announcement</a></div><time datetime="${new Date().toISOString()}"></time></div>`;
  }).persist();
  for(const source of SOURCES){const url=new URL(source.feed);fetchMock.get(url.origin).intercept({path:url.pathname,method:'GET'}).reply(200,'<rss><channel><title>Official news</title></channel></rss>').persist();}
  fetchMock.get('https://www.gamespress.com').intercept({path:'/Island-Adventure---New-Announcement',method:'GET'}).reply(200,()=>`<html><head><meta property="og:title" content="Nintendo announces a new island game"><meta property="article:published_time" content="${new Date().toISOString()}"></head><body><span class="jq-newsType">Press release</span><article>${body}</article></body></html>`,{headers:{'content-type':'text/html'}}).persist();
  fetchMock.get('https://dtf.ru').intercept({path:'/games/5398691',method:'GET'}).reply(200,`<article><a href="https://api.dtf.ru/v2.8/redirect?to=${encodeURIComponent(primary)}">Announcement</a></article>`,{headers:{'content-type':'text/html'}}).persist();
  const draft={skip:false,category:'news',headline:{text:'Nintendo анонсировала кооперативное приключение для двух игроков',quote:quote1},facts:[{text:'Игрокам предстоит исследовать вымышленный остров и вместе решать головоломки.',quote:quote2},{text:'Студия пока не объявила дату выхода новой игры.',quote:quote3}]};
  for(const content of [{decision:'news',reason:'gaming_news',claims:[quote1],searchTerms:['Nintendo']},{decision:'supported',sourceUrl:primary,checks:[{claim:quote1,quote:quote1}]},draft,{decision:'supported',duplicate:false,checks:[quote1,quote2,quote3].map((quote,index)=>({index,supported:true,quote}))},{decision:'allow',category:'safe',confidence:.99}]){
    fetchMock.get('https://api.deepseek.com').intercept({path:'/chat/completions',method:'POST'}).reply(200,JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]}));
  }
  fetchMock.get('https://api.vk.com').intercept({path:'/method/wall.post',method:'POST'}).reply(200,async options=>{
    const params=new URLSearchParams(await new Response(options.body).text());assert.ok(params.get('message').endsWith(primary));assert.match(params.get('message'),/По пресс-релизу Games Press/);sends++;return JSON.stringify({response:{post_id:88}});
  });
  const bundle=await build({entryPoints:[new URL('../worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const mf=new Miniflare({fetchMock,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{MANAGER:{className:'ManagerState',useSQLite:true}},bindings:{ENVIRONMENT:'production',KILL_SWITCH:'off',AUTO_POST:'on',VK_TOKEN:'community',VK_GROUP_ID:'123',DEEPSEEK_API_KEY:'mock',AGC_ADMIN_KEY:'a'.repeat(32)}});
  try{
    const ns=await mf.getDurableObjectNamespace('MANAGER'),stub=ns.get(ns.idFromName('group:123'));
    const config=()=>stub.fetch('https://manager/sources',{method:'POST',body:JSON.stringify({telegram:['stopgamenews'],vk:[],x:[],bluesky:[]})});
    const status=async()=>(await stub.fetch('https://manager/status')).json();
    const enqueue=id=>stub.fetch('https://manager/enqueue',{method:'POST',body:JSON.stringify({id,kind:'scan'})});
    await config();await enqueue('scan:social-baseline');
    for(let i=0;i<60&&!(await status()).news;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal((await status()).news.sources[2].baseline,true);assert.equal(sends,0);
    await config();await enqueue('scan:social-new');
    for(let i=0;i<140&&!(await status()).recent.length;i++)await new Promise(r=>setTimeout(r,100));
    const result=await status();assert.equal(sends,1,JSON.stringify(result));assert.equal(result.usage.calls,5);assert.equal(result.pendingLeads.length,0);assert.equal(result.recent[0].discovery.url,'https://t.me/stopgamenews/2');assert.equal(result.paused,false);
  }finally{await mf.dispose();}
});
