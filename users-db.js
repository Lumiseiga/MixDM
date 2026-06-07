/**
 * users-db.js
 * User account management backed by SQLite (via database.js).
 * Public API is identical to the old JSON-based version — server.js needs no changes.
 */

const crypto = require('crypto');
const fs = require('fs');
const { db, getConfig, setConfig } = require('./database');
const { appDataPath } = require('./app-paths');
const { getMachineLock } = require('./machine-id');

let SUBSCRIPTION_SIGNING_SECRET = process.env.MIXDM_SUBSCRIPTION_SIGNING_SECRET || getConfig('subscription_signing_secret');
if (!SUBSCRIPTION_SIGNING_SECRET) {
  SUBSCRIPTION_SIGNING_SECRET = crypto.randomBytes(64).toString('hex');
  setConfig('subscription_signing_secret', SUBSCRIPTION_SIGNING_SECRET);
  console.log('[Security] Generated and stored new subscription signing secret.');
}

// ─── Password Hashing ─────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verifies a password against a stored PBKDF2 hash (salt:hash).
 * Only accepts hashed passwords — plain-text passwords are never accepted.
 */
function verifyPassword(password, storedPassword) {
  if (!storedPassword || typeof storedPassword !== 'string') return false;
  // Reject anything that is not a valid salt:hash pair
  if (!storedPassword.includes(':')) return false;
  const [salt, hash] = storedPassword.split(':');
  if (!salt || !hash) return false;
  const verifyHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
  } catch (_) {
    return false;
  }
}

function generateSecurePassword(length = 24) {
  const minLength = Math.max(16, length);
  return crypto.randomBytes(Math.ceil(minLength * 0.75) + 8)
    .toString('base64url')
    .slice(0, minLength);
}

