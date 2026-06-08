const PORT = 3737; // Server port

function parseAllowedExtensionOrigins() {
  return String(process.env.MIXDM_ALLOWED_EXTENSION_ORIGINS || '')
    .split(',')
    .map(item => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function isExtensionOrigin(origin) {
  return /^chrome-extension:\/\//i.test(origin) || /^moz-extension:\/\//i.test(origin);
}

function isLocalAppOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  return normalized === `http://localhost:${PORT}` || normalized === `http://127.0.0.1:${PORT}`;
}

function isTrustedExtensionOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!isExtensionOrigin(normalized)) return false;
  const allowed = parseAllowedExtensionOrigins();
  return allowed.includes(normalized);
}

function isLoopbackAddress(ip) {
  if (!ip) return true;
  return ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('::ffff:127.') ||
    ip === 'localhost';
}

function isTrustedExtensionRequest(req) {
  return isLoopbackAddress(req.ip) && isTrustedExtensionOrigin(req.headers.origin || '');
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  return isLocalAppOrigin(origin) || isTrustedExtensionOrigin(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (isAllowedCorsOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
}

module.exports = {
  isAllowedCorsOrigin,
  isTrustedExtensionOrigin,
  isTrustedExtensionRequest,
  isLoopbackAddress,
  setCorsHeaders
};
