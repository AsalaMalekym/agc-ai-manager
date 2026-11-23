import test from 'node:test';import assert from 'node:assert/strict';
import {digestItems,digestEligibility,createDigest} from '../src/digest.js';
const now=Date.parse('2026-11-24T18:45:00Z');
export const history=Array.from({length:7},(_,i)=>({postId:i+1,url:`https://vk.com/wall-123_${i+1}`,headline:`Разработчики игры ${i+1} рассказали о новом обновлении`,topic:'news',sourceUrl:`https://example.com/${i}`,verifiedAt:now-7200000,at:now-3600000-i*60000}));
test('digest copies at most five checked headlines and exact group post links',()=>{
 const draft=createDigest(history,'123',now);assert.equal(draft.digestPostUrls.length,5);assert.ok(draft.text.includes(history[0].headline));assert.ok(draft.text.includes(history[0].url));assert.equal(draft.topic,'digest');assert.equal(draft.digestDay,'2026-11-24');assert.ok(draft.headline.includes('5 новостей'));assert.equal((draft.text.match(/#/g)||[]).length,3);
});
test('digest excludes old, unverified, foreign, creative and duplicate-source posts',()=>{
 const bad=[{...history[0],verifiedAt:0},{...history[0],at:now-86400000},{...history[0],at:now+1},{...history[0],topic:'meme'},{...history[0],topic:'analysis'},{...history[0],url:'https://vk.com/wall-999_1'}];
 assert.equal(digestItems(bad,'123',now).length,0);
 const copy={...history[1],sourceUrls:[history[0].sourceUrl]};assert.equal(digestItems([history[0],copy],'123',now).length,1);
 assert.equal(createDigest(history.slice(0,2),'123',now),null);
});
test('Moscow evening window, quiet gap, day dedup and retry cap are explicit',()=>{
 assert.equal(digestEligibility({},history,'123',now).eligible,true);
 for(const [state,rows,time,reason] of [[{},history,Date.parse('2026-11-24T17:59Z'),'WAITING_EVENING'],[{},history,Date.parse('2026-11-24T21:01Z'),'WAITING_EVENING'],[{sentDay:'2026-11-24'},history,now,'ALREADY_SENT'],[{day:'2026-11-24',attempts:3},history,now,'ATTEMPT_LIMIT'],[{nextAttempt:now+1},history,now,'RETRY_LATER'],[{},[{...history[0],at:now},...history],now,'RECENT_POST'],[{},history.slice(0,2),now,'NOT_ENOUGH_NEWS']])assert.equal(digestEligibility(state,rows,'123',time).reason,reason);
 assert.equal(digestEligibility({day:'2026-11-23',attempts:3},history,'123',now).eligible,true);
});
