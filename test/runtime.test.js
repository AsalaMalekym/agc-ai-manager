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

for (const mixed of [false,true]) test('real SQLite alarms verify and publish archive content with cooldown; mixed='+mixed, async () => {
 const fetchMock=createFetchMock();fetchMock.disableNetConnect();let sends=0;
 const url='https://blog.playstation.com/2020/03/10/island-design/';
 const q1='The developers created the island using handmade paper models during production.';
 const q2='The art team photographed these models to guide the shapes of the game environments.';
 const body=q1+' '+q2+' The developers described this process in an interview about the original game. The artists used these prototypes to discuss the layout before they built digital environments. This account concerns completed development, not a promise of future content.';
 for(const source of SOURCES){const u=new URL(source.feed);fetchMock.get(u.origin).intercept({path:u.pathname,method:'GET'}).reply(200,'<rss><channel><title>News</title></channel></rss>').persist();}
 fetchMock.get('https://blog.playstation.com').intercept({path:mixed?'/feed/?s=making+of':'/feed/?s=behind+the+scenes',method:'GET'}).reply(200,`<rss><channel><item><title>Behind the scenes: designing the island</title><link>${url}</link><pubDate>Tue, 10 Mar 2020 12:00:00 GMT</pubDate><description>${body}</description></item></channel></rss>`).persist();
 const draft={skip:false,category:mixed?'development':'fact',headline:{text:'Разработчики игры создавали остров из бумажных макетов',quote:q1},facts:[{text:'При разработке острова команда делала бумажные модели вручную.',quote:q1},{text:'Художники фотографировали макеты, чтобы определить формы игрового окружения.',quote:q2}]};
 for(const content of [draft,{decision:'supported',categorySupported:true,historicalContext:true,evergreen:true,duplicate:false,checks:[q1,q1,q2].map((quote,index)=>({index,supported:true,quote}))},{decision:'allow',category:'safe',confidence:1}])fetchMock.get('https://api.deepseek.com').intercept({path:'/chat/completions',method:'POST'}).reply(200,JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]}));
 fetchMock.get('https://api.vk.com').intercept({path:'/method/wall.post',method:'POST'}).reply(200,async options=>{
  const p=new URLSearchParams(await new Response(options.body).text());assert.match(p.get('message'),mixed?/История создания игр/:/Игровой факт/);assert.match(p.get('message'),/10\.03\.2020/);assert.equal(p.get('access_token'),'community');sends++;return JSON.stringify({response:{post_id:109}});
 }).persist();
 // Test-only seeding lets a real SQLite object start after two hours of news silence.
 const bundle=await build({stdin:{contents:`import worker from './worker.js';import {ManagerState} from './src/manager.js';export default worker;export class TestManager extends ManagerState {async fetch(r){if(new URL(r.url).pathname==='/seed-test'){await this.store.put('factsState',{startedAt:Date.now()-10800000,lastNewsAt:Date.now()-10800000,cursor:${mixed?6:0}});return new Response('ok');}return super.fetch(r);}}`,resolveDir:new URL('..',import.meta.url).pathname},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const mf=new Miniflare({fetchMock,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{MANAGER:{className:'TestManager',useSQLite:true}},bindings:{ENVIRONMENT:'production',KILL_SWITCH:'off',AUTO_POST:'on',AUTO_FACTS:'on',AUTO_MIXED:mixed?'on':'off',VK_TOKEN:'community',VK_GROUP_ID:'123',DEEPSEEK_API_KEY:'mock',AGC_ADMIN_KEY:'a'.repeat(32)}});
 try{
  const ns=await mf.getDurableObjectNamespace('MANAGER'),stub=ns.get(ns.idFromName('group:123'));
  await stub.fetch('https://manager/seed-test');
  await stub.fetch('https://manager/sources',{method:'POST',body:JSON.stringify({telegram:[],vk:[],x:[],bluesky:[]})});
  const status=async()=>(await stub.fetch('https://manager/status')).json();
  const enqueue=id=>stub.fetch('https://manager/enqueue',{method:'POST',body:JSON.stringify({id,kind:'scan'})});
  await enqueue('scan:fact');
  for(let i=0;i<120&&!(await status()).recent.length;i++)await new Promise(r=>setTimeout(r,100));
  const done=await status();assert.equal(sends,1,JSON.stringify(done));assert.equal(done.facts.sent,mixed?0:1);assert.equal(mixed?done.content.eligible:done.facts.eligible,false);assert.equal(done.recent[0].topic,mixed?'development':'fact');assert.equal(done.usage.calls,3);
  await enqueue('scan:fact-again');for(let i=0;i<60&&(await status()).queue;i++)await new Promise(r=>setTimeout(r,100));assert.equal(sends,1);
  assert.equal((await (await mf.dispatchFetch('https://test/health')).json()).facts.dailyLimit,8);
 }finally{await mf.dispose();}
});