function saveGeneratedCredential({ role, email, password }) {
  const filePath = appDataPath('first-run-credentials.txt');
  const created = new Date().toISOString();
  const header = [
    '# MIXDM first-run credentials',
    '# Delete this file after you have signed in and rotated these passwords.',
    ''
  ].join('\n');
  const entry = [
    `[${created}] ${role}`,
    `Email: ${email}`,
    `Password: ${password}`,
    ''
  ].join('\n');
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header, { encoding: 'utf8', mode: 0o600 });
  }
  fs.appendFileSync(filePath, entry, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

function logGeneratedCredentialLocation(role, email, filePath) {
  console.log(`[SECURITY] Created ${role} account (${email}). One-time password saved to: ${filePath}`);
  console.log('[SECURITY] Delete that file after first login and password rotation.');
}

function normalizeSubscription(value) {
  const plan = String(value || 'free').toLowerCase();
  if (plan === 'life' || plan === 'lifetime') return 'lifetime';
  if (plan === 'pro_yearly' || plan === 'pro-yearly' || plan === 'yearly') return 'pro_yearly';
  if (plan === 'pro' || plan === 'premium' || plan === 'pro_monthly' || plan === 'pro-monthly' || plan === 'monthly') return 'pro_monthly';
  return 'free';
}

function isSubscriptionExpired(subscription, expiresAt) {
  const plan = normalizeSubscription(subscription);
  if (plan === 'free' || plan === 'lifetime') return false;
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= Date.now();
}

function isSubscriptionMachineMismatch(machineId) {
  if (!machineId) return false;
  return machineId !== getMachineLock();
}

function getEffectiveSubscription(subscription, expiresAt, machineId = null) {
  const plan = normalizeSubscription(subscription);
  if (isSubscriptionExpired(plan, expiresAt)) return 'free';
  if (plan !== 'free' && isSubscriptionMachineMismatch(machineId)) return 'free';
  return plan;
}

function subscriptionPayload(email, subscription, expiresAt = null, machineId = null) {
  return [
    String(email || '').toLowerCase().trim(),
    normalizeSubscription(subscription),
    expiresAt || '',
    machineId || ''
  ].join('|');
}

function signSubscription(email, subscription, expiresAt = null, machineId = null) {
  return crypto
    .createHmac('sha256', SUBSCRIPTION_SIGNING_SECRET)
    .update(subscriptionPayload(email, subscription, expiresAt, machineId))
    .digest('hex');
}

function verifySubscriptionSignature(row, rawSubscription) {
  const plan = normalizeSubscription(rawSubscription);
  if (plan === 'free') return true;
  const signature = row.subscription_signature || '';
  if (!signature) return false;
  const expected = signSubscription(row.email, plan, row.subscription_expires_at || null, row.subscription_machine_id || null);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

// ─── Helpers: row → user object ───────────────────────────────────────────────

function rowToUser(row) {
  if (!row) return null;
  const rawSubscription = normalizeSubscription(row.subscription);
  const signatureValid = verifySubscriptionSignature(row, rawSubscription);
  const tampered = rawSubscription !== 'free' && !signatureValid;
  const expired = isSubscriptionExpired(rawSubscription, row.subscription_expires_at);
  const machineMismatch = isSubscriptionMachineMismatch(row.subscription_machine_id);
  const effectiveSubscription = tampered
    ? 'free'
    : getEffectiveSubscription(rawSubscription, row.subscription_expires_at, row.subscription_machine_id);
  return {
    id:               row.id,
    email:            row.email,
    username:         row.username,
    displayName:      row.display_name,
    password:         row.password,
    role:             row.role || 'user',
    resetToken:       row.reset_token        || undefined,
    resetTokenExpires:row.reset_token_expires || undefined,
    avatarUrl:        row.avatar_url         || '',
    bio:              row.bio                || '',
    subscription:     effectiveSubscription,
    rawSubscription,
    subscriptionExpiresAt: row.subscription_expires_at || null,
    subscriptionMachineBound: !!row.subscription_machine_id,
    subscriptionMachineMismatch: machineMismatch,
    subscriptionExpired: expired,
    subscriptionSignatureValid: signatureValid,
    subscriptionTampered: tampered,
    createdAt:        row.created_at
  };
}

// ─── Ensure default accounts exist ───────────────────────────────────────────

function ensureDefaultAccounts() {
  const configuredAdminPassword = process.env.MIXDM_ADMIN_PASSWORD && process.env.MIXDM_ADMIN_PASSWORD.length >= 16
    ? process.env.MIXDM_ADMIN_PASSWORD
    : null;
  const adminExists = db.prepare("SELECT id FROM users WHERE email = 'admin@mixdm.app'").get();
  if (!adminExists) {
    const adminPassword = configuredAdminPassword || generateSecurePassword(24);
    db.prepare(`
      INSERT INTO users (email, username, display_name, password, role)
      VALUES ('admin@mixdm.app', 'admin', 'Administrator', ?, 'admin')
    `).run(hashPassword(adminPassword));
    if (configuredAdminPassword) {
      console.log('[SECURITY] Created admin account from MIXDM_ADMIN_PASSWORD.');
    } else {
      logGeneratedCredentialLocation(
        'admin',
        'admin@mixdm.app',
        saveGeneratedCredential({ role: 'admin', email: 'admin@mixdm.app', password: adminPassword })
      );
    }
  } else {
    const passwordClause = configuredAdminPassword ? 'password = ?, ' : '';
    const params = configuredAdminPassword ? [hashPassword(configuredAdminPassword)] : [];
    db.prepare(`
      UPDATE users
      SET ${passwordClause}username = 'admin', display_name = 'Administrator', role = 'admin'
      WHERE email = 'admin@mixdm.app'
    `).run(...params);
    if (configuredAdminPassword) {
      console.log('[SECURITY] Admin password synchronized from MIXDM_ADMIN_PASSWORD.');
    }
  }

  // Developer account
  const devExists = db.prepare("SELECT id FROM users WHERE role = 'developer'").get();
  const configuredDevPassword = process.env.MIXDM_DEV_PASSWORD && process.env.MIXDM_DEV_PASSWORD.length >= 16
    ? process.env.MIXDM_DEV_PASSWORD
    : null;
  const devEmail = 'developer@mixdm.app';
  if (!devExists) {
    const devPassword = configuredDevPassword || generateSecurePassword(24);
    db.prepare(`
      INSERT INTO users (email, username, display_name, password, role)
      VALUES ('developer@mixdm.app', 'developer', 'Developer', ?, 'developer')
    `).run(hashPassword(devPassword));
    if (configuredDevPassword) {
      console.log('[SECURITY] Created developer account from MIXDM_DEV_PASSWORD.');
    } else {
      logGeneratedCredentialLocation(
        'developer',
        devEmail,
        saveGeneratedCredential({ role: 'developer', email: devEmail, password: devPassword })
      );
    }
  } else if (configuredDevPassword) {
    db.prepare(`
      UPDATE users
      SET password = ?, username = 'developer', display_name = 'Developer', role = 'developer'
      WHERE role = 'developer'
    `).run(hashPassword(configuredDevPassword));
    console.log('[SECURITY] Developer password synchronized from MIXDM_DEV_PASSWORD.');
  }
}

// Run on module load
ensureDefaultAccounts();

// ─── Public API ───────────────────────────────────────────────────────────────

function loadUsers() {
  return db.prepare('SELECT * FROM users').all().map(rowToUser);
}

function findUserByEmailOrUsername(emailOrUsername) {
  const search = String(emailOrUsername).toLowerCase().trim();
  const row = db.prepare(`
    SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?
  `).get(search, search);
  return rowToUser(row);
}

function registerUser(email, password, displayName) {
  const lowerEmail = email.toLowerCase().trim();

  const exists = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(lowerEmail);
  if (exists) {
    throw new Error('อีเมลนี้ถูกลงทะเบียนไปแล้ว (Email is already registered)');
  }

  const result = db.prepare(`
    INSERT INTO users (email, username, display_name, password, role)
    VALUES (?, ?, ?, ?, 'user')
  `).run(
    lowerEmail,
    lowerEmail.split('@')[0],
    String(displayName).trim(),
    hashPassword(password)
  );

  const newRow = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  return rowToUser(newRow);
}

function saveResetToken(email, token, expiresAt) {
  const lowerEmail = email.toLowerCase().trim();
  const result = db.prepare(`
    UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE lower(email) = ?
  `).run(token, expiresAt, lowerEmail);
  if (result.changes === 0) throw new Error('ไม่พบอีเมลผู้ใช้งานนี้ (User not found)');
  return true;
}

function findUserByResetToken(token) {
  const row = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  return rowToUser(row);
}

function updateUserPassword(email, newPassword) {
  const lowerEmail = email.toLowerCase().trim();
  const result = db.prepare(`
    UPDATE users
    SET password = ?, reset_token = NULL, reset_token_expires = NULL
    WHERE lower(email) = ?
  `).run(hashPassword(newPassword), lowerEmail);
  if (result.changes === 0) throw new Error('ไม่พบอีเมลผู้ใช้งานนี้ (User not found)');
  return true;
}

function updateUserProfile(email, updates) {
  const lowerEmail = email.toLowerCase().trim();
  const user = findUserByEmailOrUsername(lowerEmail);
  if (!user) throw new Error('User not found');

  const fields = [];
  const params = [];

  if (updates.displayName !== undefined) {
    fields.push('display_name = ?');
    params.push(String(updates.displayName).trim());
  }
  if (updates.avatarUrl !== undefined) {
    fields.push('avatar_url = ?');
    params.push(String(updates.avatarUrl).trim());
  }
  if (updates.bio !== undefined) {
    fields.push('bio = ?');
    params.push(String(updates.bio).trim());
  }
  if (updates.password) {
    fields.push('password = ?');
    params.push(hashPassword(updates.password));
  }

  if (fields.length === 0) return true;

  params.push(lowerEmail);
  const sql = `UPDATE users SET ${fields.join(', ')} WHERE lower(email) = ?`;
  const result = db.prepare(sql).run(...params);
  if (result.changes === 0) throw new Error('Failed to update profile');
  return true;
}

function updateUserSubscription(email, subscription, expiresAt = null, machineId = null) {
  const lowerEmail = String(email).toLowerCase().trim();
  const plan = normalizeSubscription(subscription);
  const subscriptionMachineId = plan === 'free' ? null : (machineId || getMachineLock());
  const signature = signSubscription(lowerEmail, plan, expiresAt || null, subscriptionMachineId);
  const result = db.prepare(`
    UPDATE users
    SET subscription = ?, subscription_expires_at = ?, subscription_machine_id = ?, subscription_signature = ?
    WHERE lower(email) = ?
  `).run(plan, expiresAt || null, subscriptionMachineId, signature, lowerEmail);
  if (result.changes === 0) throw new Error('User not found');
  return findUserByEmailOrUsername(lowerEmail);
}

module.exports = {
  loadUsers,
  findUserByEmailOrUsername,
  registerUser,
  verifyPassword,
  saveResetToken,
  findUserByResetToken,
  updateUserPassword,
  updateUserProfile,
  updateUserSubscription,
  normalizeSubscription,
  getEffectiveSubscription,
  isSubscriptionExpired,
  isSubscriptionMachineMismatch,
  signSubscription,
  verifySubscriptionSignature
};
