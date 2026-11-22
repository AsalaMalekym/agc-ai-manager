export function publicURL(value) {
  try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.port) return null; u.hash = ''; return u.href; } catch { return null; }
}
export const PRIMARY = Object.freeze([
  { id: 'playstation', name: 'PlayStation Blog', host: 'blog.playstation.com', path: /^\/20\d\d\/\d\d\/\d\d\/.+/ },
  { id: 'xbox', name: 'Xbox Wire', host: 'news.xbox.com', path: /^\/(?:[a-z]{2}-[a-z]{2}\/)?20\d\d\/\d\d\/\d\d\/.+/ },
  { id: 'nintendo-us', name: 'Nintendo', host: 'www.nintendo.com', path: /^\/us\/whatsnew\/.+/ },
  { id: 'blizzard', name: 'Blizzard', host: 'news.blizzard.com', path: /^\/[a-z]{2}-[a-z]{2}\/.+/ },
  { id: 'epic', name: 'Epic Games', host: 'store.epicgames.com', path: /^\/[a-z]{2}(?:-[A-Z]{2})?\/news\/.+/ },
  { id: 'rockstar', name: 'Rockstar Games', host: 'www.rockstargames.com', path: /^\/newswire\/article\/.+/ },
  { id: 'ea', name: 'Electronic Arts', host: 'www.ea.com', path: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:games\/[^/]+\/[^/]+\/)?news\/.+/ },
  { id: 'ubisoft', name: 'Ubisoft', host: 'news.ubisoft.com', path: /^\/[a-z]{2}-[a-z]{2}\/article\/.+/ }
]);
export function primarySource(value) {
  const clean = publicURL(value); if (!clean) return null;
  const u = new URL(clean), source = PRIMARY.find(s => s.host === u.hostname && s.path.test(u.pathname));
  if (!source) return null;
  u.search = ''; return { source, url: u.href };
}

// Different domains of one editorial group are not independent confirmations.
export const EDITORIAL = Object.freeze([
  { id:'stopgame',name:'StopGame',host:'stopgame.ru',publisher:'stopgame',path:/^\/newsdata\/\d+/,feed:'https://rss.stopgame.ru/rss_news.xml' },
  { id:'igromania',name:'Игромания',host:'www.igromania.ru',aliases:['igromania.ru'],publisher:'gamingmedia',path:/^\/news\// },
  { id:'kanobu',name:'Канобу',host:'kanobu.ru',publisher:'gamingmedia',path:/^\/news\// },
  { id:'ixbt',name:'iXBT Games',host:'ixbt.games',aliases:['www.ixbt.games'],publisher:'ixbt',path:/^\/news\//,feed:'https://ixbt.games/export/news/rss.xml' },
  { id:'gematsu',name:'Gematsu',host:'www.gematsu.com',aliases:['gematsu.com'],publisher:'gematsu',path:/^\/20\d\d\/\d\d\//,feed:'https://www.gematsu.com/feed' },
  { id:'vgc',name:'VGC',host:'www.videogameschronicle.com',publisher:'vgc',path:/^\/news\//,feed:'https://www.videogameschronicle.com/category/news/feed/' },
  { id:'pcgamer',name:'PC Gamer',host:'www.pcgamer.com',publisher:'future',path:/^\/(?!hardware\/|deals\/|coupons\/|best-|tag\/|about|rss)(?:[a-z0-9-]+\/)+$/,feed:'https://www.pcgamer.com/rss/' },
  { id:'eurogamer',name:'Eurogamer',host:'www.eurogamer.net',publisher:'ign',path:/^\/(?!topics\/|authors\/|archive|feed|about|contact)[a-z0-9-]+$/,feed:'https://www.eurogamer.net/feed/news' }
]);
export function editorialSource(value) {
  const clean=publicURL(value);if(!clean)return null;
  const u=new URL(clean),source=EDITORIAL.find(s=>(s.host===u.hostname||s.aliases?.includes(u.hostname))&&s.path.test(u.pathname));
  if(!source)return null;
  u.hostname=source.host;u.search='';return {source:{...source,kind:'editorial'},url:u.href};
}
export function evidenceSource(value) {
  const official=primarySource(value);
  return official ? {source:{...official.source,kind:'official',publisher:official.source.id},url:official.url} : editorialSource(value);
}
export function validArticle(article,now=Date.now()) {
  const match=evidenceSource(article?.url);
  return Boolean(match && match.url===article.url && match.source.id===article.sourceId && typeof article.title==='string' && typeof article.body==='string' && article.body.length>=300 && article.body.length<=24000 && Number.isFinite(article.publishedAt) && article.publishedAt<=now+60000 && now-article.publishedAt<=72*3600000);
}

function policyWords(s){return [...new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])];}
function citationURL(value){
  const source=evidenceSource(value);if(source)return source.url;
  const clean=publicURL(value);if(!clean)return null;
  const u=new URL(clean);for(const key of [...u.searchParams.keys()])if(/^utm_|^ref$|^fbclid$/.test(key))u.searchParams.delete(key);
  // Homepages, navigation and profile links do not establish a shared reporting origin.
  return u.pathname.split('/').filter(Boolean).length>=2||u.searchParams.has('v')?u.href:null;
}
export function pairPolicy(a,b) {
  const x=evidenceSource(a?.url),y=evidenceSource(b?.url);
  if(!x||!y||x.source.kind!=='editorial'||y.source.kind!=='editorial'||x.source.publisher===y.source.publisher)return {ok:false,reason:'SAME_PUBLISHER'};
  const ar=new Set((a.references||[]).map(citationURL).filter(Boolean)),br=new Set((b.references||[]).map(citationURL).filter(Boolean));
  if(ar.has(b.url)||br.has(a.url))return {ok:false,reason:'CIRCULAR_REPORTING'};
  const shared=[...ar].filter(u=>br.has(u));
  if(shared.some(u=>!primarySource(u)))return {ok:false,reason:'SHARED_UNVERIFIED_ORIGIN'};
  const grams=s=>{const w=policyWords(s);return new Set(w.slice(0,-3).map((_,i)=>w.slice(i,i+4).join(' ')));};
  const ag=grams(a.body),bg=grams(b.body),overlap=[...ag].filter(s=>bg.has(s)).length/Math.max(1,Math.min(ag.size,bg.size));
  if(overlap>.65)return {ok:false,reason:'COPIED_REPORT'};
  return {ok:true,sharedOfficial:shared.some(u=>primarySource(u))};
}
