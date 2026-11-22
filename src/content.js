import { evidenceSource, validFactArticle } from './source-policy.js';
export const CONTENT_INTERVAL_MS = 2 * 3600000;
export const MIXED_CATEGORIES = { fact:'🎮 Игровой факт', esports:'🏆 Киберспорт', technology:'⚙️ Игровые технологии', development:'🛠 История создания игр', culture:'🎮 Игровая культура' };
const THEMES = [
  {category:'esports',query:'esports',pattern:/esport|tournament|championship|competitive|киберспорт|турнир|чемпионат/i},
  {category:'technology',query:'technology',pattern:/technology|graphics|engine|accessibility|технолог|график|движок/i},
  {category:'fact',query:'secrets',pattern:/secret|fact|easter.egg|секрет|факт|пасхалк/i},
  {category:'development',query:'making of',pattern:/making.of|behind.the.scenes|design|development|создани|разработк/i},
  {category:'culture',query:'community',pattern:/community|speedrun|modding|cosplay|сообществ|спидран|моддинг/i}
];
export function contentEligibility(state={},history=[],now=Date.now()) {
  const lastPostAt=Math.max(state.lastContentAt||0,...history.filter(p=>p.sourceUrl).map(p=>p.at),0);
  const nextEligibleAt=(lastPostAt||state.startedAt||now)+CONTENT_INTERVAL_MS;
  return {eligible:now>=nextEligibleAt,lastPostAt,nextEligibleAt,reason:now>=nextEligibleAt?'READY':'WAITING_INTERVAL'};
}
export function contentTheme(cursor=0,history=[],allowFacts=true){
  const last=history.at(-1)?.topic;
  for(let i=0;i<THEMES.length;i++){
    const theme=THEMES[(Math.floor(cursor/2)+i)%THEMES.length];
    if(theme.category!==last&&(allowFacts||theme.category!=='fact'))return theme;
  }
  return THEMES[0];
}
const STOP=new Set('the and for with from this that game games new news will have has into your their about more after first play xbox playstation blog behind scenes making design announces announced update'.split(' '));
const words=s=>new Set((String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(w=>!STOP.has(w)));
// Coverage is only a ranking hint, not proof of popularity or factual evidence.
export function coverageScore(article,index,now=Date.now()){
  const query=words(article.title),publishers=new Set();
  for(const row of index){
    if(now-(row.publishedAt||row.discoveredAt)>72*3600000)continue;
    const match=evidenceSource(row.url);if(!match||row.url===article.url)continue;
    const overlap=[...words(row.title)].filter(w=>query.has(w));
    if(overlap.length>=2)publishers.add(match.source.publisher);
  }
  return publishers.size;
}
export function rankContent(articles,history,index,theme){
  const used=new Set(history.flatMap(p=>p.sourceUrls||[p.sourceUrl]));
  return [...new Map(articles.map(a=>[a.url,a])).values()].filter(a=>validFactArticle(a)&&!used.has(a.url))
    .map(article=>({article,score:(theme.pattern.test(article.title)?12:0)+Math.min(3,coverageScore(article,index))*3}))
    .sort((a,b)=>b.score-a.score).map(r=>r.article);
}