test('real SQLite alarm publishes generated PNG and verified text together, with honest health status',async()=>{
 const fetchMock=createFetchMock();fetchMock.disableNetConnect();let sends=0,uploads=0;
 const q1='The studio announced an island adventure with environmental puzzles.';
 const q2='The developers plan cooperative play for two players in this adventure.';
 const article={sourceId:'xbox',sourceName:'Xbox Wire',url:'https://news.xbox.com/en-us/2026/11/23/island/',title:'Studio announces cooperative island adventure',publishedAt:Date.now(),body:q1+' '+q2+' The game is currently in development and these features are planned. Players will explore an imaginary environment. The studio has not given a release date. This is an announcement rather than a review of a finished game and does not promise any particular performance.'};
 const draft={skip:false,category:'news',headline:{text:'Студия анонсировала островное приключение с головоломками',quote:q1},facts:[{text:'Студия представила приключенческую игру с головоломками на острове.',quote:q1},{text:'Разработчики планируют кооперативный режим для двух игроков.',quote:q2}]};
 const verdict={decision:'allow',category:'safe',confidence:1};
 for(const content of [draft,{decision:'supported',duplicate:false,checks:[q1,q1,q2].map((quote,index)=>({index,supported:true,quote}))},verdict,{prompt:'Stylized original editorial illustration of two fictional adult explorers solving a glowing puzzle on a floating island, clean outlines and blue light.'},verdict])fetchMock.get('https://api.deepseek.com').intercept({path:'/chat/completions',method:'POST'}).reply(200,JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]}));
 fetchMock.get('https://api.vk.com').intercept({path:'/method/photos.getWallUploadServer',method:'POST'}).reply(200,JSON.stringify({response:{upload_url:'https://pu.vk.com/upload'}})).persist();
 fetchMock.get('https://pu.vk.com').intercept({path:'/upload',method:'POST'}).reply(200,async options=>{const bytes=await new Response(options.body).text();assert.match(bytes,/image\/png/);uploads++;return JSON.stringify({server:7,photo:'[{"photo":"one"}]',hash:'test'});});
 fetchMock.get('https://api.vk.com').intercept({path:'/method/photos.saveWallPhoto',method:'POST'}).reply(200,JSON.stringify({response:[{owner_id:-123,id:222}]}));
 fetchMock.get('https://api.vk.com').intercept({path:'/method/wall.post',method:'POST'}).reply(200,async options=>{const p=new URLSearchParams(await new Response(options.body).text());assert.equal(p.get('attachments'),'photo-123_222');assert.equal(p.get('access_token'),'community');assert.match(p.get('message'),/Иллюстрация сгенерирована ИИ/);sends++;return JSON.stringify({response:{post_id:333}});});
 const bundle=await build({stdin:{contents:`import worker from './worker.js';import {ManagerState} from './src/manager.js';export default worker;export class TestImageManager extends ManagerState {constructor(ctx,env){super(ctx,{...env,AI:{run:async()=>({image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3sAAAAASUVORK5CYII='})}})}}`,resolveDir:new URL('..',import.meta.url).pathname},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const mf=new Miniflare({fetchMock,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{MANAGER:{className:'TestImageManager',useSQLite:true}},bindings:{ENVIRONMENT:'production',KILL_SWITCH:'off',AUTO_POST:'on',GENERATE_IMAGES:'on',MAX_AI_CALLS_PER_DAY:'2000',VK_TOKEN:'community',VK_PHOTO_TOKEN:'photos',VK_GROUP_ID:'123',DEEPSEEK_API_KEY:'mock',AGC_ADMIN_KEY:'a'.repeat(32)}});
 try{
  const ns=await mf.getDurableObjectNamespace('MANAGER'),stub=ns.get(ns.idFromName('group:123'));
  await stub.fetch('https://manager/enqueue',{method:'POST',body:JSON.stringify({id:'image-runtime',kind:'post',article})});
  const status=async()=>(await stub.fetch('https://manager/status')).json();
  for(let i=0;i<100&&!(await status()).recent.length;i++)await new Promise(r=>setTimeout(r,100));
  const state=await status();assert.equal(sends,1,JSON.stringify(state));assert.equal(uploads,1);assert.equal(state.usage.calls,6);assert.equal(state.images.active,true);assert.ok(state.images.lastPublishedAt);
  const health=await (await mf.dispatchFetch('https://test/health')).json();assert.equal(health.imageGeneration,true);assert.equal(health.lastPublication.hasGeneratedImage,true);
  await stub.fetch('https://manager/enqueue',{method:'POST',body:JSON.stringify({id:'image-runtime',kind:'post',article})});assert.equal(sends,1);
 }finally{await mf.dispose();}
});

