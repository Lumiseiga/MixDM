const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { version: APP_VERSION } = require('../../package.json');
const { getConfig, setConfig } = require('../../database');
const { recordSecurityEvent } = require('./securityAudit.service');

const ROOT_DIR = path.join(__dirname, '..', '..');
const INTEGRITY_FILES = [
  'package.json',
  'app-paths.js',
  'console-safe.js',
  'electron-main.js',
  'database.js',
  'users-db.js',
  'reports-db.js',
  'machine-id.js',
  'downloader.js',
  'preload.js',
  'settings.js',
  'ytdlp-engine.js',
  'extension/background.js',
  'extension/content-script.js',
  'extension/manifest.json',
  'public/hud.html',
  'public/index.html',
  'public/css/components.css',
  'public/css/hud.css',
  'public/css/layout.css',
  'public/css/theme.css',
  'public/js/app.js',
  'public/js/auth.js',
  'public/js/downloads.js',
  'public/js/hud.js',
  'public/js/i18n.js',
  'public/js/safety.js',
  'public/js/video-formats.js',
  'src/server.js',
  'src/routes/auth.routes.js',
  'src/routes/download.routes.js',
  'src/routes/license.routes.js',
  'src/routes/safety.routes.js',
  'src/routes/video.routes.js',
  'src/middleware/auth.middleware.js',
  'src/middleware/cors.middleware.js',
  'src/middleware/rateLimit.middleware.js',
  'src/services/auth.service.js',
  'src/services/cookieBridge.service.js',
  'src/services/download.service.js',
  'src/services/connectionPolicy.service.js',
  'src/services/license.service.js',
  'src/services/queue.service.js',
  'src/services/retry.service.js',
  'src/services/safety.service.js',
  'src/services/securityAudit.service.js',
  'src/services/speedMode.service.js',
  'src/services/speedQuota.service.js',
  'src/services/ytdlp.service.js',
  'src/services/integrity.service.js',
  'src/utils/events.js',
  'src/utils/file.js',
  'src/utils/format.js',
  'src/utils/hash.js'
];

function hashFile(relativePath) {
  const filePath = path.join(ROOT_DIR, relativePath);
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function buildManifest() {
  const files = {};
  for (const relativePath of INTEGRITY_FILES) {
    try {
      files[relativePath] = hashFile(relativePath);
    } catch (err) {
      files[relativePath] = `missing:${err.code || 'error'}`;
    }
  }
  return {
    version: APP_VERSION,
    createdAt: new Date().toISOString(),
    files
  };
}

function manifestConfigKey() {
  return `integrity_manifest_v1_${APP_VERSION}`;
}

function verifyIntegrity() {
  const current = buildManifest();
  const key = manifestConfigKey();
  const rawBaseline = getConfig(key);

  if (!rawBaseline) {
    setConfig(key, JSON.stringify(current));
    recordSecurityEvent('integrity_baseline_created', {
      severity: 'info',
      detail: `Created baseline for ${APP_VERSION} with ${INTEGRITY_FILES.length} files`
    });
    return { ok: true, baselineCreated: true, mismatches: [] };
  }

  let baseline;
  try {
    baseline = JSON.parse(rawBaseline);
  } catch (_) {
    setConfig(key, JSON.stringify(current));
    recordSecurityEvent('integrity_baseline_recreated', {
      severity: 'warn',
      detail: 'Integrity baseline was unreadable and has been recreated'
    });
    return { ok: true, baselineCreated: true, mismatches: [] };
  }

  const mismatches = [];
  for (const relativePath of INTEGRITY_FILES) {
    const expected = baseline.files?.[relativePath];
    const actual = current.files[relativePath];
    if (expected && actual && expected !== actual) {
      mismatches.push({ file: relativePath, expected, actual });
    }
  }

  if (mismatches.length > 0) {
    recordSecurityEvent('integrity_mismatch_detected', {
      severity: 'critical',
      detail: mismatches.map(item => item.file).join(', ')
    });
    console.warn(`[Security] Integrity mismatch detected: ${mismatches.map(item => item.file).join(', ')}`);
    return { ok: false, baselineCreated: false, mismatches };
  }

  return { ok: true, baselineCreated: false, mismatches: [] };
}

function resetIntegrityBaseline({ actorEmail = '', ipAddress = '' } = {}) {
  const current = buildManifest();
  setConfig(manifestConfigKey(), JSON.stringify(current));
  recordSecurityEvent('integrity_baseline_reset', {
    severity: 'warn',
    actorEmail,
    ipAddress,
    detail: `Trusted current ${APP_VERSION} build with ${INTEGRITY_FILES.length} files`
  });
  return { ok: true, baselineCreated: true, mismatches: [], manifest: current };
}

module.exports = {
  INTEGRITY_FILES,
  verifyIntegrity,
  resetIntegrityBaseline
};
