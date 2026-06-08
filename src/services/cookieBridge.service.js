const { normalizeYtdlpUrl } = require('../../ytdlp-engine');

const COOKIE_BRIDGE_TTL_MS = 10 * 60 * 1000;
const cookieBridge = new Map();

function keyForUrl(url) {
  const normalized = normalizeYtdlpUrl(String(url || '').trim());
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' && parsed.pathname === '/watch' && parsed.searchParams.get('v')) {
      const clean = new URL('https://www.youtube.com/watch');
      clean.searchParams.set('v', parsed.searchParams.get('v'));
      return clean.href;
    }
  } catch (_) {}
  return normalized;
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of cookieBridge.entries()) {
    if (!entry || entry.expiresAt <= now) cookieBridge.delete(key);
  }
}

function storeCookiesForUrl(url, { cookies, cookiesHeader } = {}) {
  const key = keyForUrl(url);
  if (!key) return false;
  const hasCookies = Array.isArray(cookies) && cookies.length > 0;
  const hasHeader = typeof cookiesHeader === 'string' && cookiesHeader.trim();
  if (!hasCookies && !hasHeader) return false;

  pruneExpired();
  cookieBridge.set(key, {
    cookies: hasCookies ? cookies : undefined,
    cookiesHeader: hasHeader ? cookiesHeader : undefined,
    expiresAt: Date.now() + COOKIE_BRIDGE_TTL_MS
  });
  return true;
}

function getCookiesForUrl(url) {
  const key = keyForUrl(url);
  if (!key) return null;
  pruneExpired();
  const entry = cookieBridge.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cookieBridge.delete(key);
    return null;
  }
  return entry;
}

function getCookieStatusForUrl(url) {
  const entry = getCookiesForUrl(url);
  const count = entry?.cookies?.length || 0;
  return {
    available: !!entry && (count > 0 || !!entry.cookiesHeader),
    count,
    hasHeader: !!entry?.cookiesHeader,
    expiresAt: entry?.expiresAt || null,
  };
}

module.exports = {
  storeCookiesForUrl,
  getCookiesForUrl,
  getCookieStatusForUrl,
};
