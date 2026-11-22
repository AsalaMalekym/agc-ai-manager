import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, createFetchMock } from 'miniflare';

test('Worker and SQLite Durable Object boot under workerd; admin controls persist', async () => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let sends = 0;
  for (const content of [JSON.stringify({decision:'allow',category:'safe',confidence:0.99}), 'Привет, мемы на месте!', JSON.stringify({decision:'allow',category:'safe',confidence:0.99})]) {
    fetchMock.get('https://api.deepseek.com').intercept({path:'/chat/completions',method:'POST'}).reply(200, JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
  }
  fetchMock.get('https://api.vk.com').intercept({ path: '/method/messages.send', method: 'POST' }).reply(200, () => { sends++; return JSON.stringify({response:1}); }).persist();
  const mf = new Miniflare({ fetchMock, modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], scriptPath: new URL('../worker.js', import.meta.url).pathname,
    compatibilityDate: '2026-07-30', durableObjects: { MANAGER: { className: 'ManagerState', useSQLite: true } },
    bindings: { ENVIRONMENT: 'production', KILL_SWITCH: 'off', VK_GROUP_ID: '123', AGC_ADMIN_KEY: 'a'.repeat(32),
      VK_CALLBACK_SECRET: 'secret', VK_CONFIRMATION_CODE: 'confirm', AUTO_REPLY: 'on', AUTO_POST: 'on',
      VK_TOKEN: 'group', VK_USER_TOKEN: 'user', DEEPSEEK_API_KEY: 'mock' } });
  try {
    const response = await mf.dispatchFetch('https://test/health'); assert.equal(response.status, 200);
    const health = await response.json(); assert.equal(health.stateConfigured, true); assert.equal(health.postingActive, true);
    const headers = { Authorization: 'Bearer ' + 'a'.repeat(32) };
    const pause = await mf.dispatchFetch('https://test/api/pause', { method: 'POST', headers }); assert.equal(pause.status, 200);
    assert.equal((await (await mf.dispatchFetch('https://test/health')).json()).postingActive, false);
    const status = await (await mf.dispatchFetch('https://test/api/status', { headers })).json(); assert.equal(status.paused, true);
    assert.equal(status.audit.at(-1).type, 'paused');
    const confirmation = await mf.dispatchFetch('https://test/vk/callback', { method: 'POST', body: JSON.stringify({ type: 'confirmation', group_id: 123, secret: 'secret' }) });
    assert.equal(await confirmation.text(), 'confirm');
    const resume = await mf.dispatchFetch('https://test/api/resume', { method: 'POST', headers }); assert.equal(resume.status, 200);
    assert.equal((await (await mf.dispatchFetch('https://test/health')).json()).postingActive, true);
    const event = {type:'message_new',group_id:123,secret:'secret',object:{message:{id:1,from_id:42,peer_id:42,text:'Привет!'}}};
    const callbacks = await Promise.all(Array.from({length:10}, () => mf.dispatchFetch('https://test/vk/callback', {method:'POST',body:JSON.stringify(event)})));
    assert.ok(callbacks.every(r => r.status === 200));
    for (let i=0; i<40 && sends===0; i++) await new Promise(r=>setTimeout(r,100));
    const completed = await (await mf.dispatchFetch('https://test/api/status',{headers})).json();
    assert.equal(sends,1,JSON.stringify(completed));
    assert.equal(completed.usage.calls,3);

  } finally { await mf.dispose(); }
});
