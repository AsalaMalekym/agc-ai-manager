import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyLead,parseEditorialFeed,fetchEditorialFeed,rankCandidates,collectEvidence,pairPolicy,verifyEditorialLead,POLICY_VERSION} from '../src/editorial.js';
import {EDITORIAL,evidenceSource,validArticle} from '../src/source-policy.js';
import {parseArticle} from '../src/social.js';
import {createNews,newsId} from '../src/news.js';
import {ManagerState} from '../src/manager.js';
const now=Date.now();
const fact='Aurora Island launches on 15 December for PC and Xbox.';
const extra='The adventure includes a cooperative mode for two players.';
const a={sourceId:'stopgame',sourceName:'StopGame',url:'https://stopgame.ru/newsdata/99999/aurora',title:'Aurora Island release announced',publishedAt:now-1000,body:fact+' '+extra+' This report describes the details revealed about the new island adventure. The game combines environmental puzzles with cooperative exploration. Developers have outlined the planned features in advance of release. This article does not provide any sales forecasts or review scores.',references:[]};
const b={sourceId:'gematsu',sourceName:'Gematsu',url:'https://www.gematsu.com/2026/11/aurora-release',title:'Aurora Island gets a December release date',publishedAt:now-1000,body:'PC and Xbox players can look forward to an island journey. '+fact+' '+extra+' The announcement was covered by our games desk following confirmation of the release plans. The two adventurers will travel together, overcoming challenges scattered across several island regions. Further details about distribution have not been shared.',references:[]};
const item={sourceId:'telegram:stopgamenews',sourceName:'Telegram',platform:'telegram',url:'https://t.me/stopgamenews/99999',text:fact,links:[a.url],publishedAt:now-1000,attempts:0,nextAttempt:0,classification:{decision:'news',claims:[fact],searchTerms:['Aurora Island']}};
const accepted={decision:'supported',relationship:'independent',sourceUrls:[a.url,b.url],checks:[{index:0,evidence:[{url:a.url,quote:fact},{url:b.url,quote:fact}]}]};
class Storage{data=new Map();alarm=null;async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async delete(k){for(const s of Array.isArray(k)?k:[k])this.data.delete(s);}async list({prefix='',limit=10000}={}){return new Map([...this.data].filter(([k])=>k.startsWith(prefix)).sort().slice(0,limit));}async transaction(fn){return fn(this);}async getAlarm(){return this.alarm;}async setAlarm(v){this.alarm=v;}}
function manager(){const store=new Storage(),m=new ManagerState({storage:store},{ENVIRONMENT:'production',KILL_SWITCH:'off',AUTO_POST:'on',VK_TOKEN:'mock',VK_GROUP_ID:'123'});return {store,m};}

