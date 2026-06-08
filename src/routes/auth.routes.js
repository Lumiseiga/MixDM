const express = require('express');
const crypto = require('crypto');
const usersDb = require('../../users-db');
const reportsDb = require('../../reports-db');
const { recordSecurityEvent } = require('../services/securityAudit.service');

const { clearAuthCookie, generateToken, getAuthCookie, invalidatedTokens, setAuthCookie } = require('../services/auth.service');
const { 
  checkLockout, 
  recordFailedAttempt, 
  clearFailedAttempts, 
  getClientRecord, 
  checkSignupRateLimit 
} = require('../middleware/rateLimit.middleware');
const { EMAIL_REGEX, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, RESERVED_USERNAMES } = require('../utils/hash');

const router = express.Router();

// Auth: login verification
router.post('/login', checkLockout, (req, res) => {
  const { username, password, rememberMe } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกข้อมูลให้ครบถ้วน (Please fill in all fields)' });
  }

  // Input length limits — prevent DoS via PBKDF2 CPU exhaustion
  if (String(username).length > 254 || String(password).length > 128) {
    return res.status(400).json({ success: false, error: 'ข้อมูลที่กรอกยาวเกินไป (Input too long)' });
  }
  const user = usersDb.findUserByEmailOrUsername(username);
  if (user && usersDb.verifyPassword(password, user.password)) {
    clearFailedAttempts(req.ip); // Clear count upon successful login
    const token = generateToken(user.email, !!rememberMe);
    setAuthCookie(res, token);
    res.json({ 
      success: true, 
      token,
      user: {
        email: user.email,
        displayName: user.displayName,
        role: user.role || 'user',
        avatarUrl: user.avatarUrl || '',
        bio: user.bio || '',
        subscription: user.subscription || 'free',
        subscriptionExpiresAt: user.subscriptionExpiresAt || null,
        subscriptionMachineBound: !!user.subscriptionMachineBound
      }
    });
  } else {
    recordFailedAttempt(req.ip); // Log failure
    // Anomaly detection: log security event after 3+ failures (no credentials stored)
    const record = getClientRecord(req.ip);
    if (record.failedAttempts.length === 3) {
      reportsDb.saveReport('security', {
        title: 'Login anomaly detected',
        description: `Multiple failed login attempts from the same IP`,
        detail: `Attempt count: ${record.failedAttempts.length}`,
        platform: req.headers['user-agent'] ? req.headers['user-agent'].substring(0, 80) : 'unknown'
      });
    }
    res.status(401).json({ success: false, error: 'อีเมล/ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง (Invalid credentials)' });
  }
});

