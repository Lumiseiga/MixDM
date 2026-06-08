// In-memory rate limiting and lockout management
const loginAttempts = new Map();
const reportAttempts = new Map();
const globalRateLimiter = new Map();
const signupAttempts = new Map();
const licenseRedeemAttempts = new Map();

function getClientRecord(ip) {
  let record = loginAttempts.get(ip);
  if (!record) {
    record = { failedAttempts: [], lockoutUntil: 0 };
    loginAttempts.set(ip, record);
  }
  return record;
}

function checkLockout(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const record = getClientRecord(ip);

  if (record.lockoutUntil > now) {
    const remainingSeconds = Math.ceil((record.lockoutUntil - now) / 1000);
    const remainingMinutes = Math.ceil(remainingSeconds / 60);
    return res.status(429).json({
      success: false,
      error: `ระบบระงับการเข้าสู่ระบบชั่วคราวเนื่องจากรหัสผ่านผิดหลายครั้ง กรุณารออีก ${remainingSeconds} วินาที (${remainingMinutes} นาที) (Account locked. Please wait ${remainingSeconds} seconds)`
    });
  }
  next();
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = getClientRecord(ip);
  const limitWindow = 15 * 60 * 1000; // 15 minutes window

  // Clean old attempts outside the 15-minute window
  record.failedAttempts = record.failedAttempts.filter(timestamp => now - timestamp < limitWindow);
  record.failedAttempts.push(now);

  if (record.failedAttempts.length >= 5) {
    record.lockoutUntil = now + 15 * 60 * 1000; // Lock for 15 minutes
    record.failedAttempts = []; // Clear attempts count
  }
}

function clearFailedAttempts(ip) {
  const record = getClientRecord(ip);
  record.failedAttempts = [];
  record.lockoutUntil = 0;
}

function isLoopback(ip) {
  if (!ip) return true;
  return ip === '127.0.0.1' || 
         ip === '::1' || 
         ip.startsWith('127.') || 
         ip.startsWith('::ffff:127.') || 
         ip === 'localhost';
}

function checkReportRateLimit(ip) {
  if (isLoopback(ip)) return true;
  const now = Date.now();
  const window = 10 * 60 * 1000; // 10 minutes
  const list = (reportAttempts.get(ip) || []).filter(t => now - t < window);
  if (list.length >= 5) return false;
  list.push(now);
  reportAttempts.set(ip, list);
  return true;
}

function checkGlobalRateLimit(ip) {
  if (isLoopback(ip)) return true;
  const now = Date.now();
  const window = 60 * 1000; // 1 minute
  const list = (globalRateLimiter.get(ip) || []).filter(t => now - t < window);
  if (list.length >= 100) return false;
  list.push(now);
  globalRateLimiter.set(ip, list);
  return true;
}

// Purge stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [ip, times] of globalRateLimiter) {
    const fresh = times.filter(t => t > cutoff);
    if (fresh.length === 0) globalRateLimiter.delete(ip);
    else globalRateLimiter.set(ip, fresh);
  }
}, 5 * 60 * 1000);

function checkSignupRateLimit(ip) {
  if (isLoopback(ip)) return true;
  const now = Date.now();
  const window = 10 * 60 * 1000;
  const list = (signupAttempts.get(ip) || []).filter(t => now - t < window);
  if (list.length >= 3) return false;
  list.push(now);
  signupAttempts.set(ip, list);
  return true;
}

function redeemKey(req) {
  return `${req.userEmail || 'anonymous'}:${req.ip || 'unknown'}`;
}

function getLicenseRedeemRecord(req) {
  const key = redeemKey(req);
  let record = licenseRedeemAttempts.get(key);
  if (!record) {
    record = { failedAttempts: [], lockoutUntil: 0 };
    licenseRedeemAttempts.set(key, record);
  }
  return record;
}

function checkLicenseRedeemLockout(req, res, next) {
  const now = Date.now();
  const record = getLicenseRedeemRecord(req);
  if (record.lockoutUntil > now) {
    const remainingSeconds = Math.ceil((record.lockoutUntil - now) / 1000);
    return res.status(429).json({
      success: false,
      error: `Too many invalid license attempts. Please wait ${remainingSeconds} seconds.`
    });
  }
  next();
}

function recordLicenseRedeemFailure(req) {
  const now = Date.now();
  const record = getLicenseRedeemRecord(req);
  const window = 15 * 60 * 1000;
  record.failedAttempts = record.failedAttempts.filter(timestamp => now - timestamp < window);
  record.failedAttempts.push(now);
  if (record.failedAttempts.length >= 5) {
    record.lockoutUntil = now + 30 * 60 * 1000;
    record.failedAttempts = [];
    try {
      const { recordSecurityEvent } = require('../services/securityAudit.service');
      recordSecurityEvent('license_redeem_lockout', {
        severity: 'critical',
        actorEmail: req.userEmail || '',
        ipAddress: req.ip || '',
        detail: 'Too many invalid license key attempts'
      });
    } catch (_) {}
  }
}

function clearLicenseRedeemFailures(req) {
  const record = getLicenseRedeemRecord(req);
  record.failedAttempts = [];
  record.lockoutUntil = 0;
}

module.exports = {
  checkLockout,
  recordFailedAttempt,
  clearFailedAttempts,
  getClientRecord,
  checkReportRateLimit,
  checkGlobalRateLimit,
  checkSignupRateLimit,
  checkLicenseRedeemLockout,
  recordLicenseRedeemFailure,
  clearLicenseRedeemFailures
};
