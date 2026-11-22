import test from 'node:test';
import assert from 'node:assert/strict';
import {contentEligibility,contentTheme,coverageScore,rankContent,MIXED_CATEGORIES} from '../src/content.js';
import {createNews} from '../src/news.js';
const H=3600000,now=Date.parse('2026-11-23T00:00:00Z');
const q1='The Halo tournament used a double elimination format during the 2020 competition.';
const q2='Teams that lost a match moved into the lower bracket for another chance to compete.';
const article={sourceId:'xbox',sourceName:'Xbox Wire',url:'https://news.xbox.com/en-us/2020/03/10/halo-tournament/',title:'Halo tournament championship format',publishedAt:Date.parse('2020-03-10'),body:q1+' '+q2+' This official retrospective describes the tournament format used in that particular competition. It does not announce a new event or claim that future tournaments will use the same rules. The organizers explained the structure so spectators could follow the competition.'};
const draft={skip:false,category:'esports',headline:{text:'Как была устроена сетка турнира Halo в 2020 году',quote:q1},facts:[{text:'В соревновании 2020 года использовалась сетка с выбыванием после двух поражений.',quote:q1},{text:'Проигравшая матч команда переходила в нижнюю сетку и могла продолжить борьбу.',quote:q2}]};
const verdict={decision:'supported',duplicate:false,categorySupported:true,historicalContext:true,checks:[q1,q1,q2].map((quote,index)=>({index,supported:true,quote}))};
const run=(v=verdict,d=draft,mode='mixed:esports')=>{let n=0;return createNews(article,[],async()=>structuredClone(n++===0?d:v),async()=>({decision:'allow',confidence:1}),now,[],null,mode);};
test('two-hour mixed cadence resets after every rubric and survives midnight or restart',()=>{
 for(const topic of ['news',...Object.keys(MIXED_CATEGORIES)]){
  const h=[{topic,sourceUrl:'source',at:now-H}];assert.equal(contentEligibility({},h,now).eligible,false);
  assert.equal(contentEligibility({},h,now+H).eligible,true);
 }
 assert.equal(contentEligibility({lastContentAt:now-H},[],now).eligible,false);
 assert.equal(contentEligibility({},[],now).eligible,false);
 assert.equal(contentEligibility({startedAt:now-48*H},[],now).eligible,true);
});
test('themes rotate, avoid last rubric and keep other rubrics when fact quota is exhausted',()=>{
 const seen=new Set(Array.from({length:10},(_,i)=>contentTheme(i).category));assert.equal(seen.size,5);
 for(let i=0;i<10;i++){assert.notEqual(contentTheme(i,[],false).category,'fact');const t=contentTheme(i).category;assert.notEqual(contentTheme(i,[{topic:t}]).category,t);}
});
test('coverage counts independent publishers once; stale stories and unrelated words do not boost ranking',()=>{
 const index=[
  {url:'https://www.pcgamer.com/halo-tournament/',title:'Halo tournament format',publishedAt:now},
  {url:'https://www.gamesradar.com/games/fps/halo-tournament/',title:'Halo tournament rules',publishedAt:now},
  {url:'https://www.gematsu.com/2026/11/halo-tournament',title:'Halo tournament format',publishedAt:now},
  {url:'https://stopgame.ru/newsdata/12345/foo',title:'Halo tournament',publishedAt:now-96*H},
  {url:'https://www.igromania.ru/news/12345/foo/',title:'New game for PlayStation',publishedAt:now}
 ];assert.equal(coverageScore(article,index,now),2);
 assert.equal(rankContent([article],[{sourceUrl:article.url}],index,contentTheme()).length,0);
});
test('esports posts retain archive context, exact claims and requested rubric',async()=>{
 const result=await run();assert.equal(result.topic,'esports');assert.match(result.text,/🏆 Киберспорт/);assert.match(result.text,/2020/);
 await assert.rejects(()=>run({...verdict,historicalContext:false}),/NEWS_FACTCHECK_REJECTED/);
 await assert.rejects(()=>run({...verdict,categorySupported:false}),/NEWS_FACTCHECK_REJECTED/);
 await assert.rejects(()=>run(verdict,{...draft,category:'fact'}),/NEWS_DRAFT_INVALID/);
 await assert.rejects(()=>run({...verdict,checks:[]}),/NEWS_FACTCHECK_REJECTED/);
 await assert.rejects(()=>run(verdict,draft,'mixed:invented'),/NEWS_DRAFT_INVALID/);
});
