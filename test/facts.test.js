import test from 'node:test';
import assert from 'node:assert/strict';
import { factDay, factEligibility, factFeed, rankFactCandidates } from '../src/facts.js';
import { parseFeed, createNews, SOURCES } from '../src/news.js';
import { validArticle, validFactArticle } from '../src/source-policy.js';
const H = 3600000, now = Date.parse('2026-11-22T12:00:00Z');
const q1 = 'The developers created the island using handmade paper models during production.';
const q2 = 'The art team photographed these models to guide the shapes of the game environments.';
const article = { sourceId:'xbox',sourceName:'Xbox Wire',url:'https://news.xbox.com/en-us/2020/03/10/island-design/',publishedAt:Date.parse('2020-03-10'),title:'Behind the scenes: designing the island',body:q1+' '+q2+' The developers described this process in an interview about the original game. These physical prototypes helped the artists discuss the environment before they built digital versions. This account concerns the development of that game, not a future announcement.' };
const draft = {skip:false,category:'fact',headline:{text:'Разработчики игры создавали остров из бумажных макетов',quote:q1},facts:[{text:'При разработке острова команда делала бумажные модели вручную.',quote:q1},{text:'Художники фотографировали макеты, чтобы определить формы игрового окружения.',quote:q2}]};
const verdict = {decision:'supported',duplicate:false,evergreen:true,checks:[q1,q1,q2].map((quote,index)=>({index,supported:true,quote}))};
const run = (v=verdict,d=draft) => {let n=0;return createNews(article,[],async()=>n++===0?structuredClone(d):structuredClone(v),async()=>({decision:'allow',confidence:1}),now,[],null,'fact');};

test('facts wait two hours after news, facts use a separate one-hour clock',()=>{
 const state={startedAt:now-5*H};
 assert.equal(factEligibility(state,[{topic:'news',sourceUrl:'news',at:now-2*H+1}],now).eligible,false);
 const history=[{topic:'news',sourceUrl:'news',at:now-3*H},{topic:'fact',sourceUrl:'fact',at:now-H}];
 assert.equal(factEligibility(state,history,now).eligible,true);
 history[1].at=now-H+1;assert.equal(factEligibility(state,history,now).eligible,false);
});
test('eight facts cap uses Moscow midnight, spacing survives the reset',()=>{
 const before=Date.parse('2026-11-22T20:59:00Z'),after=before+120000;
 assert.equal(factDay(before),'2026-11-22');assert.equal(factDay(after),'2026-11-23');
 const state={startedAt:before-10*H,day:factDay(before),sent:8,lastPublishedAt:before-10*60000};
 assert.equal(factEligibility(state,[],before).reason,'DAILY_LIMIT');
 assert.equal(factEligibility(state,[],after).eligible,false);
 assert.equal(factEligibility(state,[],after+H).eligible,true);
});
test('first activation waits two hours and source failures have a daily attempt cap',()=>{
 assert.equal(factEligibility({},[],now).eligible,false);
 assert.equal(factEligibility({startedAt:now-2*H},[],now).eligible,true);
 assert.equal(factEligibility({startedAt:now-10*H,day:factDay(now),attempts:24},[],now).reason,'ATTEMPT_LIMIT');
});
test('archive facts do not relax news freshness or accept untrusted URLs',async()=>{
 assert.equal(validArticle(article,now),false);assert.equal(validFactArticle(article,now),true);
 assert.equal(validFactArticle({...article,url:'https://example.com/post'},now),false);
 assert.equal(validFactArticle({...article,publishedAt:now+H},now),false);
 await assert.rejects(()=>createNews(article,[],async()=>draft,async()=>({decision:'allow',confidence:1}),now),/NEWS_SOURCE_INVALID/);
 const xml=`<rss><channel><item><title>${article.title}</title><link>${article.url}</link><pubDate>${new Date(article.publishedAt).toUTCString()}</pubDate><description>${article.body}</description></item></channel></rss>`;
 assert.equal(parseFeed(xml,SOURCES[1],now).length,0);assert.equal(parseFeed(xml,SOURCES[1],now,true).length,1);
});
test('facts are sourced, independently checked and labelled; no stale-news category accepted',async()=>{
 const result=await run();assert.equal(result.topic,'fact');assert.match(result.text,/🎮 Игровой факт/);assert.match(result.text,/10\.03\.2020/);assert.ok(result.text.includes(article.url+'\n\n#'));
 await assert.rejects(()=>run(verdict,{...draft,category:'news'}),/NEWS_DRAFT_INVALID/);
 await assert.rejects(()=>run({...verdict,evergreen:false}),/NEWS_FACTCHECK_REJECTED/);
 await assert.rejects(()=>run({...verdict,checks:verdict.checks.slice(1)}),/NEWS_FACTCHECK_REJECTED/);
 await assert.rejects(()=>run({...verdict,checks:verdict.checks.map(c=>({...c,quote:'This is an invented statement not found in the source.'}))}),/NEWS_FACTCHECK_REJECTED/);
 assert.equal(await run({...verdict,duplicate:true}),null);
});
test('fact source discovery rotates sites, subjects and archive pages; published URLs excluded',()=>{
 assert.equal(new URL(factFeed(0).feed).hostname,'blog.playstation.com');assert.equal(new URL(factFeed(1).feed).hostname,'news.xbox.com');
 assert.notEqual(factFeed(0).feed,factFeed(2).feed);assert.equal(new URL(factFeed(12).feed).searchParams.get('paged'),'2');
 assert.equal(rankFactCandidates([article],[{sourceUrl:article.url}]).length,0);
});
