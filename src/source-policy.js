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
