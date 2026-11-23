import test from 'node:test';
import assert from 'node:assert/strict';
import {postHashtags} from '../src/hashtags.js';
import {limitEmoji,paragraph,creativeParagraphs} from '../src/post-format.js';

test('hashtags retain grounded game/developer/topics, deduplicate and cap at six',()=>{
  const text='Baldur’s Gate 3 от Larian Studios: патч, баланс, кооператив, моды, персонажи.';
  const result=postHashtags(text,'news',['Baldur’s Gate 3','Larian Studios','larian studios','Rockstar','патч','баланс','кооператив','моды','персонажи']);
  assert.deepEqual(result.hashtags,['#ИгровыеНовости','#BaldursGate3','#LarianStudios','#патч','#баланс','#кооператив']);
  assert.equal(result.body,text);
});
test('invalid suggestions never block posting or introduce unrelated/source-only tags',()=>{
  for(const input of [undefined,null,{},42]) assert.deepEqual(postHashtags('Факт об игре','fact',input).hashtags,['#ИгровыеФакты']);
  const result=postHashtags('#Патч меняет игру на PlayStation 5.','news',['#Патч','PlayStation 5','Play','https://evil.test','@club123',12,'5','Xbox Wire','ИгровыеНовости']);
  assert.deepEqual(result.hashtags,['#ИгровыеНовости','#Патч','#PlayStation5']);
  assert.ok(!result.body.includes('#'));
});
test('paragraphs preserve meaningful order and select only neutral allowed markers',()=>{
  assert.equal(paragraph('Дата выхода — 24 ноября.','📅'),'📅 Дата выхода — 24 ноября.');
  assert.equal(paragraph('  Патч\nисправляет ошибки.  ','🔥'),'📌 Патч исправляет ошибки.');
  assert.equal(creativeParagraphs('Завязка\nПанчлайн','meme'),'🎮 Завязка\n\n📌 Панчлайн');
});
test('final emoji cap counts compound emoji once and preserves numeric keycap content',()=>{
  const text='👨‍👩‍👧‍👦 🇷🇺 👍🏽 ⚙️ 🎮 🛠 📅 🏆 💡 🔎 🎨 1️⃣';
  assert.equal(limitEmoji(text),'👨‍👩‍👧‍👦 🇷🇺 👍🏽 ⚙️ 🎮 🛠 📅 🏆 💡 🔎  1');
  assert.equal(paragraph('2️⃣ игрока 🎮','🎮'),'🎮 2 игрока');
});
