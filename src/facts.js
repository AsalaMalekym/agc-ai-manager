import { SOURCES, fetchFeed } from './news.js';
import { validFactArticle } from './source-policy.js';

export const FACT_LIMIT = 8;
export const NEWS_QUIET_MS = 2 * 3600000;
export const FACT_INTERVAL_MS = 3600000;
export const factDay = now => new Date(now + 3 * 3600000).toISOString().slice(0, 10);
const nextDay = now => Date.parse(factDay(now) + 'T00:00:00+03:00') + 86400000;

// Facts do not reset the news clock. The cap resets at midnight in Moscow,
// while the spacing and news quiet period continue across midnight.
export function factEligibility(state = {}, history = [], now = Date.now()) {
  const today = factDay(now);
  const sent = Math.max(state.day === today ? state.sent || 0 : 0,
    history.filter(p => p.topic === 'fact' && factDay(p.at) === today).length);
  const lastNewsAt = Math.max(state.lastNewsAt || 0, ...history.filter(p => p.sourceUrl && p.topic !== 'fact').map(p => p.at), 0);
  const lastFactAt = Math.max(state.lastPublishedAt || 0, ...history.filter(p => p.topic === 'fact').map(p => p.at), 0);
  const attempts = state.day === today ? state.attempts || 0 : 0;
  let nextEligibleAt = Math.max((lastNewsAt || state.startedAt || now) + NEWS_QUIET_MS,
    lastFactAt ? lastFactAt + FACT_INTERVAL_MS : 0);
  let reason = nextEligibleAt > now ? (lastNewsAt + NEWS_QUIET_MS > now ? 'NEWS_RECENT' : 'WAITING_INTERVAL') : 'READY';
  if (sent >= FACT_LIMIT || attempts >= 24) {
    nextEligibleAt = Math.max(nextEligibleAt, nextDay(now));
    reason = sent >= FACT_LIMIT ? 'DAILY_LIMIT' : 'ATTEMPT_LIMIT';
  }
  return { eligible: nextEligibleAt <= now, reason, day: today, sent, attempts, lastNewsAt, lastFactAt, nextEligibleAt };
}

const QUERIES = ['behind the scenes', 'making of', 'anniversary', 'developer interview', 'character design', 'sound design'];
export function factFeed(cursor = 0) {
  const source = SOURCES[cursor % SOURCES.length];
  const query = QUERIES[Math.floor(cursor / SOURCES.length) % QUERIES.length];
  const page = Math.floor(cursor / (SOURCES.length * QUERIES.length)) % 10 + 1;
  const url = new URL(source.feed);
  url.searchParams.set('s', query);
  if (page > 1) url.searchParams.set('paged', String(page));
  return { ...source, feed: url.href };
}

export async function fetchFactCandidates(cursor = 0) {
  const feed = await fetchFeed(factFeed(cursor), {}, true);
  return feed.articles.filter(a => validFactArticle(a));
}

export function rankFactCandidates(articles, recent = []) {
  const words = /behind.the.scenes|making.of|anniversary|interview|design|sound|music|history|origins|creating|created|inspiration/gi;
  const used = new Set(recent.flatMap(p => p.sourceUrls || [p.sourceUrl]));
  return articles.filter(a => validFactArticle(a) && !used.has(a.url))
    .map(a => ({ article: a, score: (a.title.match(words) || []).length }))
    .sort((a, b) => b.score - a.score).map(a => a.article);
}