test('server photo authorization runs in workerd with encrypted SQLite storage and protected endpoints',async()=>{
 const fetchMock=createFetchMock();fetchMock.disableNetConnect();let exchanges=0,probes=0;
 fetchMock.get('https://oauth.vk.com').intercept({path:'/access_token',method:'POST'}).reply(200,()=>{exchanges++;return JSON.stringify({access_token:'runtime-private-photo-credential',expires_in:3600});});
 fetchMock.get('https://api.vk.com').intercept({path:'/method/photos.getWallUploadServer',method:'POST'}).reply(200,()=>{probes++;return JSON.stringify({response:{upload_url:'https://pu.vk.com/upload'}});});
 const bundle=await build({entryPoints:[new URL('../worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const mf=new Miniflare({fetchMock,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{MANAGER:{className:'ManagerState',useSQLite:true}},bindings:{ENVIRONMENT:'production',KILL_SWITCH:'off',VK_GROUP_ID:'123',AGC_ADMIN_KEY:'a'.repeat(32),VK_APP_SECRET:'runtime-private-app-secret',VK_TOKEN:'group',GENERATE_IMAGES:'on'}});
 try{
  const headers={Authorization:'Bearer '+'a'.repeat(32),'content-type':'application/json'};
  assert.equal((await mf.dispatchFetch('https://test/api/photo-auth/start',{method:'POST'})).status,401);
  const start=await (await mf.dispatchFetch('https://test/api/photo-auth/start',{method:'POST',headers})).json();assert.equal(start.ok,true);
  const state=new URL(start.authorizeUrl).searchParams.get('state'),redirectUrl='https://oauth.vk.ru/blank.html#'+new URLSearchParams({code:'runtime-code',state});
  const finish=await mf.dispatchFetch('https://test/api/photo-auth/finish',{method:'POST',headers,body:JSON.stringify({redirectUrl})});const result=await finish.json();assert.equal(finish.status,200,JSON.stringify(result));assert.equal(result.uploadVerified,true);assert.ok(result.expiresAt>Date.now());
  assert.equal(exchanges,1);assert.equal(probes,1);
  const health=await (await mf.dispatchFetch('https://test/health')).json();assert.equal(health.images.tokenKind,'server');assert.equal(health.images.uploadVerified,true);assert.ok(!JSON.stringify(health).includes('runtime-private'));
  const replay=await mf.dispatchFetch('https://test/api/photo-auth/finish',{method:'POST',headers,body:JSON.stringify({redirectUrl})});assert.equal(replay.status,400);assert.equal(exchanges,1);
 }finally{await mf.dispose();}
});
