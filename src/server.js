/**
 * MIXDM - Express API Server
 * Serves the frontend and exposes REST + SSE endpoints
 * Supports both HTTP/HTTPS segmented downloads and yt-dlp (YouTube/Social)
 */

const express = require('express');
const path = require('path');
require('../console-safe').installSafeConsole();
const { version: APP_VERSION } = require('../package.json');
const { getSettings, saveSettings } = require('../settings');
const { isYtdlpInstalled, isFfmpegInstalled } = require('../ytdlp-engine');

const { DOWNLOADS_DIR } = require('./utils/file');
const { authenticateToken } = require('./middleware/auth.middleware');
const { checkGlobalRateLimit } = require('./middleware/rateLimit.middleware');
const { setCorsHeaders } = require('./middleware/cors.middleware');

const { manager } = require('./services/download.service');
const { ytTasks, ytdlpEvents } = require('./services/ytdlp.service');
const { handleTaskUpdate, enqueueTask, processQueue } = require('./services/queue.service');
const { scheduleRetry, resetRetryState } = require('./services/retry.service');
const { serverEvents } = require('./utils/events');
const { verifyIntegrity } = require('./services/integrity.service');

const authRoutes = require('./routes/auth.routes');
const downloadRoutes = require('./routes/download.routes');
const videoRoutes = require('./routes/video.routes');
const safetyRoutes = require('./routes/safety.routes');
const licenseRoutes = require('./routes/license.routes');

const app = express();
const PORT = 3737;
let httpServer = null;
let integrityStatus = null;

