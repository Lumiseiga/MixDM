const crypto = require('crypto');
const { getConfig, setConfig } = require('../../database');

const AUTH_COOKIE_NAME = 'mixdm_session';

let TOKEN_SECRET = process.env.MIXDM_TOKEN_SECRET || getConfig('token_secret');
if (!TOKEN_SECRET) {
  TOKEN_SECRET = crypto.randomBytes(64).toString('hex');
  setConfig('token_secret', TOKEN_SECRET);
  console.log('[Security] Generated and stored new TOKEN_SECRET in database.');
}

function generateToken(email, rememberMe = false) {
  const duration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000; // 30 days vs 2 hours
  const expiresAt = Date.now() + duration;
  const payload = `${email}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

function getTokenExpiresAt(token) {
  if (!token) return null;
  const parts = String(token).split(':');
  if (parts.length !== 3) return null;
  const expiresAt = parseInt(parts[1], 10);
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

function signaturesMatch(signature, expectedSignature) {
  if (!/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch (_) {
    return false;
  }
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [email, expiresAtStr, signature] = parts;
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || expiresAt < Date.now()) return null; // Expired

  // Verify HMAC signature
  const payload = `${email}:${expiresAt}`;
  const expectedSignature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  if (!signaturesMatch(signature, expectedSignature)) return null;

  return email;
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookie]);
  }
}

function setAuthCookie(res, token) {
  const expiresAt = getTokenExpiresAt(token);
  const maxAge = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
  appendCookie(
    res,
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
  );
}

function clearAuthCookie(res) {
  appendCookie(res, `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function getAuthCookie(req) {
  const raw = req.headers.cookie || '';
  const cookies = raw.split(';');
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name === AUTH_COOKIE_NAME) {
      return decodeURIComponent(valueParts.join('=') || '');
    }
  }
  return null;
}

// Blacklisted tokens Set to revoke sessions on logout
const invalidatedTokens = new Set();

// Periodically purge expired tokens from the blacklist to prevent memory leaks (runs every 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const token of invalidatedTokens) {
    const parts = token.split(':');
    if (parts.length === 3) {
      const expiresAt = parseInt(parts[1], 10);
      if (isNaN(expiresAt) || expiresAt < now) {
        invalidatedTokens.delete(token);
      }
    } else {
      invalidatedTokens.delete(token);
    }
  }
}, 30 * 60 * 1000);

module.exports = {
  AUTH_COOKIE_NAME,
  TOKEN_SECRET,
  generateToken,
  getTokenExpiresAt,
  verifyToken,
  setAuthCookie,
  clearAuthCookie,
  getAuthCookie,
  invalidatedTokens
};
