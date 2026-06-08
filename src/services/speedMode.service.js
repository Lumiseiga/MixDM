const { getSettings } = require('../../settings');

const SPEED_MODES = {
  full: {
    id: 'full',
    label: 'Full Speed',
    limitKbps: 0
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    limitKbps: 51200
  },
  quiet: {
    id: 'quiet',
    label: 'Quiet Mode',
    limitKbps: 10240
  }
};

function normalizeMode(value) {
  const mode = String(value || getSettings().speedMode || 'full').toLowerCase();
  return SPEED_MODES[mode] ? mode : 'full';
}

function normalizeLimit(value) {
  const limit = Number(value) || 0;
  if (limit <= 0) return 0;
  return Math.max(128, Math.min(Math.round(limit), 1048576));
}

function resolveSpeedMode({ requestedSpeedLimitKbps = 0, speedMode } = {}) {
  const modeId = normalizeMode(speedMode);
  const mode = SPEED_MODES[modeId];
  const requested = normalizeLimit(requestedSpeedLimitKbps);
  const modeLimit = mode.limitKbps;
  let effectiveRequestedSpeedLimitKbps = requested;

  if (modeLimit > 0) {
    effectiveRequestedSpeedLimitKbps = requested > 0
      ? Math.min(requested, modeLimit)
      : modeLimit;
  }

  return {
    mode: mode.id,
    label: mode.label,
    modeLimitKbps: modeLimit,
    requestedSpeedLimitKbps: requested,
    effectiveRequestedSpeedLimitKbps
  };
}

module.exports = {
  SPEED_MODES,
  resolveSpeedMode
};
