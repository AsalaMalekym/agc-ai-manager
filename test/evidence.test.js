import test from 'node:test';
import assert from 'node:assert/strict';
import {excerpts,evidenceQuote,negativeReason} from '../src/evidence.js';
import {parseArticle} from '../src/social.js';
import {primaryEvidence,EDITORIAL} from '../src/source-policy.js';
import {collectEvidence,unwrapSourceURL,verifyEditorialLead,classifyLead} from '../src/editorial.js';
import {createNews} from '../src/news.js';
const now=Date.now(),date=new Date(now).toISOString();
const body='The developer explained how the main character changed during production. The original idea was to let the player control a devil. Later the studio chose a witch instead, keeping the open world design. These statements describe the development process rather than a new release date. The interview does not promise a finished game or offer a review score.';
const base={sourceId:'igromania',url:'https://www.igromania.ru/article/12345/industry-exhibition/',sourceName:'Игромания',title:'Studios present games at an industry exhibition',body,publishedAt:now,references:[]};
const interview={...base,sourceId:'gamesradar',url:'https://www.gamesradar.com/games/rpg/developer-interview/',sourceName:'GamesRadar+',title:'Developer explains how the game changed',body:'GamesRadar+: How did the character change? Jane Smith: '+body+' GR+: When did you change it? JS: During production. GR+: What next? JS: We are listening to players.'};
test('industry features and original Q&A are accepted source types, generic media reports still require corroboration',()=>{
 assert.equal(primaryEvidence(base),false);assert.equal(primaryEvidence(interview),true);assert.equal(primaryEvidence({...interview,body}),false);
 const parsed=parseArticle(`<meta property="og:title" content="${base.title}"><meta property="article:published_time" content="${date}"><main><div class="material-content_12345">${body}</div><div>Unrelated promotional sidebar</div></main>`,base.url);assert.equal(parsed.body,body);
});
test('Games Press requires a press release page, not just its domain',()=>{
 const url='https://www.gamespress.com/Example-Game---First-Major-Update';const html=`<meta property="og:title" content="Game update announced"><span itemprop="datePublished" content="${date}"></span><article><section class="bodytext">${body}</section></article>`;
 assert.throws(()=>parseArticle(html,url),/NEWS_SOURCE_INVALID/);
 assert.equal(primaryEvidence(parseArticle('<span class="jq-newsType">Press release</span>'+html,url)),true);
});
test('named organization statement requires matching author metadata and author profile',()=>{
 const url='https://www.computerra.ru/12345/exhibition/',html=`<meta property="og:title" content="Industry exhibition statement"><meta property="article:published_time" content="${date}"><meta name="author" content="Агентство креативных индустрий"><article>${body}<a href="https://www.computerra.ru/author/aki/">Автор</a></article>`;
 assert.equal(primaryEvidence(parseArticle(html,url)),true);assert.equal(primaryEvidence(parseArticle(html.replace('/author/aki/','/author/someone/'),url)),false);
});
test('DTF wrappers reveal only allowlisted HTTPS source addresses without visiting the redirect endpoint',()=>{
 const target='https://www.gamespress.com/Example-Game---First-Major-Update';assert.equal(unwrapSourceURL('https://api.dtf.ru/v2.8/redirect?to='+encodeURIComponent(target)),target);
 assert.equal(unwrapSourceURL('https://api.dtf.ru/v2.8/redirect?to=https%3A%2F%2Fevil.example%2Fsecret'),null);
});
test('origins linked from indexed articles are followed even without a direct link in the social post',async()=>{
 const article={...base,title:'Game character developer interview',references:[interview.url]},calls=[];
 const result=await collectEvidence({text:article.title,links:[],classification:{searchTerms:['character']}},[],[article],async url=>{calls.push(url);return url===article.url?article:interview;});
 assert.ok(calls.includes(interview.url));assert.ok(result.some(a=>primaryEvidence(a)));
});
test('retrieved excerpt IDs and harmless typography differences work; invented IDs and facts do not',()=>{
 const a={...base,body:'The studio’s game — named “Aurora” — launches in December. '+body};
 const part=excerpts(a).find(e=>e.text.includes('studio’s'));assert.equal(evidenceQuote(a,{excerptId:part.id}),part.text);
 assert.equal(evidenceQuote(a,{excerptId:999}), '');assert.ok(evidenceQuote(a,{quote:'The studio\'s game - named "Aurora" - launches in December.'}));assert.equal(evidenceQuote(a,{quote:'The studio’s game launches in November.'}),'');
});
test('generic rejection or missing evidence never masquerades as a contradiction',()=>{
 assert.equal(negativeReason({decision:'reject'},[base]),'INSUFFICIENT_EVIDENCE');assert.equal(negativeReason({reason:'contradiction'},[base]),'INSUFFICIENT_EVIDENCE');
 assert.equal(negativeReason({reason:'contradiction',contradiction:{url:base.url,excerptId:1}},[base]),'SOURCE_CONTRADICTION');
});
test('an original interview verifies and produces an attributed news post without counting its copies',async()=>{
 const claim='The developer explained how the main character changed during production.';
 const selected=await verifyEditorialLead({text:claim,classification:{claims:[claim]}},[interview],async()=>({decision:'supported',sourceUrl:interview.url,checks:[{claim,quote:claim}]}));assert.equal(selected.article.url,interview.url);
 const rows=excerpts(interview),id=rows.find(r=>r.text.includes('The original idea')).id,other=rows.find(r=>r.text.includes('Later the studio')).id;
 const answers=[{category:'news',headline:{text:'Разработчик рассказал, как менялась главная героиня',excerptId:id},facts:[{text:'По словам разработчика, первоначально игрок должен был управлять дьяволом.',excerptId:id},{text:'Позже студия выбрала ведьму, сохранив открытый мир.',excerptId:other}]},{decision:'supported',duplicate:false,checks:[id,id,other].map((excerptId,index)=>({index,supported:true,excerptId}))}];
 const post=await createNews(interview,[],async()=>answers.shift(),async()=>({decision:'allow',confidence:.99}));assert.ok(post.text.startsWith('Из интервью GamesRadar+.'));assert.ok(post.text.includes(interview.url+'\n\n#'));
});

test('classification can select exact social fragment IDs without rewriting the claim',async()=>{
 const item={text:'Разработчик рассказал, как менялась его игра в процессе создания.'};
 const result=await classifyLead(item,async()=>({decision:'news',reason:'gaming_news',claimIds:[0]}));assert.deepEqual(result.claims,[item.text]);
 await assert.rejects(()=>classifyLead(item,async()=>({decision:'news',reason:'gaming_news',claimIds:[999]})),/NEWS_CLASSIFICATION_INVALID/);
});
