const express = require('express');
const { requireDeveloper } = require('../middleware/auth.middleware');
const {
  checkLicenseRedeemLockout,
  clearLicenseRedeemFailures,
  recordLicenseRedeemFailure
} = require('../middleware/rateLimit.middleware');
const {
  generateLicenseKeys,
  getLicenseStatus,
  listLicenseKeys,
  redeemLicenseKey,
  revokeLicenseKey
} = require('../services/license.service');
const {
  clearSecurityEvents,
  listSecurityEvents,
  recordSecurityEvent
} = require('../services/securityAudit.service');
const { resetIntegrityBaseline } = require('../services/integrity.service');
const { serverEvents } = require('../utils/events');

const router = express.Router();

function publicRedeemError(err) {
  const message = String(err && err.message ? err.message : err || '');
  if (/invalid key format|license key not found|integrity|signature|tamper/i.test(message)) {
    return 'Invalid license key';
  }
  return message || 'Failed to redeem license key';
}

router.get('/license/status', (req, res) => {
  try {
    res.json({ success: true, status: getLicenseStatus(req.userEmail) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/license/redeem', checkLicenseRedeemLockout, (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ success: false, error: 'License key is required' });
    const result = redeemLicenseKey(key, req.userEmail);
    clearLicenseRedeemFailures(req);
    recordSecurityEvent('license_redeem_success', {
      severity: 'info',
      actorEmail: req.userEmail,
      ipAddress: req.ip,
      detail: `Redeemed ${result.plan} license; expires=${result.expiresAt || 'never'}`
    });
    res.json({
      success: true,
      message: 'License key redeemed successfully',
      license: result.license,
      plan: result.plan,
      label: result.label,
      expiresAt: result.expiresAt,
      user: {
        email: result.user.email,
        displayName: result.user.displayName,
        role: result.user.role,
        avatarUrl: result.user.avatarUrl,
        bio: result.user.bio,
        subscription: result.user.subscription,
        subscriptionExpiresAt: result.user.subscriptionExpiresAt,
        subscriptionMachineBound: !!result.user.subscriptionMachineBound
      }
    });
  } catch (err) {
    recordLicenseRedeemFailure(req);
    recordSecurityEvent('license_redeem_failed', {
      severity: 'warn',
      actorEmail: req.userEmail,
      ipAddress: req.ip,
      detail: publicRedeemError(err)
    });
    res.status(400).json({ success: false, error: publicRedeemError(err) });
  }
});

router.get('/developer/license-keys', requireDeveloper, (req, res) => {
  try {
    res.json({ success: true, keys: listLicenseKeys(req.query.limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/developer/license-keys', requireDeveloper, (req, res) => {
  try {
    const { plan, quantity } = req.body || {};
    const keys = generateLicenseKeys({
      plan,
      quantity,
      createdBy: req.userEmail
    });
    recordSecurityEvent('license_keys_generated', {
      severity: 'info',
      actorEmail: req.userEmail,
      ipAddress: req.ip,
      detail: `Generated ${keys.length} key(s) for ${plan}`
    });
    res.json({ success: true, keys });
  } catch (err) {
    recordSecurityEvent('license_key_generation_failed', {
      severity: 'warn',
      actorEmail: req.userEmail,
      ipAddress: req.ip,
      detail: err.message
    });
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/developer/license-keys/:id/revoke', requireDeveloper, (req, res) => {
  try {
    const { reason, suspicious } = req.body || {};
    const result = revokeLicenseKey(req.params.id, {
      actorEmail: req.userEmail,
      reason,
      suspicious: !!suspicious || !!String(reason || '').trim()
    });
    recordSecurityEvent('license_key_revoked', {
      severity: result.license.suspicious ? 'critical' : 'warn',
      actorEmail: req.userEmail,
      ipAddress: req.ip,
      detail: [
        `Revoked ${result.license.plan} key #${result.license.id}`,
        result.license.suspicious ? 'marked suspicious' : '',
        result.userDowngraded ? `downgraded ${result.redeemedBy} to free` : '',
        result.license.revokedReason ? `reason=${result.license.revokedReason}` : ''
      ].filter(Boolean).join('; ')
    });
    res.json({ success: true, ...result });
  } catch (err) {
    recordSecurityEvent('license_key_revoke_failed', {
      severity: 'warn',
      actorEmail: req.userEmail,
      ipAddress: req.ip,
      detail: err.message
    });
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/developer/security-audit', requireDeveloper, (req, res) => {
  try {
    res.json({ success: true, events: listSecurityEvents(req.query.limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/developer/security-audit', requireDeveloper, (req, res) => {
  try {
    const removed = clearSecurityEvents({
      actorEmail: req.userEmail,
      ipAddress: req.ip
    });
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/developer/integrity-baseline/reset', requireDeveloper, (req, res) => {
  try {
    const result = resetIntegrityBaseline({
      actorEmail: req.userEmail,
      ipAddress: req.ip
    });
    serverEvents.emit('integrity-baseline-reset', result);
    res.json({
      success: true,
      message: 'Integrity baseline reset to current trusted build',
      files: Object.keys(result.manifest.files || {})
    });
  } catch (err) {
    recordSecurityEvent('integrity_baseline_reset_failed', {
      severity: 'critical',
      actorEmail: req.userEmail,
      ipAddress: req.ip,
      detail: err.message
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
