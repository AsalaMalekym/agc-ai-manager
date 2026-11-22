import { VERSION, on, positiveId, json, text, readJSON, safeCode } from './src/services.js';
import { DASHBOARD } from './src/dashboard.js';
export { ManagerState } from './src/manager.js';
function manager(env) {
  if (!env.MANAGER || !positiveId(env.VK_GROUP_ID)) throw Error('MANAGER_NOT_CONFIGURED');
  return env.MANAGER.get(env.MANAGER.idFromName(`group:${env.VK_GROUP_ID}`));
}
async function internal(env, route, data) {
  return manager(env).fetch(`https://manager${route}`, { method: data ? 'POST' : 'GET',
    ...(data ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}) });
}
export function eventJob(event) {
  if (!event || !['message_new', 'wall_reply_new'].includes(event.type)) return null;
  const comment = event.type === 'wall_reply_new', entry = comment ? event.object : event.object?.message;
  if (!entry || !positiveId(entry.from_id) || entry.out || typeof entry.text !== 'string' || entry.text.length > 10000) return null;
  if (comment && (!positiveId(entry.id) || !positiveId(entry.post_id))) return null;
  if (!comment && (!positiveId(entry.peer_id) || Number(entry.peer_id) !== Number(entry.from_id) ||
    (!positiveId(entry.id) && !positiveId(entry.conversation_message_id)))) return null;
  const id = comment ? `comment:${event.group_id}:${entry.post_id}:${entry.id}`
    : `msg:${event.group_id}:${entry.peer_id}:${positiveId(entry.conversation_message_id) ? 'c' + entry.conversation_message_id : 'g' + entry.id}`;
  const clean = { id: entry.id, from_id: entry.from_id, text: entry.text, peer_id: entry.peer_id,
    post_id: entry.post_id, conversation_message_id: entry.conversation_message_id,
    ...(entry.attachments?.length ? { attachments: [{ type: 'uninspected' }] } : {}) };
  return { id, kind: 'event', event: { type: event.type, group_id: event.group_id, object: comment ? clean : { message: clean } } };
}
function authorized(request, env) {
  const key = env.AGC_ADMIN_KEY || env.AGC_TEST_KEY;
  const provided = request.headers.get('authorization')?.replace(/^Bearer /, '') || request.headers.get('X-AGC-Test-Key');
  return Boolean(key && key.length >= 24 && provided === key);
}
export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if ((path === '/' || path === '/admin') && request.method === 'GET') return new Response(DASHBOARD, { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      } });
      if (path === '/health' && request.method === 'GET') {
        let state = null;
        if (env.MANAGER && positiveId(env.VK_GROUP_ID)) {
          const response = await internal(env, '/status'); if (response.ok) state = await response.json();
        }
        const active = env.ENVIRONMENT === 'production' && !on(env.DRY_RUN) && env.KILL_SWITCH === 'off' && state?.paused === false;
        const replyReady = Boolean(env.DEEPSEEK_API_KEY && env.VK_TOKEN && state);
        const postReady = Boolean(env.DEEPSEEK_API_KEY && (env.VK_USER_TOKEN || env.VK_TOKEN) && state);
        return json({ ok: true, service: `AGC AI Manager ${VERSION}`, environment: env.ENVIRONMENT || 'unconfigured',
          repliesActive: Boolean(active && replyReady && on(env.AUTO_REPLY)), postingActive: Boolean(active && postReady && on(env.AUTO_POST)),
          moderationActive: Boolean(active && replyReady && on(env.MODERATION)), deepseekConfigured: Boolean(env.DEEPSEEK_API_KEY),
          stateConfigured: Boolean(state), vkConfigured: Boolean(env.VK_TOKEN), postingTokenConfigured: Boolean(env.VK_USER_TOKEN || env.VK_TOKEN), postingTokenType: env.VK_USER_TOKEN ? 'user' : env.VK_TOKEN ? 'community' : null,
          adminConfigured: Boolean((env.AGC_ADMIN_KEY || env.AGC_TEST_KEY || '').length >= 24), paused: state?.paused ?? true,
          imageGeneration: false, contentMode: 'gaming-news', pollIntervalSeconds: 60, news: state?.news || null,
          lastPublication: state?.recent?.filter(p => p.sourceUrl).slice(-1).map(p => ({ at: p.at, url: p.url, sourceUrl: p.sourceUrl }))[0] || null });
      }
      if (path.startsWith('/api/') || path === '/test-ai') {
        if (!authorized(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const routes = { '/api/status': ['GET', '/status'], '/api/pause': ['POST', '/pause'], '/api/resume': ['POST', '/resume'],
          '/api/scan': ['POST', '/scan'], '/api/preview': ['POST', '/preview'], '/api/analytics': ['POST', '/analytics'], '/test-ai': ['POST', '/test'] };
        const route = routes[path];
        if (!route) return json({ error: 'NOT_FOUND' }, 404);
        if (request.method !== route[0]) return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
        return await internal(env, route[1]);
      }
      if (path !== '/vk/callback') return text('Not found', 404);
      if (request.method !== 'POST') return text('Method not allowed', 405);
      const event = await readJSON(request);
      if (!event || typeof event !== 'object' || Array.isArray(event) || !positiveId(env.VK_GROUP_ID) || String(event.group_id) !== String(env.VK_GROUP_ID)) return text('Invalid group', 403);
      if (!env.VK_CALLBACK_SECRET || event.secret !== env.VK_CALLBACK_SECRET) return text('Forbidden', 403);
      if (event.type === 'confirmation') return env.VK_CONFIRMATION_CODE ? text(env.VK_CONFIRMATION_CODE) : text('Confirmation missing', 503);
      const job = eventJob(event);
      if (!job || env.KILL_SWITCH !== 'off' || env.ENVIRONMENT !== 'production' || on(env.DRY_RUN)) return text('ok');
      if (event.type === 'message_new' && !on(env.AUTO_REPLY)) return text('ok');
      if (event.type === 'wall_reply_new' && !on(env.MODERATION) && !(on(env.AUTO_REPLY) && on(env.COMMENT_REPLY))) return text('ok');
      const queued = await internal(env, '/enqueue', job);
      return queued.ok ? text('ok') : text('Queue unavailable', 503);
    } catch (error) {
      const code = safeCode(error);
      return json({ ok: false, error: code }, code === 'BODY_TOO_LARGE' ? 413 : code === 'BAD_JSON' ? 400 : 503);
    }
  },
  async scheduled(controller, env, ctx) {
    if (env.KILL_SWITCH !== 'off' || env.ENVIRONMENT !== 'production' || on(env.DRY_RUN)) return;
    const jobs = [];
    if (controller.cron === '* * * * *' && on(env.AUTO_POST) && (env.VK_USER_TOKEN || env.VK_TOKEN)) jobs.push({ id: `scan:${new Date(controller.scheduledTime).toISOString().slice(0, 16)}`, kind: 'scan' });
    if (controller.cron === '30 20 * * *') jobs.push({ id: `analytics:${new Date(controller.scheduledTime).toISOString().slice(0, 10)}`, kind: 'analytics' });
    ctx.waitUntil((async () => {
      for (const job of jobs) { const response = await internal(env, '/enqueue', job); if (!response.ok) throw Error('SCHEDULE_ENQUEUE_FAILED'); }
    })());
  }
};
