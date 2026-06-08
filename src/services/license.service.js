const crypto = require('crypto');
const { db, getConfig, setConfig } = require('../../database');
const usersDb = require('../../users-db');
const { getMachineLock } = require('../../machine-id');

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_BODY_LENGTH = 20;

const PLAN_CONFIGS = {
  pro_monthly: {
    plan: 'pro_monthly',
    prefix: 'PM',
    durationDays: 30,
    priceLabel: '39 THB',
    label: 'Pro Monthly'
  },
  pro_yearly: {
    plan: 'pro_yearly',
    prefix: 'PY',
    durationDays: 365,
    priceLabel: '299 THB',
    label: 'Pro Yearly'
  },
  lifetime: {
    plan: 'lifetime',
    prefix: 'LT',
    durationDays: null,
    priceLabel: '599 THB',
    label: 'Lifetime'
  }
};

const PREFIX_TO_PLAN = Object.fromEntries(
  Object.values(PLAN_CONFIGS).map(config => [config.prefix, config.plan])
);

let LICENSE_SIGNING_SECRET = process.env.MIXDM_LICENSE_SIGNING_SECRET || getConfig('license_signing_secret');
if (!LICENSE_SIGNING_SECRET) {
  LICENSE_SIGNING_SECRET = crypto.randomBytes(64).toString('hex');
  setConfig('license_signing_secret', LICENSE_SIGNING_SECRET);
  console.log('[Security] Generated and stored new license signing secret.');
}

function normalizePlan(value) {
  return usersDb.normalizeSubscription(value);
}

