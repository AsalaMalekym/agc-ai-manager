// Evidence identifiers refer to text we actually downloaded; the model cannot invent quotations.
export const normalizeEvidence = value => String(value).normalize('NFC').replace(/[‘’ʼ]/g,"'").replace(/[“”«»]/g,'"').replace(/[‐‑–—]/g,'-').replace(/\s+/g,' ').trim();
export function excerpts(article) {
  const text=article.title+'\n'+article.body, chunks=[];
  for(const sentence of text.split(/(?<=[.!?])\s+|\n+/u)) {
    if(!sentence.trim())continue;
    for(let i=0;i<sentence.length;i+=550)chunks.push({id:chunks.length,text:sentence.slice(i,i+550)});
  }
  return chunks.slice(0,100);
}
export function evidenceQuote(article, evidence, field='quote', idField='excerptId') {
  if(Number.isInteger(evidence?.[idField]))return excerpts(article).find(v=>v.id===evidence[idField])?.text||'';
  const q=evidence?.[field];
  return typeof q==='string'&&normalizeEvidence(q).length>=20&&q.length<=600&&normalizeEvidence(article.title+' '+article.body).includes(normalizeEvidence(q))?q:'';
}
export function negativeReason(result,articles) {
  // A rejection is not an identified contradiction unless an actual contrary passage was supplied.
  const c=result?.contradiction,a=articles.find(a=>a.url===c?.url);
  return result?.reason==='contradiction'&&a&&evidenceQuote(a,c)?'SOURCE_CONTRADICTION':result?.reason==='unrelated'?'NO_MATCHING_EVENT':'INSUFFICIENT_EVIDENCE';
}