// CORS and Global Pre-routing Middlewares
app.use((req, res, next) => {
  setCorsHeaders(req, res);
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  // Global rate limit — exempt OPTIONS and static files
  if (req.path.startsWith('/api/') && !checkGlobalRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Too many requests, please slow down (Rate limit exceeded)' });
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Global API authentication middleware mount
app.use(authenticateToken);

// Mount Router Modules
app.use('/api/auth', authRoutes);
app.use('/api', downloadRoutes);
app.use('/api', videoRoutes);
app.use('/api', safetyRoutes);
app.use('/api', licenseRoutes);

// ─── SSE: Real-time Progress Stream ──────────────────────────────────────
const sseClients = new Set();
const TASK_UPDATE_MIN_INTERVAL_MS = 750;
const THROTTLED_TASK_STATUSES = new Set(['downloading', 'merging', 'extracting']);
const taskUpdateState = new Map();

serverEvents.on('integrity-baseline-reset', (status) => {
  integrityStatus = {
    ok: !!status?.ok,
    baselineCreated: !!status?.baselineCreated,
    mismatches: status?.mismatches || []
  };
});

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function sendTaskUpdateNow(taskData) {
  if (!taskData || !taskData.id) return;
  const state = taskUpdateState.get(taskData.id);
  if (state?.timer) clearTimeout(state.timer);
  taskUpdateState.set(taskData.id, {
    status: taskData.status,
    time: Date.now(),
    timer: null,
    pending: null
  });
  broadcastSSE(taskData);
  serverEvents.emit('download-task-updated', taskData);
  if (['done', 'error', 'cancelled'].includes(taskData.status)) {
    taskUpdateState.delete(taskData.id);
  }
}

function dispatchTaskUpdate(taskData) {
  if (!taskData || !taskData.id) {
    broadcastSSE(taskData);
    return;
  }

  const state = taskUpdateState.get(taskData.id);
  const now = Date.now();
  const statusChanged = state?.status !== taskData.status;
  const shouldThrottle = THROTTLED_TASK_STATUSES.has(taskData.status) && !statusChanged;

  if (!shouldThrottle || !state || now - state.time >= TASK_UPDATE_MIN_INTERVAL_MS) {
    sendTaskUpdateNow(taskData);
    return;
  }

  state.pending = taskData;
  if (!state.timer) {
    state.timer = setTimeout(() => {
      const latest = taskUpdateState.get(taskData.id);
      if (!latest?.pending) return;
      sendTaskUpdateNow(latest.pending);
    }, Math.max(0, TASK_UPDATE_MIN_INTERVAL_MS - (now - state.time)));
  }
}

manager.onProgress((taskData) => {
  if (taskData.status === 'done' || taskData.status === 'cancelled') {
    resetRetryState(manager.getTask(taskData.id));
  }
  if (taskData.status === 'error' && scheduleRetry(taskData, enqueueTask)) return;
  dispatchTaskUpdate(taskData);
  handleTaskUpdate(taskData);
});

ytdlpEvents.on('task-updated', (taskData) => {
  if (taskData.status === 'done' || taskData.status === 'cancelled') {
    resetRetryState(ytTasks.get(taskData.id));
  }
  if (taskData.status === 'error' && scheduleRetry(taskData, enqueueTask)) return;
  dispatchTaskUpdate(taskData);
  handleTaskUpdate(taskData);
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send all current tasks on connect
  const allHttpTasks = manager.getAllTasks();
  const allYtTasks = [...ytTasks.values()].map(t => t.toJSON());
  const allTasks = [...allHttpTasks, ...allYtTasks];

  if (allTasks.length > 0) {
    res.write(`data: ${JSON.stringify({ type: 'init', tasks: allTasks })}\n\n`);
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Shared Server Configuration Endpoints ────────────────────────────────────

app.get('/api/config', (req, res) => {
  const settings = getSettings();
  let autoLaunch = false;
  try {
    const { app } = require('electron');
    autoLaunch = app.getLoginItemSettings().openAtLogin;
  } catch (_) {}

  res.json({
    version: APP_VERSION,
    downloadsDir: settings.downloadsDir || DOWNLOADS_DIR,
    ytdlpInstalled: isYtdlpInstalled(),
    ffmpegInstalled: isFfmpegInstalled(),
    cookiesEnabled: settings.cookiesEnabled,
    cookiesBrowser: settings.cookiesBrowser,
    language: settings.language,
    autoLaunchEnabled: autoLaunch,
    integrityOk: !integrityStatus || !!integrityStatus.ok,
    integrityBaselineCreated: !!integrityStatus?.baselineCreated,
    integrityMismatchCount: integrityStatus?.mismatches?.length || 0
  });
});

app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', (req, res) => {
  const {
    cookiesEnabled,
    cookiesBrowser,
    theme,
    language,
    downloadsDir,
    defaultSegments,
    maxConcurrentDownloads,
    smartRetryEnabled,
    smartRetryMaxAttempts,
    smartRetryBaseDelayMs,
    speedMode,
    performanceMeterIntervalMs,
    speedLimitEnabled,
    speedLimitKbps,
    autoAnalyze,
    clearAfterStart,
    clipboardMonitorEnabled,
    clipboardNotificationsEnabled,
    completionSoundEnabled,
    showMiniHud,
    autoLaunchEnabled
  } = req.body;

  const patch = {};
  if (typeof cookiesEnabled === 'boolean') patch.cookiesEnabled = cookiesEnabled;
  if (typeof cookiesBrowser === 'string') patch.cookiesBrowser = cookiesBrowser;
  if (typeof theme === 'string') patch.theme = theme;
  if (typeof language === 'string') patch.language = language;
  if (typeof downloadsDir === 'string') patch.downloadsDir = downloadsDir;
  if (typeof defaultSegments === 'number') {
    patch.defaultSegments = Math.max(1, Math.min(Math.round(defaultSegments), 32));
  }
  if (typeof maxConcurrentDownloads === 'number') {
    patch.maxConcurrentDownloads = Math.max(1, Math.min(Math.round(maxConcurrentDownloads), 10));
  }
  if (typeof smartRetryEnabled === 'boolean') patch.smartRetryEnabled = smartRetryEnabled;
  if (typeof smartRetryMaxAttempts === 'number') {
    patch.smartRetryMaxAttempts = Math.max(0, Math.min(Math.round(smartRetryMaxAttempts), 10));
  }
  if (typeof smartRetryBaseDelayMs === 'number') {
    patch.smartRetryBaseDelayMs = Math.max(1000, Math.min(Math.round(smartRetryBaseDelayMs), 60000));
  }
  if (typeof speedMode === 'string' && ['full', 'balanced', 'quiet'].includes(speedMode)) {
    patch.speedMode = speedMode;
  }
  if (typeof performanceMeterIntervalMs === 'number' && [500, 2500, 5000].includes(performanceMeterIntervalMs)) {
    patch.performanceMeterIntervalMs = performanceMeterIntervalMs;
  }
  if (typeof speedLimitEnabled === 'boolean') patch.speedLimitEnabled = speedLimitEnabled;
  if (typeof speedLimitKbps === 'number') {
    patch.speedLimitKbps = Math.max(128, Math.min(Math.round(speedLimitKbps), 1048576));
  }
  if (typeof autoAnalyze === 'boolean') patch.autoAnalyze = autoAnalyze;
  if (typeof clearAfterStart === 'boolean') patch.clearAfterStart = clearAfterStart;
  if (typeof clipboardMonitorEnabled === 'boolean') patch.clipboardMonitorEnabled = clipboardMonitorEnabled;
  if (typeof clipboardNotificationsEnabled === 'boolean') patch.clipboardNotificationsEnabled = clipboardNotificationsEnabled;
  if (typeof completionSoundEnabled === 'boolean') patch.completionSoundEnabled = completionSoundEnabled;
  if (typeof showMiniHud === 'boolean') patch.showMiniHud = showMiniHud;
  if (typeof autoLaunchEnabled === 'boolean') patch.autoLaunchEnabled = autoLaunchEnabled;

  if (typeof autoLaunchEnabled === 'boolean') {
    try {
      const { app } = require('electron');
      app.setLoginItemSettings({
        openAtLogin: autoLaunchEnabled,
        openAsHidden: true,
        path: process.execPath,
        args: ['--autostart']
      });
    } catch (_) {}
  }

  saveSettings(patch);
  processQueue();
  res.json({ success: true, settings: getSettings() });
});

app.get('/api/extension/status', (req, res) => {
  res.json({
    ok: true,
    app: 'MIXDM',
    version: APP_VERSION,
    port: PORT,
    downloadsDir: DOWNLOADS_DIR,
    ytdlpInstalled: isYtdlpInstalled(),
    ffmpegInstalled: isFfmpegInstalled(),
  });
});

// Called by the browser extension to bring the Electron window to front
app.post('/api/focus-window', (req, res) => {
  serverEvents.emit('focus-window');
  res.json({ ok: true });
});

app.post('/api/extension/cookies', (req, res) => {
  const { storeCookiesForUrl } = require('./services/cookieBridge.service');
  const { url, cookies, cookiesHeader } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'URL is required' });
  const ok = storeCookiesForUrl(url, { cookies, cookiesHeader });
  res.json({ ok, count: Array.isArray(cookies) ? cookies.length : 0 });
});

app.get('/api/cookie-bridge/status', (req, res) => {
  const { getCookieStatusForUrl } = require('./services/cookieBridge.service');
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  res.json(getCookieStatusForUrl(url));
});

app.post('/api/extension/capture', async (req, res) => {
  try {
    const { validateDownloadUrl } = require('./utils/file');
    const { createYtdlpTask } = require('./services/ytdlp.service');
    const { createHttpTask } = require('./services/download.service');
    const { checkSafety, sanitizeFilename } = require('./services/safety.service');
    const { applySpeedPolicy } = require('./services/speedQuota.service');
    const { resolveSpeedMode } = require('./services/speedMode.service');
    const { applyConnectionPolicy } = require('./services/connectionPolicy.service');
    const { isYtdlpUrl } = require('../ytdlp-engine');

    const url = validateDownloadUrl(req.body.url);
    const {
      format,
      filename: rawFilename,
      imageFormat = 'original',
      title,
      thumbnail,
      segments = 16,
      speedLimitKbps = 0,
      speedMode,
      source = 'browser-extension',
      headers,
      cookiesBrowser,
      cookiesHeader,
      cookies
    } = req.body;

    // Sanitize filename to prevent directory traversal
    const filename = rawFilename ? sanitizeFilename(rawFilename) : undefined;

    if (isYtdlpUrl(url)) {
      if (!isYtdlpInstalled()) {
        return res.status(503).json({
          success: false,
          error: 'yt-dlp is not installed. Please restart the server.',
          isYtdlp: true,
          ytdlpMissing: true
        });
      }

      const speedModePolicy = resolveSpeedMode({ requestedSpeedLimitKbps: speedLimitKbps, speedMode });
      const speedPolicy = applySpeedPolicy({
        userEmail: req.userEmail,
        requestedSpeedLimitKbps: speedModePolicy.effectiveRequestedSpeedLimitKbps
      });
      speedPolicy.speedMode = speedModePolicy;
      const task = createYtdlpTask({
        url,
        format,
        title,
        thumbnail,
        speedLimitKbps: speedPolicy.effectiveSpeedLimitKbps,
        cookiesBrowser,
        cookiesHeader,
        cookies,
        speedPolicy
      });
      enqueueTask(task);
      return res.json({
        success: true,
        source,
        engine: 'yt-dlp',
        task: task.toJSON()
      });
    }

    // Safety check for direct HTTP downloads
    const safety = checkSafety(url, filename || title);
    if (!safety.safe) {
      const connectionPolicy = applyConnectionPolicy({
        userEmail: req.userEmail,
        requestedSegments: segments,
        imageFormat
      });
      const speedModePolicy = resolveSpeedMode({ requestedSpeedLimitKbps: speedLimitKbps, speedMode });
      const speedPolicy = applySpeedPolicy({
        userEmail: req.userEmail,
        requestedSpeedLimitKbps: speedModePolicy.effectiveRequestedSpeedLimitKbps
      });
      speedPolicy.speedMode = speedModePolicy;
      const task = manager.createTask(url, {
        filename: filename || undefined,
        segments: connectionPolicy.effectiveSegments,
        imageFormat,
        speedLimitKbps: speedPolicy.effectiveSpeedLimitKbps,
        headers
      });
      task.speedPolicy = speedPolicy;
      task.connectionPolicy = connectionPolicy;
      // Force pause state with security warning message
      task.status = 'paused';
      task.errorMessage = `⚠️ ความปลอดภัย: ${safety.message}`;
      manager._emit(task);
      return res.json({
        success: true,
        source,
        engine: 'http',
        task: task.toJSON()
      });
    }

    const speedModePolicy = resolveSpeedMode({ requestedSpeedLimitKbps: speedLimitKbps, speedMode });
    const speedPolicy = applySpeedPolicy({
      userEmail: req.userEmail,
      requestedSpeedLimitKbps: speedModePolicy.effectiveRequestedSpeedLimitKbps
    });
    speedPolicy.speedMode = speedModePolicy;
    const connectionPolicy = applyConnectionPolicy({
      userEmail: req.userEmail,
      requestedSegments: segments,
      imageFormat
    });
    const task = createHttpTask({
      url,
      filename,
      segments: connectionPolicy.effectiveSegments,
      imageFormat,
      speedLimitKbps: speedPolicy.effectiveSpeedLimitKbps,
      headers,
      speedPolicy,
      connectionPolicy
    });
    enqueueTask(task);
    return res.json({
      success: true,
      source,
      engine: 'http',
      task: task.toJSON()
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Clipboard Monitor (win32 only) ──────────────────────────────────────────
let clipboardProcess = null;
let clipboardRestartTimer = null;
let clipboardMonitorStopping = false;

function startClipboardMonitor() {
  if (process.platform !== 'win32') {
    console.log('[Clipboard Monitor] Disabled (Non-Windows platform)');
    return;
  }
  if (clipboardProcess) return;
  clipboardMonitorStopping = false;

  console.log('[Clipboard Monitor] Starting Windows Clipboard Monitor...');

  const powershellScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Windows.Forms
    $lastText = ""
    while ($true) {
      try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          $text = [System.Windows.Forms.Clipboard]::GetText()
          if ($text -and $text -ne $lastText) {
            $lastText = $text
            $trimmed = $text.Trim()
            if ($trimmed -match '^https?:\\/\\/[^\\s]+$') {
              Write-Output "URL:$trimmed"
            }
          }
        }
      } catch {}
      Start-Sleep -Milliseconds 1000
    }
  `;

  try {
    const { spawn } = require('child_process');
    clipboardProcess = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      powershellScript
    ]);

    clipboardProcess.stdout.on('data', (data) => {
      const lines = data.toString('utf8').split('\n');
      for (let line of lines) {
        line = line.trim();
        if (line.startsWith('URL:')) {
          const url = line.substring(4).trim();
          console.log('[Clipboard Monitor] Detected URL:', url);
          broadcastSSE({ type: 'clipboard-url', url });
        }
      }
    });

    clipboardProcess.stderr.on('data', (data) => {
      console.warn('[Clipboard Monitor stderr]:', data.toString('utf8').trim());
    });

    clipboardProcess.on('error', (err) => {
      console.error('[Clipboard Monitor] Process error:', err);
    });

    clipboardProcess.on('close', (code) => {
      if (clipboardMonitorStopping) {
        console.log(`[Clipboard Monitor] Process exited with code ${code}.`);
        clipboardProcess = null;
        return;
      }
      console.log(`[Clipboard Monitor] Process exited with code ${code}. Restarting in 5s...`);
      clipboardProcess = null;
      clipboardRestartTimer = setTimeout(startClipboardMonitor, 5000);
    });
  } catch (err) {
    console.error('[Clipboard Monitor] Failed to spawn powershell:', err);
  }
}

// Cleanup helper
function cleanupClipboardMonitor() {
  clipboardMonitorStopping = true;
  if (clipboardRestartTimer) {
    clearTimeout(clipboardRestartTimer);
    clipboardRestartTimer = null;
  }
  if (clipboardProcess) {
    try {
      const { execFileSync } = require('child_process');
      if (process.platform === 'win32' && clipboardProcess.pid) {
        execFileSync('taskkill', ['/pid', String(clipboardProcess.pid), '/f', '/t'], {
          stdio: 'ignore'
        });
      } else {
        clipboardProcess.kill();
      }
      console.log('[Clipboard Monitor] Process terminated');
    } catch (_) {}
    clipboardProcess = null;
  }
}

process.on('exit', cleanupClipboardMonitor);
process.on('SIGINT', () => {
  cleanupClipboardMonitor();
  process.exit();
});
process.on('SIGTERM', () => {
  cleanupClipboardMonitor();
  process.exit();
});

function startServer({ port = PORT, host, enableClipboardMonitor = true } = {}) {
  if (httpServer) {
    const address = httpServer.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    return Promise.resolve({
      app,
      server: httpServer,
      port: activePort,
      url: `http://127.0.0.1:${activePort}`,
    });
  }

  try {
    integrityStatus = verifyIntegrity();
  } catch (err) {
    integrityStatus = { ok: false, baselineCreated: false, mismatches: [], error: err.message };
    console.warn('[Security] Integrity check failed:', err.message);
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      httpServer = server;
      const address = server.address();
      const activePort = typeof address === 'object' && address ? address.port : port;

      console.log(`\nMIXDM Server running at http://localhost:${activePort}\n`);
      console.log(`   Downloads will be saved to: ${DOWNLOADS_DIR}`);
      console.log(`   yt-dlp: ${isYtdlpInstalled() ? 'Ready' : 'Not found (run setup first)'}`);
      console.log(`   ffmpeg: ${isFfmpegInstalled() ? 'Ready' : 'Not found (needed for 1080p)'}\n`);

      if (enableClipboardMonitor) {
        startClipboardMonitor();
      }

      resolve({
        app,
        server,
        port: activePort,
        url: `http://127.0.0.1:${activePort}`,
      });
    });

    server.once('error', reject);
  });
}

function stopServer() {
  cleanupClipboardMonitor();
  sseClients.forEach((res) => {
    try { res.end(); } catch (_) {}
  });
  sseClients.clear();

  if (!httpServer) return Promise.resolve();

  const server = httpServer;
  httpServer = null;
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start MIXDM server:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  stopServer,
  serverEvents,
  PORT,
  DOWNLOADS_DIR
};