test('classification excludes personal posts, community housekeeping, ads and rumors',async()=>{
 for(const reason of ['personal','community','advertising','giveaway','meme','off_topic','opinion','rumor'])assert.deepEqual(await classifyLead(item,async()=>({decision:'ignore',reason})),{decision:'ignore',reason});
});
test('classification must extract real factual fragments, not invent news',async()=>{
 await assert.rejects(()=>classifyLead(item,async()=>({decision:'news',reason:'gaming_news',claims:['The studio announced an entirely different game.']})),/NEWS_CLASSIFICATION_INVALID/);
 const result=await classifyLead(item,async()=>({decision:'news',reason:'gaming_news',claims:[fact],searchTerms:['Aurora Island']}));assert.equal(result.claims[0],fact);
});
test('editorial index accepts short RSS summaries but never treats them as complete evidence',()=>{
 const xml=`<rss><channel><item><title>${a.title}</title><link>${a.url}</link><pubDate>${new Date(now).toUTCString()}</pubDate><description>Short description.</description></item></channel></rss>`;
 const rows=parseEditorialFeed(xml,EDITORIAL.find(s=>s.id==='stopgame'));assert.equal(rows.length,1);assert.equal(rows[0].body,undefined);assert.equal(validArticle(rows[0]),false);
 assert.throws(()=>parseEditorialFeed('<!DOCTYPE rss>'+xml,EDITORIAL.find(s=>s.id==='stopgame')),/NEWS_FEED_INVALID/);
});
test('missing RSS falls back only to the configured publisher index and returns unverified candidates',async t=>{
 const source=EDITORIAL.find(s=>s.id==='gamesradar'),url='https://www.gamesradar.com/games/rpg/aurora-island-release/';let requests=[];
 t.mock.method(globalThis,'fetch',async target=>{
  requests.push(String(target));
  return String(target)===source.feed?new Response('',{status:404}):new Response(`<a href="${url}">Aurora Island release announced</a><a href="https://evil.example/news/">A different publisher</a>`,{headers:{'content-type':'text/html'}});
 });
 const result=await fetchEditorialFeed(source,{etag:'old'});assert.deepEqual(requests,[source.feed,source.fallbackIndex]);assert.equal(result.items.length,1);assert.equal(result.items[0].url,url);assert.equal(validArticle(result.items[0]),false);assert.equal(result.items[0].publishedAt,undefined);assert.deepEqual(result.cache,{});
});
test('RSS fallback does not bypass access denial, rate limits or redirect policy',async t=>{
 const source=EDITORIAL.find(s=>s.id==='pcgamer');let status=403,calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status});});
 for(status of [403,429,503]){calls=0;await assert.rejects(()=>fetchEditorialFeed(source),/NEWS_FEED_UNAVAILABLE/);assert.equal(calls,1);}
 calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?new Response('',{status:410}):new Response('',{status:302,headers:{location:'https://evil.example/'}}));
 await assert.rejects(()=>fetchEditorialFeed(source),/NEWS_REDIRECT_REJECTED/);assert.equal(calls,2);
});
test('RSS rejected by the size or XML checks falls back to unverified index candidates',async t=>{
 const source=EDITORIAL.find(s=>s.id==='pcgamer');let calls=0,cancelled=false;
 const body=new ReadableStream({cancel(){cancelled=true;}});
 const feeds=[
  new Response(body,{headers:{'content-length':'2000001'}}),
  new Response('<rss><channel><item><description><![CDATA[<!DOCTYPE html>]]></description></item></channel></rss>')
 ];
 t.mock.method(globalThis,'fetch',async url=>{
  calls++;
  if(url===source.feed)return feeds.shift();
  assert.equal(url,source.fallbackIndex);
  return new Response('<a href="https://www.pcgamer.com/games/aurora-island-release/">Aurora Island release announced</a>',{headers:{'content-type':'text/html'}});
 });
 for(let i=0;i<2;i++){
  const result=await fetchEditorialFeed(source);
  assert.equal(result.items.length,1);
  assert.equal(validArticle(result.items[0]),false);
 }
 assert.equal(calls,4);
 assert.equal(cancelled,true);
});
test('user blogs, reviews, sponsored paths and social domains cannot masquerade as editorial evidence',()=>{
 for(const u of ['https://dtf.ru/games/999/article','https://stopgame.ru/blogs/topic/123/x','https://www.videogameschronicle.com/guide/example/','https://www.pcgamer.com/deals/example/','https://vk.com/wall-1_2'])assert.equal(evidenceSource(u),null);
});
test('candidate ranking searches game names across different publishers',()=>{
 const rows=rankCandidates(item,[{...b,summary:''},{...a,title:'Unrelated football movie premiere',summary:''}]);assert.equal(rows[0].url,b.url);assert.equal(rows.length,1);
});
test('gatherer fetches full articles from the originating site and a matching other site',async()=>{
 const requested=[];const docs=await collectEvidence(item,[],[b],async url=>{requested.push(url);return url===a.url?a:b;});assert.equal(docs.length,2);assert.deepEqual(requested,[a.url,b.url]);
});
test('one editorial report alone cannot approve publication',async()=>{
 assert.equal((await verifyEditorialLead(item,[a],()=>{assert.fail('No model call needed');})).reason,'INSUFFICIENT_INDEPENDENT_SOURCES');
});
test('two corroborating editorial reports can verify a lead without an official source',async()=>{
 assert.equal(pairPolicy(a,b).ok,true);
 const result=await verifyEditorialLead(item,[a,b],async()=>accepted);assert.equal(result.article.url,a.url);assert.equal(result.corroboration[0].url,b.url);
});
test('same owner, cited copies and a shared anonymous origin do not count as two confirmations',()=>{
 const igro={...a,url:'https://www.igromania.ru/news/123/game',sourceId:'igromania'},kanobu={...b,url:'https://kanobu.ru/news/123-game',sourceId:'kanobu'};
 assert.equal(pairPolicy(igro,kanobu).reason,'SAME_PUBLISHER');assert.equal(pairPolicy(a,{...b,references:[a.url]}).reason,'CIRCULAR_REPORTING');
 const refs=['https://x.com/rumor/status/123'];assert.equal(pairPolicy({...a,references:refs},{...b,references:refs}).reason,'SHARED_UNVERIFIED_ORIGIN');
 assert.equal(pairPolicy(a,{...b,body:a.body}).reason,'COPIED_REPORT');
});
test('common official announcement is explicitly distinguished from independent reporting',async()=>{
 const refs=['https://blog.playstation.com/2026/11/22/game-announcement/'];const aa={...a,references:refs},bb={...b,references:refs};assert.equal(pairPolicy(aa,bb).sharedOfficial,true);
 const result=await verifyEditorialLead(item,[aa,bb],async()=>({...accepted,relationship:'shared_official_statement'}));assert.ok(result.article);
 assert.equal((await verifyEditorialLead(item,[a,b],async()=>({...accepted,relationship:'shared_official_statement'}))).reason,'INSUFFICIENT_INDEPENDENT_SOURCES');
});
test('copied origin verdict, contradictory articles and fabricated evidence block approval',async()=>{
 for(const override of [{relationship:'syndicated'},{relationship:'shared_unverified_origin'},{relationship:'unknown'},{decision:'uncertain'},{checks:[{index:0,evidence:[{url:a.url,quote:fact}]}]},{checks:[{index:0,evidence:[{url:a.url,quote:fact},{url:b.url,quote:'The game was released yesterday on a different platform.'}]}]}])assert.equal(Boolean((await verifyEditorialLead(item,[a,b],async()=>({...accepted,...override}))).article),false);
});
test('only the main event is required from the lead; every final rendered claim still needs both sources',async()=>{
 const two={...item,classification:{...item.classification,claims:[fact,extra]}};
 assert.ok((await verifyEditorialLead(two,[a,b],async()=>accepted)).article);
 assert.equal((await verifyEditorialLead(two,[a,b],async()=>({...accepted,checks:[{...accepted.checks[0],index:1}]}))).reason,'INVALID_EVIDENCE');
});
const draft={skip:false,category:'release',headline:{text:'Aurora Island выйдет 15 декабря на PC и Xbox',quote:fact},facts:[{text:'Релиз приключения запланирован на 15 декабря для PC и Xbox.',quote:fact},{text:'В игре будет кооперативный режим для двух игроков.',quote:extra}]};
const verdict={decision:'supported',duplicate:false,checks:[fact,fact,extra].map((quote,index)=>({index,supported:true,quote,corroboratingQuote:quote}))};
function models(values){return async()=>structuredClone(values.shift());}
test('final editorial post cites both sites and cannot be generated from just one',async()=>{
 await assert.rejects(()=>createNews(a,[],models([]),async()=>({decision:'allow',confidence:.99}),now),/NEWS_INDEPENDENT_SOURCES_REQUIRED/);
 const post=await createNews(a,[],models([draft,verdict]),async()=>({decision:'allow',confidence:.99}),now,[b]);assert.ok(post.text.includes(a.url));assert.ok(post.text.includes(b.url+'\n\n#'));assert.deepEqual(post.sourceUrls,[a.url,b.url]);
});
test('final fact check rejects a claim absent from the second article',async()=>{
 const bad={...verdict,checks:verdict.checks.map(c=>({...c,corroboratingQuote:'This is an invented quotation that nobody published.'}))};
 await assert.rejects(()=>createNews(a,[],models([draft,bad]),async()=>({decision:'allow',confidence:.99}),now,[b]),/NEWS_FACTCHECK_REJECTED/);
});
test('existing queue is reclassified immediately once per policy version',async()=>{
 const {m,store}=manager();await store.put('pendingLeads',[{...item,reason:'NO_PRIMARY_SOURCE',evidenceKey:'old',nextAttempt:now+3600000}]);await m.migrateEditorialPolicy();
 let row=(await store.get('pendingLeads'))[0];assert.equal(row.classification,undefined);assert.equal(row.evidenceKey,undefined);assert.ok(row.nextAttempt<=Date.now());assert.equal(await store.get('editorialPolicy'),POLICY_VERSION);
 row.classification=item.classification;await store.put('pendingLeads',[row]);await m.migrateEditorialPolicy();assert.deepEqual((await store.get('pendingLeads'))[0].classification,item.classification);
});
test('ignored personal post is removed instead of occupying the verification queue',async()=>{
 const {m,store}=manager();await store.put('pendingLeads',[{...item,classification:undefined}]);m.discoveryAI=async()=>({decision:'ignore',reason:'personal'});m.loadEvidence=()=>assert.fail('No news lookup for personal posts');
 assert.equal(await m.processLead({leadUrl:item.url}),'ignored');assert.equal((await store.get('pendingLeads')).length,0);assert.equal((await m.editorialDiagnostics()).counts.ignored,1);
});
test('an ignored classification persisted before a restart is still discarded',async()=>{
 const {m,store}=manager();await store.put('pendingLeads',[{...item,classification:{decision:'ignore',reason:'community'}}]);m.discoveryAI=()=>assert.fail('No repeated classification');assert.equal(await m.processLead({leadUrl:item.url}),'ignored');
});
test('public diagnostic counts expose reasons without leaking post text or credentials',async()=>{
 const {m,store}=manager();await store.put('pendingLeads',[{...item,reason:'INSUFFICIENT_INDEPENDENT_SOURCES'}]);const summary=await m.editorialDiagnostics();assert.equal(summary.reasons.INSUFFICIENT_INDEPENDENT_SOURCES,1);assert.ok(!JSON.stringify(summary).includes(item.text));assert.ok(!JSON.stringify(summary).includes(item.url));
});

