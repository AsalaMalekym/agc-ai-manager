export const FORMAT_INSTRUCTIONS = `Пост строй по смыслу: сначала главный вывод/инфоповод, затем связанные подробности, даты и условия, в конце значение для игроков, только если это подтверждено. Каждый факт — отдельный связный абзац, без повторения заголовка; не перемешивай причины, последствия и цитаты. Для творческого поста сохраняй порядок завязки и шутки либо подводки и вопроса. Текст пиши без эмодзи. Для каждого факта можно добавить поле emoji: один символ из 🎮 🛠 📅 🏆 ⚙️ 🔎 💡 📌 🎯 🌍 🎨 🎵 💬. Выбирай по смыслу, без оценочных реакций. Оформление абзацев добавит программа.`;
const ALLOWED = new Set(['🎮','🛠','📅','🏆','⚙️','🔎','💡','📌','🎯','🌍','🎨','🎵','💬']);
const segmenter = new Intl.Segmenter('ru', {granularity:'grapheme'});
const isEmoji = s => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(s);
export function limitEmoji(text, limit=10) {
  let count=0;
  return [...segmenter.segment(String(text))].map(({segment})=>!isEmoji(segment)||count++<limit?segment:segment.replace(/[^0-9#*]/gu,'')).join('');
}
export function paragraph(text, emoji='📌') {
  return (ALLOWED.has(emoji)?emoji:'📌')+' '+limitEmoji(text,0).replace(/\s+/gu,' ').trim();
}
export function creativeParagraphs(text,category) {
  return String(text).split(/\n+/).map((line,i)=>paragraph(line,i===0?(category==='meme'?'🎮':'💬'):'📌')).join('\n\n');
}
