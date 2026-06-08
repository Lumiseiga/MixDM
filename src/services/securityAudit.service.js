const { db } = require('../../database');

const ALLOWED_SEVERITIES = new Set(['info', 'warn', 'critical']);

function sanitize(value, maxLength = 1000) {
  return String(value || '')
    .replace(/bearer\s+\S+/gi, 'bearer [REDACTED]')
    .replace(/\b[0-9a-f]{40,}\b/gi, '[HASH]')
    .replace(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi, '[EMAIL]')
    .slice(0, maxLength);
}

function recordSecurityEvent(eventType, { severity = 'info', actorEmail = '', ipAddress = '', detail = '' } = {}) {
  const safeSeverity = ALLOWED_SEVERITIES.has(severity) ? severity : 'info';
  db.prepare(`
    INSERT INTO security_audit_logs (event_type, severity, actor_email, ip_address, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sanitize(eventType, 80),
    safeSeverity,
    sanitize(actorEmail, 254),
    sanitize(ipAddress, 80),
    sanitize(detail, 1000)
  );

  const total = db.prepare('SELECT COUNT(*) as n FROM security_audit_logs').get().n;
  if (total > 1000) {
    db.prepare(`
      DELETE FROM security_audit_logs WHERE id IN (
        SELECT id FROM security_audit_logs ORDER BY created_at ASC LIMIT ?
      )
    `).run(total - 1000);
  }
}

function listSecurityEvents(limit = 100) {
  const count = Math.max(1, Math.min(Math.round(Number(limit) || 100), 250));
  return db.prepare(`
    SELECT id, event_type, severity, actor_email, ip_address, detail, created_at
    FROM security_audit_logs
    ORDER BY id DESC
    LIMIT ?
  `).all(count).map(row => ({
    id: row.id,
    eventType: row.event_type,
    severity: row.severity,
    actorEmail: row.actor_email || '',
    ipAddress: row.ip_address || '',
    detail: row.detail || '',
    createdAt: row.created_at
  }));
}

function clearSecurityEvents({ actorEmail = '', ipAddress = '' } = {}) {
  const removed = db.prepare('SELECT COUNT(*) as n FROM security_audit_logs').get().n;
  db.prepare('DELETE FROM security_audit_logs').run();
  recordSecurityEvent('security_audit_cleared', {
    severity: 'warn',
    actorEmail,
    ipAddress,
    detail: `Cleared ${removed} security audit event(s)`
  });
  return removed;
}

module.exports = {
  recordSecurityEvent,
  listSecurityEvents,
  clearSecurityEvents
};