// Auth: user registration (sign-up)
router.post('/signup', checkLockout, (req, res) => {
  // Sign-up rate limit: 3 attempts per IP per 10 minutes
  if (!checkSignupRateLimit(req.ip)) {
    return res.status(429).json({ success: false, error: 'สมัครบัญชีบ่อยเกินไป กรุณารอสักครู่ (Too many sign-up attempts. Please wait 10 minutes)' });
  }

  const { email, password, displayName } = req.body;
  if (!email || !password || !displayName) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกข้อมูลให้ครบถ้วน (Please fill in all fields)' });
  }

  // Input length limits
  if (String(email).length > 254 || String(password).length > MAX_PASSWORD_LENGTH || String(displayName).length > 64) {
    return res.status(400).json({ success: false, error: 'ข้อมูลที่กรอกยาวเกินไป (Input too long)' });
  }

  // Strict email format validation
  if (!EMAIL_REGEX.test(String(email).trim())) {
    return res.status(400).json({ success: false, error: 'รูปแบบอีเมลไม่ถูกต้อง (Invalid email format)' });
  }

  // Block reserved usernames derived from email local part
  const localPart = String(email).split('@')[0].toLowerCase().trim();
  if (RESERVED_USERNAMES.has(localPart)) {
    return res.status(400).json({ success: false, error: 'ชื่อผู้ใช้นี้ถูกสงวนไว้ (This username is reserved)' });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ success: false, error: `รหัสผ่านต้องมีความยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร (Password must be at least ${MIN_PASSWORD_LENGTH} characters)` });
  }

  try {
    const newUser = usersDb.registerUser(email, password, displayName);
    clearFailedAttempts(req.ip);
    const token = generateToken(newUser.email);
    setAuthCookie(res, token);
    res.json({ 
      success: true, 
      token, 
      user: {
        email: newUser.email,
        displayName: newUser.displayName,
        role: newUser.role || 'user',
        avatarUrl: newUser.avatarUrl || '',
        bio: newUser.bio || '',
        subscription: newUser.subscription || 'free',
        subscriptionExpiresAt: newUser.subscriptionExpiresAt || null,
        subscriptionMachineBound: !!newUser.subscriptionMachineBound
      } 
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Auth: request password reset link
router.post('/forgot-password', checkLockout, (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกอีเมล (Email is required)' });
  }

  const user = usersDb.findUserByEmailOrUsername(email);
  
  // Standardized response object to prevent email enumeration
  const responseData = {
    success: true,
    message: 'หากมีอีเมลนี้ในระบบ ลิงก์รีเซ็ตรหัสผ่านจะถูกส่งไปแล้ว (If the email exists, a reset link has been generated)'
  };

  if (user) {
    // Generate random token and set 15 minutes expiry
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000;

    usersDb.saveResetToken(user.email, resetToken, expiresAt);

    // Get active port from request or fallback
    const port = req.socket.localPort || 3737;
    const resetLink = `http://localhost:${port}/reset-password.html?token=${resetToken}`;
    
    // Only return the resetLink in non-production environments (for development/testing)
    if (process.env.NODE_ENV !== 'production') {
      responseData.resetLink = resetLink;
    }
  }

  res.json(responseData);
});

// Auth: reset password using token
router.post('/reset-password', checkLockout, (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกข้อมูลให้ครบถ้วน (Token and password required)' });
  }

  // Input length limits: max 128 chars to prevent PBKDF2 DoS
  if (String(newPassword).length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ success: false, error: 'รหัสผ่านยาวเกินไป (Password too long)' });
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ success: false, error: `รหัสผ่านต้องมีความยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร (Password must be at least ${MIN_PASSWORD_LENGTH} characters)` });
  }

  const user = usersDb.findUserByResetToken(token);
  if (!user) {
    recordFailedAttempt(req.ip);
    return res.status(400).json({ success: false, error: 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้อง (Invalid or used reset token)' });
  }

  if (user.resetTokenExpires < Date.now()) {
    recordFailedAttempt(req.ip);
    return res.status(400).json({ success: false, error: 'ลิงก์รีเซ็ตรหัสผ่านหมดอายุแล้ว (Reset token has expired)' });
  }

  usersDb.updateUserPassword(user.email, newPassword);
  clearFailedAttempts(req.ip);

  res.json({ success: true, message: 'เปลี่ยนรหัสผ่านใหม่เสร็จเรียบร้อยแล้ว (Password reset successful)' });
});

// Auth: logout and invalidate token
router.post('/logout', (req, res) => {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (getAuthCookie(req)) {
    token = getAuthCookie(req);
  } else if (req.body && req.body.token) {
    token = req.body.token;
  }

  if (token) {
    invalidatedTokens.add(token);
  }
  clearAuthCookie(res);

  res.json({ success: true, message: 'ออกจากระบบแล้ว (Logged out successfully)' });
});

// Auth: GET profile
router.get('/profile', (req, res) => {
  try {
    const user = usersDb.findUserByEmailOrUsername(req.userEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (user.subscriptionTampered) {
      recordSecurityEvent('subscription_tamper_detected', {
        severity: 'critical',
        actorEmail: user.email,
        ipAddress: req.ip,
        detail: 'Paid subscription failed local DB signature verification'
      });
    }
    res.json({
      success: true,
      user: {
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        subscription: user.subscription,
        subscriptionExpiresAt: user.subscriptionExpiresAt || null,
        subscriptionExpired: !!user.subscriptionExpired,
        subscriptionMachineBound: !!user.subscriptionMachineBound,
        subscriptionMachineMismatch: !!user.subscriptionMachineMismatch,
        subscriptionTampered: !!user.subscriptionTampered
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Auth: POST profile update
router.post('/profile', (req, res) => {
  const { displayName, avatarUrl, bio, password } = req.body;

  // Validation
  if (displayName && displayName.length > 64) {
    return res.status(400).json({ success: false, error: 'Display name cannot exceed 64 characters' });
  }
  if (bio && bio.length > 500) {
    return res.status(400).json({ success: false, error: 'Biography cannot exceed 500 characters' });
  }
  if (password && password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ success: false, error: 'Password too long' });
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  try {
    usersDb.updateUserProfile(req.userEmail, {
      displayName,
      avatarUrl,
      bio,
      password
    });

    const updatedUser = usersDb.findUserByEmailOrUsername(req.userEmail);
    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        email: updatedUser.email,
        displayName: updatedUser.displayName,
        role: updatedUser.role,
        avatarUrl: updatedUser.avatarUrl,
        bio: updatedUser.bio,
        subscription: updatedUser.subscription,
        subscriptionExpiresAt: updatedUser.subscriptionExpiresAt || null,
        subscriptionExpired: !!updatedUser.subscriptionExpired,
        subscriptionMachineBound: !!updatedUser.subscriptionMachineBound,
        subscriptionMachineMismatch: !!updatedUser.subscriptionMachineMismatch,
        subscriptionTampered: !!updatedUser.subscriptionTampered
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
