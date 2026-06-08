const usersDb = require('../../users-db');
const { db } = require('../../database');

const FALLBACK_LIMIT_KBPS = 5120;
const PRO_MONTHLY_FALLBACK_LIMIT_KBPS = 10240;
const PRO_YEARLY_FALLBACK_LIMIT_KBPS = 15360;
const LIFETIME_FALLBACK_LIMIT_KBPS = 15360;
const MAX_CUSTOM_LIMIT_KBPS = 1048576;

const PLAN_POLICIES = {
  free: {
    label: 'Free',
    dailyQuota: 8,
    fallbackLimitKbps: FALLBACK_LIMIT_KBPS
  },
  pro_monthly: {
    label: 'Pro Monthly',
    dailyQuota: 50,
    fallbackLimitKbps: PRO_MONTHLY_FALLBACK_LIMIT_KBPS
  },
  pro_yearly: {
    label: 'Pro Yearly',
    dailyQuota: 100,
    fallbackLimitKbps: PRO_YEARLY_FALLBACK_LIMIT_KBPS
  },
  lifetime: {
    label: 'Lifetime',
    dailyQuota: 250,
    fallbackLimitKbps: LIFETIME_FALLBACK_LIMIT_KBPS
  }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS speed_quota_usage (
    user_key   TEXT NOT NULL,
    quota_date TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_key, quota_date)
  )
`);

function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizePlan(value) {
  const plan = String(value || 'free').toLowerCase();
  if (plan === 'life' || plan === 'lifetime') return 'lifetime';
  if (plan === 'pro_yearly' || plan === 'pro-yearly' || plan === 'yearly') return 'pro_yearly';
  if (plan === 'pro' || plan === 'premium' || plan === 'pro_monthly' || plan === 'pro-monthly' || plan === 'monthly') return 'pro_monthly';
  return 'free';
}

function getUserForQuota(userEmail) {
  if (!userEmail) return null;
  try {
    return usersDb.findUserByEmailOrUsername(userEmail);
  } catch (_) {
    return null;
  }
}

function resolvePolicy(userEmail) {
  const user = getUserForQuota(userEmail);
  const role = String(user?.role || 'user').toLowerCase();
  const userKey = user?.email || userEmail || 'anonymous';

  if (role === 'admin' || role === 'developer') {
    return {
      user,
      userKey,
      plan: role,
      label: role === 'admin' ? 'Admin' : 'Developer',
      dailyQuota: Infinity,
      fallbackLimitKbps: 0
    };
  }

  const plan = normalizePlan(user?.subscription);
  const base = PLAN_POLICIES[plan] || PLAN_POLICIES.free;
  return {
    user,
    userKey,
    plan,
    label: base.label,
    dailyQuota: base.dailyQuota,
    fallbackLimitKbps: base.fallbackLimitKbps
  };
}

function getUsed(userKey, date = todayKey()) {
  const row = db.prepare(`
    SELECT used FROM speed_quota_usage WHERE user_key = ? AND quota_date = ?
  `).get(userKey, date);
  return row ? row.used : 0;
}

function incrementUsed(userKey, date = todayKey()) {
  db.prepare(`
    INSERT INTO speed_quota_usage (user_key, quota_date, used, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(user_key, quota_date)
    DO UPDATE SET used = used + 1, updated_at = datetime('now')
  `).run(userKey, date);
  return getUsed(userKey, date);
}

function normalizeRequestedLimit(speedLimitKbps) {
  const value = Number(speedLimitKbps) || 0;
  if (value <= 0) return 0;
  return Math.max(128, Math.min(Math.round(value), MAX_CUSTOM_LIMIT_KBPS));
}

function buildStatus(policy, used) {
  const unlimited = policy.dailyQuota === Infinity;
  return {
    plan: policy.plan,
    label: policy.label,
    date: todayKey(),
    dailyQuota: unlimited ? null : policy.dailyQuota,
    used: unlimited ? 0 : used,
    remaining: unlimited ? null : Math.max(policy.dailyQuota - used, 0),
    unlimited,
    fallbackLimitKbps: policy.fallbackLimitKbps
  };
}

function getQuotaStatus(userEmail) {
  const policy = resolvePolicy(userEmail);
  return buildStatus(policy, getUsed(policy.userKey));
}

function applySpeedPolicy({ userEmail, requestedSpeedLimitKbps = 0 } = {}) {
  const policy = resolvePolicy(userEmail);
  const requested = normalizeRequestedLimit(requestedSpeedLimitKbps);
  const usedBefore = getUsed(policy.userKey);
  const unlimitedPlan = policy.dailyQuota === Infinity;

  let quotaConsumed = false;
  let quotaWasExhausted = false;
  let effectiveSpeedLimitKbps = requested;

  if (!unlimitedPlan) {
    const remaining = Math.max(policy.dailyQuota - usedBefore, 0);
    if (remaining > 0) {
      incrementUsed(policy.userKey);
      quotaConsumed = true;
    } else {
      quotaWasExhausted = true;
      effectiveSpeedLimitKbps = requested > 0
        ? Math.min(requested, policy.fallbackLimitKbps)
        : policy.fallbackLimitKbps;
    }
  }

  if (!unlimitedPlan && !quotaWasExhausted && policy.fallbackLimitKbps > 0 && requested > 0 && requested <= policy.fallbackLimitKbps) {
    effectiveSpeedLimitKbps = requested;
  }

  const status = getQuotaStatus(userEmail);
  return {
    effectiveSpeedLimitKbps,
    requestedSpeedLimitKbps: requested,
    quotaConsumed,
    quotaWasExhausted,
    quota: status
  };
}

module.exports = {
  FALLBACK_LIMIT_KBPS,
  MAX_CUSTOM_LIMIT_KBPS,
  applySpeedPolicy,
  getQuotaStatus
};
