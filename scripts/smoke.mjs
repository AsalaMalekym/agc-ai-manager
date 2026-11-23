import assert from 'node:assert/strict';
const base = process.env.WORKER_URL || 'https://vkgropwithgpt.woen2017.workers.dev';
let last;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(15000) });
    assert.equal(r.status, 200); const health = await r.json(); assert.equal(health.service, 'AGC AI Manager 3.8.1');
    assert.equal(health.aiDailyLimit,2000);assert.equal(health.images?.enabled,true);
    assert.equal(health.stateConfigured, true, 'Durable Object/group ID not configured');
    const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /AG\|C/);
    const connector=await fetch(base+'/photo-connect');assert.equal(connector.status,200);assert.match(await connector.text(),/54914147/);
    const protectedRoute = await fetch(base + '/api/status'); assert.equal(protectedRoute.status, 401);
    const forged = await fetch(base + '/vk/callback', { method: 'POST', body: JSON.stringify({ type: 'confirmation', group_id: 0 }) });
    assert.equal(forged.status, 403);
    console.log(JSON.stringify({ smoke: 'passed', ...health }, null, 2)); process.exit(0);
  } catch (error) { last = error; if (attempt < 5) await new Promise(r => setTimeout(r, 5000)); }
}
console.error(last?.message || 'Smoke failed'); process.exit(1);
