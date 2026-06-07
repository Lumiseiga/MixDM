/**
 * reports-db.js
 * Manages storage of bug/crash/security reports, backed by SQLite (via database.js).
 * Never stores credentials, tokens, or full stack traces with sensitive paths.
 * Public API is identical to the old JSON-based version.
 */

const crypto = require('crypto');
const { db } = require('./database');

// ─── Sensitive-Data Patterns (redacted before storing) ───────────────────────

const SENSITIVE_PATTERNS = [
  // JWT tokens (eyJ... base64 header)
  /eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+(\.[a-zA-Z0-9_\-]+)?/g,
  // HMAC tokens (long hex strings 40+ chars)
  /\b[0-9a-f]{40,}\b/gi,
  // Authorization header values
  /bearer\s+\S+/gi,
  // Email addresses
  /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi,
  // Windows absolute paths (may expose username)
  /[A-Z]:\\Users\\[^\\]+/gi,
  /\/home\/[^/]+/gi,
  // Passwords in query strings
  /password=[^&\s]*/gi,
  /token=[^&\s]*/gi,
];

/**
 * Sanitize a string by removing/redacting sensitive data.
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
  if (!text || typeof text !== 'string') return '';
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  // Trim to max 2000 chars to prevent huge payloads
  return result.substring(0, 2000);
}

function escapeHtml(text) {
  if (!text || typeof text !== 'string') return '';
  return text.substring(0, 150)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a new report (sanitized).
 * @param {'bug'|'crash'|'security'} type
 * @param {object} data - User-provided fields
 * @returns {object} Saved report record
 */
function saveReport(type, data) {
  const id = crypto.randomBytes(8).toString('hex');
  const safeType = ['bug', 'crash', 'security'].includes(type) ? type : 'bug';
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO reports
      (id, type, title, description, steps, error_message, stack_trace, detail, app_version, platform, sender_name, sender_email, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    safeType,
    sanitize(data.title        || ''),
    sanitize(data.description  || ''),
    sanitize(data.steps        || ''),
    sanitize(data.errorMessage || ''),
    sanitize(data.stackTrace   || ''),
    sanitize(data.detail       || ''),
    sanitize(data.appVersion   || ''),
    sanitize(data.platform     || ''),
    escapeHtml(data.senderName || ''),
    escapeHtml(data.senderEmail || ''),
    now
  );

  // Keep only the latest 500 reports to prevent unbounded growth
  const totalCount = db.prepare('SELECT COUNT(*) as n FROM reports').get().n;
  if (totalCount > 500) {
    db.prepare(`
      DELETE FROM reports WHERE id IN (
        SELECT id FROM reports ORDER BY created_at ASC LIMIT ?
      )
    `).run(totalCount - 500);
  }

  return {
    id,
    type: safeType,
    timestamp: now,
    title:        sanitize(data.title        || ''),
    description:  sanitize(data.description  || ''),
    steps:        sanitize(data.steps        || ''),
    errorMessage: sanitize(data.errorMessage || ''),
    stackTrace:   sanitize(data.stackTrace   || ''),
    detail:       sanitize(data.detail       || ''),
    appVersion:   sanitize(data.appVersion   || ''),
    platform:     sanitize(data.platform     || ''),
    senderName:   escapeHtml(data.senderName || ''),
    senderEmail:  escapeHtml(data.senderEmail || ''),
  };
}

/**
 * Get all reports, optionally filtered by type.
 * @param {'bug'|'crash'|'security'|undefined} type
 * @returns {object[]}
 */
function getReports(type) {
  let rows;
  if (type && ['bug', 'crash', 'security'].includes(type)) {
    rows = db.prepare('SELECT * FROM reports WHERE type = ? ORDER BY created_at DESC').all(type);
  } else {
    rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  }

  return rows.map(r => ({
    id:           r.id,
    type:         r.type,
    timestamp:    r.created_at,
    title:        r.title         || '',
    description:  r.description   || '',
    steps:        r.steps         || '',
    errorMessage: r.error_message || '',
    stackTrace:   r.stack_trace   || '',
    detail:       r.detail        || '',
    appVersion:   r.app_version   || '',
    platform:     r.platform      || '',
    senderName:   r.sender_name   || '',
    senderEmail:  r.sender_email  || '',
  }));
}

/**
 * Clear all stored reports.
 */
function clearReports() {
  try {
    db.prepare('DELETE FROM reports').run();
    return true;
  } catch (err) {
    console.error('[reports-db] Failed to clear reports:', err.message);
    return false;
  }
}

module.exports = { saveReport, getReports, clearReports, sanitize };
