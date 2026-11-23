export const HASHTAG_INSTRUCTIONS = `Дополнительно верни hashtagTerms: массив из 0–5 коротких слов или названий для хештегов, в порядке важности: игра, разработчик/издатель, вид события/факта, тема или платформа. Каждый элемент — точная фраза из написанного тобой текста поста (с пробелами, без #). Не выдумывай названия, сокращения, жанры и связь компании с игрой. Не добавляй компании только потому, что их сайт служит источником. Только относящиеся к теме ключевые слова, без общих призывов и спама. Рубрика будет добавлена автоматически. В сам текст символы хештегов не вставляй.`;

const CATEGORY_TAGS = { news:'ИгровыеНовости',release:'РелизыИгр',overview:'ОбзорИгры',selection:'ПодборкаИгр',fact:'ИгровыеФакты',esports:'Киберспорт',technology:'ИгровыеТехнологии',development:'РазработкаИгр',culture:'ИгроваяКультура',analysis:'ИгроваяАналитика',meme:'ИгровыеМемы',discussion:'ОбсуждениеИгр' };
const words = value => String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Ground suggested tags in the rendered post, never in hidden source metadata.
// Missing or malformed suggestions must not block an otherwise verified post.
export function postHashtags(text, category, suggestions) {
  const body = String(text).replace(/(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu, '$1$2');
  const corpus = ' '+words(body).join(' ')+' ';
  const tags = ['#'+(CATEGORY_TAGS[category] || 'Видеоигры')];
  const seen = new Set(tags.map(t=>t.toLowerCase()));
  for (const term of (Array.isArray(suggestions)?suggestions:[]).slice(0,20)) {
    if (typeof term!=='string' || term.length>100) continue;
    const phrase = term.normalize('NFKC').trim().replace(/^#/, '');
    if (!/^[\p{L}\p{N}][\p{L}\p{N}\s_:'’\-–—.]*$/u.test(phrase)) continue;
    const tokens=words(phrase);
    if (!tokens.length || tokens.length>6 || !corpus.includes(' '+tokens.join(' ')+' ')) continue;
    const tag='#'+phrase.replace(/[^\p{L}\p{N}_]/gu,'');
    if (tag.length<3 || tag.length>61 || !/\p{L}/u.test(tag) || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase()); tags.push(tag);
    if(tags.length===6)break;
  }
  return {body,hashtags:tags,line:tags.join(' ')};
}