function canonicalizeKey(rawKey) {
  return String(rawKey || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function parseCanonicalKey(canonicalKey) {
  const match = String(canonicalKey || '').match(/^MIXDM(PM|PY|LT)([A-Z0-9]{20})$/);
  if (!match) return null;
  const plan = PREFIX_TO_PLAN[match[1]];
  if (!plan) return null;
  return { prefix: match[1], plan, body: match[2] };
}

function hashKey(canonicalKey) {
  return crypto.createHash('sha256').update(canonicalKey).digest('hex');
}

function randomKeyBody() {
  let body = '';
  for (let i = 0; i < KEY_BODY_LENGTH; i += 1) {
    body += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  }
  return body;
}

function formatLicenseKey(canonicalKey) {
  const parsed = parseCanonicalKey(canonicalKey);
  if (!parsed) return canonicalKey;
  const groups = parsed.body.match(/.{1,5}/g) || [];
  return ['MIXDM', parsed.prefix, ...groups].join('-');
}

function redactHash(keyHash) {
  const hash = String(keyHash || '');
  if (hash.length < 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function calculateExpiry(durationDays, now = new Date()) {
  const days = Number(durationDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function licensePayload(row) {
  return [
    row.key_hash || '',
    normalizePlan(row.plan),
    row.duration_days === null || row.duration_days === undefined ? '' : String(row.duration_days),
    row.price_label || '',
    row.status || '',
    row.created_by || '',
    row.created_at || '',
    row.redeemed_by || '',
    row.redeemed_at || '',
    row.expires_at || '',
    row.machine_id || ''
  ].join('|');
}

function signLicenseRow(row) {
  return crypto
    .createHmac('sha256', LICENSE_SIGNING_SECRET)
    .update(licensePayload(row))
    .digest('hex');
}

function verifyLicenseRow(row) {
  if (!row) return false;
  const signature = row.license_signature || '';
  if (!signature) return false;
  const expected = signLicenseRow(row);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

function updateLicenseSignature(id) {
  const row = db.prepare('SELECT * FROM license_keys WHERE id = ?').get(id);
  if (!row) throw new Error('License key not found');
  const signature = signLicenseRow(row);
  db.prepare('UPDATE license_keys SET license_signature = ? WHERE id = ?').run(signature, id);
  return { ...row, license_signature: signature };
}

function ensureLicenseSignatures() {
  const rows = db.prepare('SELECT * FROM license_keys WHERE license_signature IS NULL OR license_signature = ?').all('');
  for (const row of rows) {
    db.prepare('UPDATE license_keys SET license_signature = ? WHERE id = ?').run(signLicenseRow(row), row.id);
  }
}

function publicLicenseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyHash: redactHash(row.key_hash),
    plan: row.plan,
    durationDays: row.duration_days,
    priceLabel: row.price_label,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    redeemedBy: row.redeemed_by,
    redeemedAt: row.redeemed_at,
    expiresAt: row.expires_at,
    revokedReason: row.revoked_reason || '',
    revokedAt: row.revoked_at || null,
    revokedBy: row.revoked_by || '',
    suspicious: !!row.suspicious,
    machineBound: !!row.machine_id,
    signatureValid: verifyLicenseRow(row)
  };
}

function generateLicenseKeys({ plan, quantity = 1, createdBy = '' } = {}) {
  const normalizedPlan = normalizePlan(plan);
  const config = PLAN_CONFIGS[normalizedPlan];
  if (!config || normalizedPlan === 'free') {
    throw new Error('Invalid license plan');
  }

  const count = Math.max(1, Math.min(Math.round(Number(quantity) || 1), 100));
  const created = [];
  const insert = db.prepare(`
    INSERT INTO license_keys (key_hash, plan, duration_days, price_label, status, created_by)
    VALUES (?, ?, ?, ?, 'active', ?)
  `);

  for (let i = 0; i < count; i += 1) {
    let attempts = 0;
    while (attempts < 20) {
      attempts += 1;
      const canonicalKey = `MIXDM${config.prefix}${randomKeyBody()}`;
      const keyHash = hashKey(canonicalKey);
      try {
        const result = insert.run(keyHash, config.plan, config.durationDays, config.priceLabel, createdBy || null);
        updateLicenseSignature(result.lastInsertRowid);
        created.push({
          id: result.lastInsertRowid,
          key: formatLicenseKey(canonicalKey),
          plan: config.plan,
          durationDays: config.durationDays,
          priceLabel: config.priceLabel
        });
        break;
      } catch (err) {
        if (!String(err.message || '').includes('UNIQUE')) throw err;
      }
    }
    if (created.length <= i) throw new Error('Failed to generate a unique license key');
  }

  return created;
}

function redeemLicenseKey(rawKey, userEmail) {
  const canonicalKey = canonicalizeKey(rawKey);
  const parsed = parseCanonicalKey(canonicalKey);
  if (!parsed) {
    throw new Error('Invalid key format');
  }

  const keyHash = hashKey(canonicalKey);
  const now = new Date();
  const nowIso = now.toISOString();
  const machineId = getMachineLock();

  const redeem = db.transaction(() => {
    const row = db.prepare('SELECT * FROM license_keys WHERE key_hash = ?').get(keyHash);
    if (!row) throw new Error('License key not found');
    if (!verifyLicenseRow(row)) throw new Error('License key record failed integrity verification');
    if (row.status === 'redeemed') throw new Error('This license key has already been used');
    if (row.status !== 'active') throw new Error('This license key is not active');

    const plan = normalizePlan(row.plan);
    const config = PLAN_CONFIGS[plan];
    if (!config) throw new Error('This license key has an unsupported plan');

    const expiresAt = calculateExpiry(row.duration_days, now);
    db.prepare(`
      UPDATE license_keys
      SET status = 'redeemed', redeemed_by = ?, redeemed_at = ?, expires_at = ?, machine_id = ?
      WHERE id = ?
    `).run(userEmail, nowIso, expiresAt, machineId, row.id);
    const signedRow = updateLicenseSignature(row.id);

    usersDb.updateUserSubscription(userEmail, plan, expiresAt, machineId);

    return {
      license: publicLicenseRow({
        ...signedRow,
        status: 'redeemed',
        redeemed_by: userEmail,
        redeemed_at: nowIso,
        expires_at: expiresAt,
        machine_id: machineId,
        license_signature: signedRow.license_signature
      }),
      plan,
      label: config.label,
      expiresAt
    };
  });

  const result = redeem();
  return {
    ...result,
    user: usersDb.findUserByEmailOrUsername(userEmail)
  };
}

function shouldDowngradeRedeemedUser(row) {
  if (!row?.redeemed_by) return false;
  const user = usersDb.findUserByEmailOrUsername(row.redeemed_by);
  if (!user) return false;
  const samePlan = usersDb.normalizeSubscription(user.rawSubscription) === usersDb.normalizeSubscription(row.plan);
  const sameExpiry = (user.subscriptionExpiresAt || null) === (row.expires_at || null);
  return samePlan && sameExpiry;
}

function revokeLicenseKey(id, { actorEmail = '', reason = '', suspicious = false } = {}) {
  const licenseId = Math.round(Number(id) || 0);
  if (licenseId <= 0) throw new Error('Invalid license id');

  const cleanReason = String(reason || '').trim().slice(0, 500);
  const nowIso = new Date().toISOString();

  const revoke = db.transaction(() => {
    const row = db.prepare('SELECT * FROM license_keys WHERE id = ?').get(licenseId);
    if (!row) throw new Error('License key not found');
    if (!verifyLicenseRow(row)) throw new Error('License key record failed integrity verification');
    if (row.status === 'revoked') throw new Error('This license key is already revoked');

    const userDowngraded = shouldDowngradeRedeemedUser(row);
    db.prepare(`
      UPDATE license_keys
      SET status = 'revoked',
          revoked_reason = ?,
          revoked_at = ?,
          revoked_by = ?,
          suspicious = ?
      WHERE id = ?
    `).run(cleanReason || null, nowIso, actorEmail || null, suspicious ? 1 : 0, licenseId);
    const signedRow = updateLicenseSignature(licenseId);

    if (userDowngraded) {
      usersDb.updateUserSubscription(row.redeemed_by, 'free', null, null);
    }

    return {
      license: publicLicenseRow({
        ...signedRow,
        status: 'revoked',
        revoked_reason: cleanReason || null,
        revoked_at: nowIso,
        revoked_by: actorEmail || null,
        suspicious: suspicious ? 1 : 0
      }),
      userDowngraded,
      redeemedBy: row.redeemed_by || ''
    };
  });

  return revoke();
}

function getLicenseStatus(userEmail) {
  const user = usersDb.findUserByEmailOrUsername(userEmail);
  if (!user) throw new Error('User not found');
  return {
    subscription: user.subscription,
    rawSubscription: user.rawSubscription,
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    subscriptionExpired: user.subscriptionExpired,
    subscriptionMachineBound: !!user.subscriptionMachineBound,
    subscriptionMachineMismatch: !!user.subscriptionMachineMismatch,
    subscriptionTampered: !!user.subscriptionTampered,
    subscriptionSignatureValid: !!user.subscriptionSignatureValid,
    active: user.subscription !== 'free',
    role: user.role || 'user'
  };
}

function listLicenseKeys(limit = 100) {
  const count = Math.max(1, Math.min(Math.round(Number(limit) || 100), 250));
  return db.prepare(`
    SELECT * FROM license_keys
    ORDER BY id DESC
    LIMIT ?
  `).all(count).map(publicLicenseRow);
}

ensureLicenseSignatures();

module.exports = {
  PLAN_CONFIGS,
  canonicalizeKey,
  hashKey,
  formatLicenseKey,
  signLicenseRow,
  verifyLicenseRow,
  generateLicenseKeys,
  redeemLicenseKey,
  revokeLicenseKey,
  getLicenseStatus,
  listLicenseKeys
};
