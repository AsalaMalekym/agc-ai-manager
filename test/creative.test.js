import test from 'node:test';
import assert from 'node:assert/strict';
import {createCreative} from '../src/creative.js';
const meme={text:'Игрок: сохраню редкое зелье для действительно сложного босса.\nФинальные титры: зелье всё ещё ждёт своего звёздного часа.',concept:'Зелье сохранено до финальных титров'};
const verdict={safe:true,gaming:true,noFactualClaims:true,original:true,formatMatches:true};
const allow=async()=>({decision:'allow',confidence:1});
function run({category='meme',draft=meme,v=verdict,history=[],check=allow}={}){
 let i=0;return createCreative(category,history,async()=>structuredClone(i++?v:draft),check);
}
test('original text meme is fictional, moderated, and not presented as verified news',async()=>{
 const post=await run();assert.equal(post.topic,'meme');assert.equal(post.creative,true);assert.match(post.text,/вымышленная ситуация/);
 assert.equal(post.sourceUrl,undefined);assert.equal(post.verifiedAt,undefined);
 for(const key of Object.keys(verdict))await assert.rejects(()=>run({v:{...verdict,[key]:false}}),/CREATIVE_REJECTED/);
 await assert.rejects(()=>run({check:async()=>({decision:'review',confidence:1})}),/POST_REJECTED/);
});
test('discussion must be an open question, and identical concepts or texts are skipped',async()=>{
 const draft={text:'Представьте свободный вечер без спешки. Что выберете в игре: исследовать каждый уголок мира или двигаться по основному сюжету?',concept:'Исследование мира против основного сюжета'};
 assert.equal((await run({category:'discussion',draft})).topic,'discussion');
 await assert.rejects(()=>run({category:'discussion'}),/CREATIVE_DRAFT_INVALID/);
 assert.equal(await run({history:[{text:'Другие слова',concept:meme.concept}]}),null);
 const post=await run();assert.equal(await run({history:[post]}),null);
 await assert.rejects(()=>run({draft:{...meme,text:'https://example.com '+meme.text}}),/CREATIVE_DRAFT_INVALID/);
 assert.equal(await run({draft:{skip:true}}),null);
});