test('article parser skips video-only containers and reads the full news body',()=>{
 const html=`<meta property="og:title" content="${a.title}"><meta property="article:published_time" content="${new Date(now).toISOString()}"><article><div class="entry-content-asset entry-content-asset--video"></div><p>${a.body}</p></article>`;
 assert.equal(parseArticle(html,a.url,now).body,a.body);
});

test('a rejected draft gets one feedback-based revision and a fresh full verification',async()=>{
 const {m,store}=manager();let calls=0;const answers=[draft,{decision:'reject',duplicate:false,checks:[]},draft,verdict];
 m.callAI=async(system,data)=>{calls++;if(calls===3)assert.equal(data.revision.validationReason,'UNSUPPORTED_DRAFT');return structuredClone(answers.shift());};m.check=async()=>({decision:'allow',confidence:.99});
 const post=await m.createPost(a,[b]);assert.ok(post.text.includes(a.url));assert.equal(calls,4);assert.equal((await store.get('audit'))[0].type,'draft_revision');
});
test('revision is bounded and never turns a second failed factcheck into a post',async()=>{
 const {m}=manager();let calls=0;m.callAI=async()=>{calls++;return structuredClone(calls%2?draft:{decision:'reject',duplicate:false,checks:[]});};m.check=()=>assert.fail('Unverified draft cannot reach moderation');
 await assert.rejects(()=>m.createPost(a,[b]),/NEWS_FACTCHECK_REJECTED/);assert.equal(calls,4);
});
test('policy repair recovers only verified drafts that failed before VK sending',async()=>{
 for(const status of ['failed','sending','sent']){
  const {m,store}=manager(),id=await newsId(a.url);await store.put('audit',[{type:'social_verified',sourceUrl:a.url,corroboratingUrls:[b.url]}]);await store.put('done:'+id,{status,code:'NEWS_FACTCHECK_REJECTED'});await store.put('evidence:'+id,{article:a});await store.put('evidence:'+await newsId(b.url),{article:b});
  await m.migrateEditorialPolicy();const jobs=[...(await store.list({prefix:'queue:'})).values()];assert.equal(jobs.length,status==='failed'?1:0);if(jobs.length)assert.equal(jobs[0].corroboration[0].url,b.url);
  await m.migrateEditorialPolicy();assert.equal((await store.list({prefix:'queue:'})).size,jobs.length);
 }
});

test('a later policy migration cannot republish a successful repair of an earlier failed original job',async()=>{
 const {m,store}=manager(),id=await newsId(a.url);await store.put('audit',[{type:'social_verified',sourceUrl:a.url}]);await store.put('done:'+id,{status:'failed',code:'NEWS_FACTCHECK_REJECTED'});await store.put('evidence:'+id,{article:a});await store.put('history',[{sourceUrl:a.url,postId:123}]);await m.migrateEditorialPolicy();assert.equal((await store.list({prefix:'queue:'})).size,0);
});


test('identical social text reuses classification across sources without another AI call',async()=>{
 const {m,store}=manager();let calls=0;
 m.discoveryAI=async()=>{calls++;return {decision:'ignore',reason:'personal'};};
 const second={...item,url:item.url+'2',classification:undefined};
 await store.put('pendingLeads',[{...item,classification:undefined},second]);
 assert.equal(await m.processLead({leadUrl:item.url}),'ignored');
 assert.equal(await m.processLead({leadUrl:second.url}),'ignored');assert.equal(calls,1);
});
