import {factDay} from './facts.js';
import {limitEmoji} from './post-format.js';

const NEWS_TOPICS=new Set(['news','release','esports','technology']);
const normal=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function digestItems(history,groupId,now=Date.now()) {
  const day=factDay(now),urls=new Set(),headlines=new Set(),items=[];
  for(const post of [...history].sort((a,b)=>b.at-a.at)){
    if(!Number.isFinite(post.at)||!NEWS_TOPICS.has(post.topic)||!post.verifiedAt||!post.postId||!post.sourceUrl||post.at>now||factDay(post.at)!==day)continue;
    if(post.url!==`https://vk.com/wall-${groupId}_${post.postId}`||typeof post.headline!=='string'||post.headline.length<15||post.headline.length>160)continue;
    if(/https?:\/\//i.test(post.headline))continue;
    const key=normal(post.headline),sources=post.sourceUrls||[post.sourceUrl];
    if(headlines.has(key)||sources.some(u=>urls.has(u)))continue;
    headlines.add(key);sources.forEach(u=>urls.add(u));items.push({headline:post.headline,url:post.url,sourceUrl:post.sourceUrl,at:post.at});
    if(items.length===5)break;
  }
  return items;
}
export function digestEligibility(state,history,groupId,now=Date.now()) {
  const day=factDay(now),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'}).format(now));
  const count=digestItems(history,groupId,now).length;
  const lastPostAt=Math.max(0,...history.filter(p=>p.postId).map(p=>p.at||0));
  let reason='READY';
  if(state.sentDay===day||history.some(p=>p.topic==='digest'&&p.digestDay===day&&p.postId))reason='ALREADY_SENT';
  else if(hour<21||hour>=24)reason='WAITING_EVENING';
  else if(state.day===day&&state.attempts>=3)reason='ATTEMPT_LIMIT';
  else if(state.nextAttempt>now)reason='RETRY_LATER';
  else if(now-lastPostAt<30*60000)reason='RECENT_POST';
  else if(count<3)reason='NOT_ENOUGH_NEWS';
  return {eligible:reason==='READY',reason,day,count,lastPostAt};
}
export function createDigest(history,groupId,now=Date.now()) {
  const items=digestItems(history,groupId,now);if(items.length<3)return null;
  const date=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long'}).format(now);
  const headline=`Вечерний чекпоинт: ${items.length} новости за ${date}`.replace(': 5 новости',': 5 новостей');
  const text=limitEmoji(`🌙 ${headline}\n\nИз сегодняшних публикаций AG|C — откройте пост, чтобы прочитать подробности и источники.\n\n${items.map((p,i)=>`📌 ${i+1}. ${p.headline}\n${p.url}`).join('\n\n')}\n\n#ВечернийЧекпоинт #ИгровыеНовости #AGCNews`);
  return {text,headline,topic:'digest',digestDay:factDay(now),digestPostUrls:items.map(p=>p.url),hashtags:['#ВечернийЧекпоинт','#ИгровыеНовости','#AGCNews']};
}
