const usersDb = require('../../users-db');
const { isLoopbackAddress, isTrustedExtensionRequest } = require('./cors.middleware');
const { getAuthCookie, invalidatedTokens, setAuthCookie, verifyToken } = require('../services/auth.service');

function authenticateToken(req, res, next) {
  // Extension bridge endpoints are intentionally tokenless, but only for the
  // locally installed connector origin configured in MIXDM_ALLOWED_EXTENSION_ORIGINS.
  if (req.path === '/api/extension/status' && isLoopbackAddress(req.ip)) {
    return next();
  }
  if (
    (req.path.startsWith('/api/extension/') ||
      req.path === '/api/analyze' ||
      req.path === '/api/focus-window') &&
    isTrustedExtensionRequest(req)
  ) {
    return next();
  }

  if (req.path === '/api/auth/login' || 
      req.path === '/api/auth/signup' || 
      req.path === '/api/auth/forgot-password' || 
      req.path === '/api/auth/reset-password') {
    return next();
  }
  // Exempt public status and config routes needed before login.
  if (req.path === '/api/config') {
    return next();
  }
  if (req.method === 'POST' && req.path.startsWith('/api/report/')) {
    return next();
  }
  // Allow non-api routing if any
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  let token = null;
  let tokenSource = '';
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
    tokenSource = 'header';
  } else {
    token = getAuthCookie(req);
    tokenSource = token ? 'cookie' : '';
  }

  if (!token) {
    return res.status(401).json({ error: 'ไม่พบรหัสเข้าสู่ระบบ (Unauthorized - No token provided)' });
  }

  if (invalidatedTokens.has(token)) {
    return res.status(401).json({ error: 'รหัสเข้าสู่ระบบนี้ถูกยกเลิกเนื่องจากออกจากระบบแล้ว (Unauthorized - Session invalidated by logout)' });
  }

  const email = verifyToken(token);
  if (!email) {
    return res.status(403).json({ error: 'รหัสเข้าสู่ระบบหมดอายุหรือผิดพลาด (Forbidden - Invalid or expired token)' });
  }

  const user = usersDb.findUserByEmailOrUsername(email);
  if (!user) {
    return res.status(403).json({ error: 'ไม่พบผู้ใช้งานนี้ในระบบ (Forbidden - User not found)' });
  }

  req.userEmail = email;
  req.userRole = user.role || 'user';
  if (tokenSource === 'header') {
    setAuthCookie(res, token);
  }
  next();
}

// Developer Authorization Middleware
function requireDeveloper(req, res, next) {
  if (req.userRole !== 'developer' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'สิทธิ์การใช้งานไม่เพียงพอสำหรับผู้พัฒนาเท่านั้น (Forbidden - Developer access required)' });
  }
  next();
}

module.exports = {
  authenticateToken,
  requireDeveloper
};
