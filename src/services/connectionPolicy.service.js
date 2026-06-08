const usersDb = require('../../users-db');

const MAX_CONNECTIONS = 32;
const PLAN_CONNECTION_LIMITS = {
  free: 8,
  pro_monthly: 32,
  pro_yearly: 32,
  lifetime: 32
};

function normalizePlan(value) {
  const plan = String(value || 'free').toLowerCase();
  if (plan === 'life' || plan === 'lifetime') return 'lifetime';
  if (plan === 'pro_yearly' || plan === 'pro-yearly' || plan === 'yearly') return 'pro_yearly';
  if (plan === 'pro' || plan === 'premium' || plan === 'pro_monthly' || plan === 'pro-monthly' || plan === 'monthly') return 'pro_monthly';
  return 'free';
}

function getUserForPolicy(userEmail) {
  if (!userEmail) return null;
  try {
    return usersDb.findUserByEmailOrUsername(userEmail);
  } catch (_) {
    return null;
  }
}

function getConnectionEntitlement(userEmail) {
  const user = getUserForPolicy(userEmail);
  const role = String(user?.role || 'user').toLowerCase();

  if (role === 'admin' || role === 'developer') {
    return {
      plan: role,
      label: role === 'admin' ? 'Admin' : 'Developer',
      maxConnections: MAX_CONNECTIONS
    };
  }

  const plan = normalizePlan(user?.subscription);
  return {
    plan,
    label: plan === 'free' ? 'Free'
      : plan === 'pro_monthly' ? 'Pro Monthly'
      : plan === 'pro_yearly' ? 'Pro Yearly'
      : 'Lifetime',
    maxConnections: PLAN_CONNECTION_LIMITS[plan] || PLAN_CONNECTION_LIMITS.free
  };
}

function normalizeSegments(value) {
  return Math.max(1, Math.min(Math.round(Number(value) || 16), MAX_CONNECTIONS));
}

function applyConnectionPolicy({ userEmail, requestedSegments = 16, imageFormat = 'original' } = {}) {
  const entitlement = getConnectionEntitlement(userEmail);
  const requested = imageFormat && imageFormat !== 'original'
    ? 1
    : normalizeSegments(requestedSegments);
  const effective = Math.min(requested, entitlement.maxConnections);

  return {
    ...entitlement,
    requestedSegments: requested,
    effectiveSegments: effective,
    clamped: effective < requested
  };
}

module.exports = {
  MAX_CONNECTIONS,
  PLAN_CONNECTION_LIMITS,
  getConnectionEntitlement,
  applyConnectionPolicy
};
