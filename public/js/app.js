/* ════════════════════════════════════════════════════
   MIXDM Frontend — app.js
   Globals, fetch patch, settings, event listeners, boot
   ════════════════════════════════════════════════════ */

// ── Auth Constants ──────────────────────────────────────────
const AUTH_TOKEN_KEY = 'mixdm-auth-token';
const AUTH_USER_NAME_KEY = 'mixdm-auth-display-name';
const AUTH_USER_ROLE_KEY = 'mixdm-auth-role';

// ── Monkey-patch fetch for auth ─────────────────────────────
const originalFetch = window.fetch;
window.fetch = function (url, options) {
  options = options || {};
  options.headers = options.headers || {};
  
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const isApi = typeof url === 'string' && url.startsWith('/api/');
  const isPublicAuth = typeof url === 'string' && (
    url.includes('/api/auth/login') ||
    url.includes('/api/auth/signup') ||
    url.includes('/api/auth/forgot-password') ||
    url.includes('/api/auth/reset-password')
  );
  
  if (token && isApi && !isPublicAuth) {
    if (options.headers instanceof Headers) {
      options.headers.set('Authorization', `Bearer ${token}`);
    } else {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
  }
  
  return originalFetch(url, options).then(response => {
    // If server returns 401 or 403, clear session and log out
    if (token && (response.status === 401 || response.status === 403) && isApi && !isPublicAuth) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_USER_NAME_KEY);
      localStorage.removeItem(AUTH_USER_ROLE_KEY);
      checkAuth();
      toast(t('toast_session_expired', 'Session expired. Please login again'), 'error');
    }
    return response;
  });
};

// ── DOM Helper ──────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Global State ────────────────────────────────────────────
const tasks = new Map();
let currentFilter = 'all';
let downloadsDir = 'downloads';
let analyzedInfo = null;
let isYtMode = false;

// ── Settings Store ──────────────────────────────────────────
const SETTINGS_KEY = 'mixdm-settings';
const SETTINGS_SCHEMA_VERSION = 3;
const PERFORMANCE_METER_INTERVALS = new Set([500, 2500, 5000]);
const DEFAULT_PERFORMANCE_METER_INTERVAL_MS = 2500;
const PERFORMANCE_METER_HISTORY_MS = 60000;
const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_SCHEMA_VERSION,
  defaultSegments: 16,
  speedLimitEnabled: false,
  speedLimitKbps: 51200,
  autoAnalyze: true,
  clearAfterStart: true,
  clipboardMonitorEnabled: true,
  clipboardNotificationsEnabled: true,
  completionSoundEnabled: true,
  showMiniHud: true,
  autoLaunchEnabled: false,
  cookiesEnabled: false,
  cookiesBrowser: 'chrome',
  theme: 'default',
  language: 'en',
  maxConcurrentDownloads: 2,
  smartRetryEnabled: true,
  smartRetryMaxAttempts: 3,
  smartRetryBaseDelayMs: 5000,
  speedMode: 'full',
  performanceMeterIntervalMs: DEFAULT_PERFORMANCE_METER_INTERVAL_MS,
  downloadsDir: ''
};
let appSettings = { ...DEFAULT_SETTINGS };
let quotaStatus = null;
let saveStatusTimer = null;

function normalizeSettings(settings) {
  const normalized = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const previousVersion = Number(settings?.settingsVersion) || 0;

  if (previousVersion < 2 && normalized.defaultSegments === 8) {
    normalized.defaultSegments = DEFAULT_SETTINGS.defaultSegments;
  }

  normalized.defaultSegments = Math.max(1, Math.min(Math.round(Number(normalized.defaultSegments) || DEFAULT_SETTINGS.defaultSegments), 32));
  normalized.performanceMeterIntervalMs = normalizePerformanceMeterInterval(normalized.performanceMeterIntervalMs);
  normalized.settingsVersion = SETTINGS_SCHEMA_VERSION;
  return normalized;
}

let notifications = [
  {
    id: 'update',
    type: 'system',
    icon: '⚡',
    titleKey: 'noti_update_title',
    descKey: 'noti_update_desc',
    time: 'Just now',
    unread: true,
    action: {
      labelKey: 'noti_action_update',
      onclick: 'triggerUpdateSim()'
    }
  },
  {
    id: 'quota',
    type: 'warning',
    icon: '⚠',
    titleKey: 'noti_quota_title',
    descKey: 'noti_quota_desc',
    time: '1 hour ago',
    unread: true,
    action: {
      labelKey: 'noti_action_upgrade',
      onclick: 'triggerUpgradeQuotaSim()'
    }
  },
  {
    id: 'welcome',
    type: 'info',
    icon: '🎉',
    title: 'Welcome to MIXDM!',
    desc: 'Segmented downloading and social video downloads are active.',
    time: '2 hours ago',
    unread: false
  }
];

window.triggerUpdateSim = function() {
  toast(t('toast_checking_updates', 'Checking for updates...'), 'info');
  setTimeout(() => {
    toast(t('s_reset_success', '✓ Already up to date! (Simulated)'), 'success');
  }, 1500);
};

window.triggerUpgradeQuotaSim = function() {
  toast(t('toast_quota_upgraded', 'Simulated: Quota upgraded successfully (Demo mode)!'), 'success');
  
  // Disable speed limit in app settings
    appSettings.speedLimitEnabled = false;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
    applySettingsToUI();
    refreshQuotaStatus();
  
  // Mark quota notification as read and remove it
  const noti = notifications.find(n => n.id === 'quota');
  if (noti) {
    noti.unread = false;
    notifications = notifications.filter(n => n.id !== 'quota');
    renderNotifications();
  }
  
  // Save settings to server
  saveSettings();
};

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      appSettings = normalizeSettings(JSON.parse(saved));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
    }
  } catch (_) {}
  applySettingsToUI();
  checkNotificationPermission();
}

function syncSettingsFromServer() {
  if (!localStorage.getItem(AUTH_TOKEN_KEY)) {
    return Promise.resolve(null);
  }
  return fetch('/api/settings')
    .then(r => {
      if (!r.ok) throw new Error('Failed to sync settings from server');
      return r.json();
    })
    .then(settings => {
      if (settings) {
        appSettings = normalizeSettings(settings);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
        applySettingsToUI();
        refreshQuotaStatus();
      }
      return settings;
    });
}

function applySettingsToUI() {
  if (appSettings.downloadsDir) {
    downloadsDir = appSettings.downloadsDir;
  }
  // Apply default segments to the main download panel
  const segSelect = $('seg-count');
  if (segSelect) {
    // Set closest matching option
    const val = String(appSettings.defaultSegments);
    const opt = segSelect.querySelector(`option[value="${val}"]`);
    if (opt) segSelect.value = val;
  }
  if (typeof applyConnectionOptionsForProfile === 'function') {
    applyConnectionOptionsForProfile(typeof currentUserProfile !== 'undefined' ? currentUserProfile : null);
  }
  const concurrentSelect = $('s-max-concurrent-downloads');
  if (concurrentSelect) {
    const val = String(appSettings.maxConcurrentDownloads || 2);
    const opt = concurrentSelect.querySelector(`option[value="${val}"]`);
    if (opt) concurrentSelect.value = val;
  }
  // Apply theme class
  const theme = appSettings.theme || 'default';
  if (theme === 'shushutan') {
    document.documentElement.classList.add('theme-shushutan');
  } else {
    document.documentElement.classList.remove('theme-shushutan');
  }
  // Apply language translation
  applyLanguage(appSettings.language || 'en');
  renderQuotaStatus();
  setSpeedModeUI(appSettings.speedMode || 'full');
  setPerformanceMeterModeUI(appSettings.performanceMeterIntervalMs);
  resizePerformanceMeterHistory();
}

function formatKbps(kbps) {
  if (!kbps || kbps <= 0) return 'Full speed';
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(kbps % 1024 === 0 ? 0 : 1)} MB/s`;
  return `${kbps} KB/s`;
}

function showSaveStatus(message, type = 'saved', timeoutMs = 2200) {
  const status = $('save-status');
  if (!status) return;
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }
  status.textContent = message;
  status.classList.toggle('unsaved', type === 'unsaved');
  status.classList.add('show');
  if (timeoutMs > 0) {
    saveStatusTimer = setTimeout(() => {
      status.classList.remove('show');
      saveStatusTimer = null;
    }, timeoutMs);
  }
}

function getConnectionLimitForProfile(profile) {
  const role = String(profile?.role || localStorage.getItem(AUTH_USER_ROLE_KEY) || 'user').toLowerCase();
  if (role === 'admin' || role === 'developer') return 32;
  const plan = String(profile?.subscription || 'free').toLowerCase();
  return plan === 'free' ? 8 : 32;
}

function applyConnectionOptionsForProfile(profile) {
  const segSelect = $('seg-count');
  if (!segSelect) return;
  const maxConnections = getConnectionLimitForProfile(profile);
  let selected = Number(segSelect.value) || appSettings.defaultSegments || 16;

  for (const option of segSelect.options) {
    const value = Number(option.value) || 1;
    option.disabled = value > maxConnections;
  }

  if (selected > maxConnections) {
    selected = maxConnections;
    segSelect.value = String(maxConnections);
  }
  segSelect.dataset.maxConnections = String(maxConnections);
  segSelect.title = maxConnections < 32
    ? `Current plan allows up to ${maxConnections} connections`
    : 'Current plan allows up to 32 connections';
}

window.applyConnectionOptionsForProfile = applyConnectionOptionsForProfile;

function resetSaveStatus() {
  const status = $('save-status');
  if (!status) return;
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }
  status.textContent = t('s_saved_success', '✓ Settings saved!');
  status.classList.remove('show', 'unsaved');
}

function markSettingsUnsaved() {
  showSaveStatus('Unsaved changes', 'unsaved', 0);
}

function setSpeedModeUI(mode) {
  const normalized = ['full', 'balanced', 'quiet'].includes(mode) ? mode : 'full';
  document.querySelectorAll('.speed-mode-btn').forEach(btn => {
    const active = btn.dataset.speedMode === normalized;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function normalizePerformanceMeterInterval(value) {
  const interval = Math.round(Number(value) || DEFAULT_PERFORMANCE_METER_INTERVAL_MS);
  return PERFORMANCE_METER_INTERVALS.has(interval) ? interval : DEFAULT_PERFORMANCE_METER_INTERVAL_MS;
}

function setPerformanceMeterModeUI(value) {
  const normalized = normalizePerformanceMeterInterval(value);
  document.querySelectorAll('.meter-refresh-btn').forEach(btn => {
    const active = parseInt(btn.dataset.meterRefreshMs || '0', 10) === normalized;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function getSpeedLimitValue() {
  const value = parseInt($('s-speed-limit-value')?.value, 10) || 51200;
  return Math.max(128, Math.min(value, 1048576));
}

function updateSpeedPresetUI() {
  const enabled = !!$('s-speed-limit-enabled')?.checked;
  const value = getSpeedLimitValue();
  document.querySelectorAll('.speed-preset-btn').forEach(btn => {
    const presetValue = parseInt(btn.dataset.speedKbps || '0', 10);
    const active = enabled ? presetValue > 0 && presetValue === value : presetValue === 0;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncSpeedLimiterUI({ markDirty = false } = {}) {
  const speedInput = $('s-speed-limit-value');
  const enabled = !!$('s-speed-limit-enabled')?.checked;
  if (speedInput) speedInput.disabled = !enabled;
  updateSpeedPresetUI();
  if (markDirty) markSettingsUnsaved();
}

function renderQuotaStatus() {
  const planEl = $('s-quota-plan');
  const descEl = $('s-quota-desc');
  const remainingEl = $('s-quota-remaining');
  const limitEl = $('s-quota-limit');
  const fillEl = $('s-quota-fill');
  if (!planEl || !descEl || !remainingEl || !limitEl || !fillEl) return;

  if (!quotaStatus) {
    planEl.textContent = 'Free';
    descEl.textContent = 'High-speed quota is checked after login.';
    remainingEl.textContent = '-';
    limitEl.textContent = '5 MB/s after quota';
    fillEl.classList.remove('quota-meter-fill-warn', 'quota-meter-fill-danger', 'quota-meter-fill-empty');
    fillEl.style.width = '0%';
    return;
  }

  planEl.textContent = quotaStatus.label || quotaStatus.plan || 'Free';
  const fallbackText = quotaStatus.fallbackLimitKbps > 0
    ? `${formatKbps(quotaStatus.fallbackLimitKbps)} after quota`
    : 'No fallback limit';
  limitEl.textContent = fallbackText;

  if (quotaStatus.unlimited) {
    descEl.textContent = 'Unlimited high-speed downloads for this plan.';
    remainingEl.textContent = 'Unlimited';
    fillEl.classList.remove('quota-meter-fill-warn', 'quota-meter-fill-danger', 'quota-meter-fill-empty');
    fillEl.style.width = '100%';
    return;
  }

  const used = quotaStatus.used || 0;
  const total = quotaStatus.dailyQuota || 0;
  const remaining = quotaStatus.remaining || 0;
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  descEl.textContent = `${remaining} full-speed downloads left today (${used}/${total} used).`;
  remainingEl.textContent = `${remaining}/${total} left`;
  fillEl.classList.toggle('quota-meter-fill-warn', pct > 20 && pct <= 40);
  fillEl.classList.toggle('quota-meter-fill-danger', pct > 0 && pct <= 20);
  fillEl.classList.toggle('quota-meter-fill-empty', pct <= 0);
  fillEl.style.width = pct + '%';
}

async function refreshQuotaStatus() {
  try {
    const res = await fetch('/api/quota/status');
    if (!res.ok) return;
    quotaStatus = await res.json();
    renderQuotaStatus();
  } catch (_) {}
}

function checkNotificationPermission() {
  if (appSettings.clipboardNotificationsEnabled && typeof Notification !== 'undefined') {
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        console.log('[Notification] Permission:', permission);
      });
    }
  }
}

async function saveSettings() {
  appSettings.defaultSegments = parseInt($('s-default-segments').value, 10);
  appSettings.maxConcurrentDownloads = parseInt($('s-max-concurrent-downloads').value, 10) || 2;
  appSettings.smartRetryEnabled = $('s-smart-retry-enabled').checked;
  appSettings.smartRetryMaxAttempts = parseInt($('s-smart-retry-attempts').value, 10) || 0;
  const activeSpeedMode = document.querySelector('.speed-mode-btn.active');
  appSettings.speedMode = activeSpeedMode?.dataset.speedMode || appSettings.speedMode || 'full';
  const activeMeterRefresh = document.querySelector('.meter-refresh-btn.active');
  appSettings.performanceMeterIntervalMs = normalizePerformanceMeterInterval(activeMeterRefresh?.dataset.meterRefreshMs);
  appSettings.speedLimitEnabled = $('s-speed-limit-enabled').checked;
  let speedVal = parseInt($('s-speed-limit-value').value, 10) || 51200;
  if (speedVal > 1048576) speedVal = 1048576;
  if (speedVal < 128) speedVal = 128;
  appSettings.speedLimitKbps = speedVal;
  appSettings.autoAnalyze = $('s-auto-analyze').checked;
  appSettings.clearAfterStart = $('s-clear-after-start').checked;
  appSettings.clipboardMonitorEnabled = $('s-clipboard-monitor').checked;
  appSettings.clipboardNotificationsEnabled = $('s-clipboard-notifications').checked;
  appSettings.completionSoundEnabled = $('s-completion-sound').checked;
  appSettings.showMiniHud = $('s-show-mini-hud').checked;
  appSettings.autoLaunchEnabled = $('s-auto-launch').checked;
  
  appSettings.cookiesEnabled = $('s-cookies-enabled').checked;
  appSettings.cookiesBrowser = $('s-cookies-browser').value;
  appSettings.theme = $('s-theme').value;
  appSettings.language = $('s-language').value;
  appSettings.downloadsDir = $('s-downloads-dir').textContent;

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  applySettingsToUI();
  checkNotificationPermission();

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cookiesEnabled: appSettings.cookiesEnabled,
        cookiesBrowser: appSettings.cookiesBrowser,
        theme: appSettings.theme,
        language: appSettings.language,
        autoLaunchEnabled: appSettings.autoLaunchEnabled,
        downloadsDir: appSettings.downloadsDir,
        defaultSegments: appSettings.defaultSegments,
        maxConcurrentDownloads: appSettings.maxConcurrentDownloads,
        smartRetryEnabled: appSettings.smartRetryEnabled,
        smartRetryMaxAttempts: appSettings.smartRetryMaxAttempts,
        smartRetryBaseDelayMs: appSettings.smartRetryBaseDelayMs,
        speedMode: appSettings.speedMode,
        performanceMeterIntervalMs: appSettings.performanceMeterIntervalMs,
        speedLimitEnabled: appSettings.speedLimitEnabled,
        speedLimitKbps: appSettings.speedLimitKbps,
        autoAnalyze: appSettings.autoAnalyze,
        clearAfterStart: appSettings.clearAfterStart,
        clipboardMonitorEnabled: appSettings.clipboardMonitorEnabled,
        clipboardNotificationsEnabled: appSettings.clipboardNotificationsEnabled,
        completionSoundEnabled: appSettings.completionSoundEnabled,
        showMiniHud: appSettings.showMiniHud
      })
    });
    if (!res.ok) throw new Error('Failed to save settings to server');
  } catch (err) {
    console.error(err);
    toast(t('toast_settings_failed', 'Error saving settings: ') + err.message, 'error');
  }

  showSaveStatus(t('s_saved_success', '✓ Settings saved!'), 'saved', 2200);
}

function openSettingsPanel() {
  // Populate settings panel with current values
  $('s-default-segments').value = String(appSettings.defaultSegments);
  $('s-max-concurrent-downloads').value = String(appSettings.maxConcurrentDownloads || 2);
  $('s-smart-retry-enabled').checked = appSettings.smartRetryEnabled !== false;
  $('s-smart-retry-attempts').value = String(appSettings.smartRetryMaxAttempts ?? 3);
  setSpeedModeUI(appSettings.speedMode || 'full');
  setPerformanceMeterModeUI(appSettings.performanceMeterIntervalMs);
  $('s-speed-limit-enabled').checked = appSettings.speedLimitEnabled;
  $('s-speed-limit-value').value = appSettings.speedLimitKbps;
  syncSpeedLimiterUI();
  $('s-auto-analyze').checked = appSettings.autoAnalyze;
  $('s-clear-after-start').checked = appSettings.clearAfterStart;
  $('s-clipboard-monitor').checked = appSettings.clipboardMonitorEnabled;
  $('s-clipboard-notifications').checked = appSettings.clipboardNotificationsEnabled;
  $('s-completion-sound').checked = appSettings.completionSoundEnabled !== false;
  $('s-show-mini-hud').checked = appSettings.showMiniHud !== false;
  $('s-auto-launch').checked = appSettings.autoLaunchEnabled === true;
  
  $('s-cookies-enabled').checked = appSettings.cookiesEnabled;
  $('s-cookies-browser').value = appSettings.cookiesBrowser;
  $('s-cookies-browser').disabled = !appSettings.cookiesEnabled;
  $('s-theme').value = appSettings.theme || 'default';
  $('s-language').value = appSettings.language || 'en';

  $('s-downloads-dir').textContent = appSettings.downloadsDir || downloadsDir || 'Loading...';
  resetSaveStatus();
  refreshQuotaStatus();
  $('settings-panel').classList.add('open');
  $('settings-overlay').classList.add('open');
}

function resetSettingsToDefault() {
  const confirmMsg = t('toast_clear_reports_confirm', 'Are you sure?') === 'Are you sure?'
    ? 'Are you sure you want to reset settings to default?'
    : t('toast_clear_reports_confirm', 'คุณแน่ใจหรือไม่ว่าต้องการล้างรายงานทั้งหมด?');
  if (confirm(confirmMsg)) {
    appSettings = normalizeSettings(DEFAULT_SETTINGS);
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => {
        if (cfg.downloadsDir) {
          appSettings.downloadsDir = cfg.downloadsDir;
        }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
        applySettingsToUI();
        openSettingsPanel();
        saveSettings();
        toast(t('s_reset_success', '✓ Settings reset to defaults!'), 'success');
      });
  }
}

function closeSettingsPanel() {
  $('settings-panel').classList.remove('open');
  $('settings-overlay').classList.remove('open');
  resetSaveStatus();
}

// ── Utilities ─────────────────────────────────────────────
function fmtBytes(b) {
  if (!b || b <= 0) return '—';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)}\u00A0${u[i]}`;
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '0\u00A0KB/s';
  return fmtBytes(bps) + '/s';
}
function fmtETA(s) {
  if (!s || s <= 0) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m\u00A0${s%60}s`;
  return `${Math.floor(s/3600)}h\u00A0${Math.floor((s%3600)/60)}m`;
}
function isCurrentTask(task) {
  return ['queued', 'retrying', 'starting', 'analyzing', 'downloading', 'merging', 'extracting', 'paused', 'pausing', 'resuming'].includes(task.status);
}
function isFinishedTask(task) {
  return ['done', 'error', 'cancelled'].includes(task.status);
}
function getTaskDownloaded(task) {
  if (task.fileSize > 0 && task.type === 'ytdlp') {
    return Math.round(task.fileSize * ((task.progress || 0) / 100));
  }
  return task.totalDownloaded || 0;
}
function getTaskSpeedText(task) {
  if (task.type === 'ytdlp' && task.speedStr) return task.speedStr;
  if (task.speed > 0) return fmtSpeed(task.speed);
  return '-';
}
function getTaskEtaText(task) {
  if (task.type === 'ytdlp' && task.etaStr && task.etaStr !== 'Unknown') return task.etaStr;
  if (task.eta) return fmtETA(task.eta);
  return '-';
}
function fmtDuration(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function fileIcon(filename, contentType = '', isYt = false) {
  if (isYt) return '🎬';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    zip:'🗜️', rar:'🗜️', '7z':'🗜️', gz:'🗜️',
    mp4:'🎬', mkv:'🎬', avi:'🎬', mov:'🎬', webm:'🎬',
    mp3:'🎵', flac:'🎵', wav:'🎵', aac:'🎵', m4a:'🎵',
    jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️',
    pdf:'📄', doc:'📄', docx:'📄', xlsx:'📊',
    exe:'⚙️', msi:'⚙️', apk:'📱', iso:'💿'
  };
  return map[ext] || '📦';
}
function iconBg(status, isYt = false) {
  if (status === 'done') return 'background: var(--success-bg)';
  if (status === 'error') return 'background: var(--danger-bg)';
  if (isYt) return 'background: var(--yt-red-bg)';
  return 'background: rgba(79,156,249,0.1)';
}
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-area').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Dashboard Chart & File Info ─────────────────────────────
let performanceMeter = null;
let chartDataPoints = Array(Math.round(PERFORMANCE_METER_HISTORY_MS / DEFAULT_PERFORMANCE_METER_INTERVAL_MS)).fill(0);
let lastChartUpdateAt = 0;
let chartSmoothedSpeed = 0;
const CHART_SPEED_SMOOTHING_ALPHA = 0.35;
const GAUGE_MIN_DEG = -128;
const GAUGE_MAX_DEG = 128;
const GAUGE_MAX_MB_PER_SEC = 500;

function getPerformanceMeterIntervalMs() {
  return normalizePerformanceMeterInterval(appSettings.performanceMeterIntervalMs);
}

function getPerformanceMeterPointCount() {
  const interval = getPerformanceMeterIntervalMs();
  return Math.max(12, Math.min(120, Math.round(PERFORMANCE_METER_HISTORY_MS / interval)));
}

function resizePerformanceMeterHistory() {
  if (!Array.isArray(chartDataPoints)) return;
  const targetLength = getPerformanceMeterPointCount();
  if (chartDataPoints.length === targetLength) return;

  if (chartDataPoints.length > targetLength) {
    chartDataPoints = chartDataPoints.slice(chartDataPoints.length - targetLength);
  } else {
    chartDataPoints = Array(targetLength - chartDataPoints.length).fill(0).concat(chartDataPoints);
  }
}

function initChart() {
  performanceMeter = {
    needle: $('speedGaugeNeedle'),
    fill: $('speedGaugeFill'),
    value: $('speedGaugeValue'),
    average: $('speedAverageValue'),
    peak: $('speedPeakValue'),
    stability: $('speedStabilityValue'),
    trend: $('speedTrendValue'),
    sparklineLine: $('speedSparklineLine'),
    sparklineFill: $('speedSparklineFill')
  };

  if (!performanceMeter.needle || !performanceMeter.value || !performanceMeter.sparklineLine) {
    performanceMeter = null;
    return;
  }

  renderPerformanceMeter(0);
}

function speedToGaugeRatio(speed) {
  const mbPerSec = Math.max(0, Number(speed) || 0) / (1024 * 1024);
  if (mbPerSec <= 0) return 0;
  return Math.min(1, Math.log10(mbPerSec + 1) / Math.log10(GAUGE_MAX_MB_PER_SEC + 1));
}

function getSpeedAverage(values) {
  const activeValues = values.filter(value => value > 0);
  if (activeValues.length === 0) return 0;
  return activeValues.reduce((sum, value) => sum + value, 0) / activeValues.length;
}

function getSpeedStability(values, average) {
  if (average <= 0) return 'Idle';
  const activeValues = values.filter(value => value > 0);
  if (activeValues.length < 4) return 'Warming up';

  const variance = activeValues.reduce((sum, value) => {
    const delta = value - average;
    return sum + (delta * delta);
  }, 0) / activeValues.length;
  const coefficient = Math.sqrt(variance) / average;

  if (coefficient < 0.18) return 'Stable';
  if (coefficient < 0.45) return 'Variable';
  return 'Bursty';
}

function buildSparkline(values) {
  const width = 320;
  const height = 92;
  const padding = 6;
  const maxValue = Math.max(...values, 1024 * 1024);
  const usableHeight = height - (padding * 2);
  const lastIndex = Math.max(values.length - 1, 1);

  const points = values.map((value, index) => {
    const x = (index / lastIndex) * width;
    const y = height - padding - ((Math.max(0, value) / maxValue) * usableHeight);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return {
    line: points,
    fill: `0,${height} ${points} ${width},${height}`
  };
}

function getSpeedTrend(values) {
  const activeValues = values.filter(value => value > 0);
  if (activeValues.length === 0) return 'No traffic';
  const latest = activeValues[activeValues.length - 1];
  const previous = activeValues[Math.max(activeValues.length - 4, 0)];
  const delta = latest - previous;
  const threshold = Math.max(previous * 0.12, 128 * 1024);
  if (Math.abs(delta) < threshold) return 'Steady';
  return delta > 0 ? 'Rising' : 'Falling';
}

function renderPerformanceMeter(speed) {
  if (!performanceMeter) return;

  const ratio = speedToGaugeRatio(speed);
  const degrees = GAUGE_MIN_DEG + ((GAUGE_MAX_DEG - GAUGE_MIN_DEG) * ratio);
  const average = getSpeedAverage(chartDataPoints);
  const peak = Math.max(...chartDataPoints);
  const sparkline = buildSparkline(chartDataPoints);

  performanceMeter.needle.style.transform = `translate(-50%, -100%) rotate(${degrees.toFixed(1)}deg)`;
  if (performanceMeter.fill) {
    performanceMeter.fill.style.strokeDasharray = `${(ratio * 100).toFixed(1)} 100`;
  }
  performanceMeter.value.textContent = fmtSpeed(speed);
  if (performanceMeter.average) performanceMeter.average.textContent = fmtSpeed(average);
  if (performanceMeter.peak) performanceMeter.peak.textContent = fmtSpeed(peak);
  if (performanceMeter.stability) performanceMeter.stability.textContent = getSpeedStability(chartDataPoints, average);
  if (performanceMeter.trend) performanceMeter.trend.textContent = getSpeedTrend(chartDataPoints);
  performanceMeter.sparklineLine.setAttribute('points', sparkline.line);
  if (performanceMeter.sparklineFill) {
    performanceMeter.sparklineFill.setAttribute('points', sparkline.fill);
  }
}

function updateChart(totalSpeed) {
  if (!performanceMeter) return;
  if (document.hidden) return;

  const timestamp = Date.now();
  const interval = getPerformanceMeterIntervalMs();
  if (timestamp - lastChartUpdateAt < interval) return;
  lastChartUpdateAt = timestamp;
  resizePerformanceMeterHistory();

  const rawSpeed = Math.max(0, Number(totalSpeed) || 0);
  chartSmoothedSpeed = rawSpeed <= 0
    ? 0
    : chartSmoothedSpeed <= 0
      ? rawSpeed
      : Math.round((CHART_SPEED_SMOOTHING_ALPHA * rawSpeed) + ((1 - CHART_SPEED_SMOOTHING_ALPHA) * chartSmoothedSpeed));

  chartDataPoints.push(chartSmoothedSpeed);
  chartDataPoints.shift();
  renderPerformanceMeter(chartSmoothedSpeed);
}

function updateFileInfoCard(currentTasks) {
  const card = $('dashboard-file-info');
  const iconEl = card ? card.querySelector('.file-icon-large') : null;
  const titleEl = $('dash-file-name');
  const sizeEl = $('dash-file-size');
  const progressBar = $('dash-progress-bar');
  const progressText = $('dash-progress-text');
  const etaText = $('dash-eta-text');
  const actionControls = $('dash-action-controls');

  if (!card || !iconEl || !titleEl || !sizeEl || !progressBar || !progressText || !etaText || !actionControls) return;

  card.classList.toggle('has-active-download', currentTasks.length > 0);

  if (currentTasks.length === 0) {
    iconEl.textContent = '📄';
    iconEl.style.backgroundImage = '';
    iconEl.classList.remove('has-thumbnail');
    titleEl.textContent = 'No active downloads';
    titleEl.title = '';
    sizeEl.textContent = '-';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    etaText.textContent = 'ETA: -';
    if (actionControls.dataset.key !== 'empty') {
      actionControls.innerHTML = '';
      actionControls.dataset.key = 'empty';
    }
    return;
  }

  const task = currentTasks[0];
  const pct = Math.max(0, Math.min(100, task.progress || 0));
  const isYt = task.type === 'ytdlp';
  const downloaded = getTaskDownloaded(task);
  const title = task.title || task.filename || t('status_' + task.status, 'Downloading...');
  const sizeText = task.fileSize > 0
    ? `${fmtBytes(downloaded)} / ${fmtBytes(task.fileSize)}`
    : downloaded > 0 ? `${fmtBytes(downloaded)} ${t('downloaded_label', 'downloaded')}` : t('size_unknown', 'Size unknown');
  const statusText = task.status === 'retrying'
    ? `Retrying ${task.retryAttempt || 1}/${task.retryMaxAttempts || appSettings.smartRetryMaxAttempts || 3}`
    : task.status === 'queued' && task.queuePosition
    ? `Queued #${task.queuePosition}`
    : t('status_' + task.status, task.status || 'Downloading');
  const speedText = getTaskSpeedText(task);
  const eta = getTaskEtaText(task);

  if (isYt && task.thumbnail) {
    iconEl.textContent = '';
    iconEl.style.backgroundImage = `url("${task.thumbnail}")`;
    iconEl.classList.add('has-thumbnail');
  } else {
    iconEl.textContent = fileIcon(task.filename || '', task.contentType, isYt);
    iconEl.style.backgroundImage = '';
    iconEl.classList.remove('has-thumbnail');
  }

  titleEl.textContent = title;
  titleEl.title = title;
  sizeEl.textContent = `${statusText} · ${sizeText} · ${speedText}`;
  progressBar.style.width = pct + '%';
  progressText.textContent = pct.toFixed(1) + '%';
  etaText.textContent = task.status === 'retrying'
    ? `Retrying soon`
    : task.status === 'queued'
    ? 'Waiting for an open slot'
    : `ETA: ${eta}`;

  const pending = !!task.pendingAction;
  const canPause = ['analyzing', 'downloading', 'merging', 'extracting'].includes(task.status);
  const canResume = task.status === 'paused';
  const pendingLabel = task.pendingAction
    ? t(task.pendingAction === 'resume' ? 'resuming' : 'stopping', task.pendingAction === 'resume' ? 'Resuming...' : 'Stopping...')
    : '';

  const actionKey = `${task.id}|${task.status}|${task.pendingAction || ''}|${isYt ? 'yt' : 'http'}`;
  if (actionControls.dataset.key !== actionKey) {
    actionControls.innerHTML = `
      ${canPause ? `<button class="file-info-action-btn" id="dash-btn-pause" ${pending ? 'disabled' : ''}>Pause</button>` : ''}
      ${canResume ? `<button class="file-info-action-btn primary" id="dash-btn-resume" ${pending ? 'disabled' : ''}>Resume</button>` : ''}
      <button class="file-info-action-btn danger" id="dash-btn-cancel" ${pending ? 'disabled' : ''}>Cancel</button>
      ${pendingLabel ? `<span class="file-info-action-status">${pendingLabel}</span>` : ''}
    `;
    actionControls.dataset.key = actionKey;

    const pauseBtn = $('dash-btn-pause');
    const resumeBtn = $('dash-btn-resume');
    const cancelBtn = $('dash-btn-cancel');

    if (pauseBtn) {
      pauseBtn.onclick = () => isYt ? pauseYtTask(task.id) : pauseTask(task.id);
    }
    if (resumeBtn) {
      resumeBtn.onclick = () => isYt ? resumeYtTask(task.id) : resumeTask(task.id);
    }
    if (cancelBtn) {
      cancelBtn.onclick = () => removeTask(task.id, isYt);
    }
  }
}

// ── Stats Bar ─────────────────────────────────────────────
function updateStats() {
  const all = [...tasks.values()];
  const active = all.filter(isCurrentTask);
  const done = all.filter(t => t.status === 'done').length;
  const totalSpeed = active.reduce((s, t) => s + (t.speed || 0), 0);
  
  // Update legacy stats if they exist
  const statActive = $('stat-active');
  const statDone = $('stat-done');
  const statSpeed = $('stat-speed');
  if (statActive) statActive.textContent = active.length;
  if (statDone) statDone.textContent = done;
  if (statSpeed) statSpeed.textContent = fmtSpeed(totalSpeed);
  
  // Update Dashboard components
  updateChart(totalSpeed);
  updateFileInfoCard(active);
}

// ── Boot ─────────────────────────────────────────────────────
function handleLaunchParams() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  if (!url) return;

  $('url-input').value = url;
  $('url-input').dispatchEvent(new Event('input'));

  const action = params.get('action') || 'analyze';
  window.history.replaceState({}, document.title, window.location.pathname);

  if (action === 'download') {
    startDownload();
  } else {
    analyzeUrl();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // Detect if running inside Electron and configure custom titlebar controls
  if (window.electronAPI) {
    document.body.classList.add('is-electron');
    
    const btnMin = document.getElementById('titlebar-minimize');
    const btnMax = document.getElementById('titlebar-maximize');
    const btnClose = document.getElementById('titlebar-close');
    
    if (btnMin) btnMin.addEventListener('click', () => window.electronAPI.minimize());
    if (btnMax) btnMax.addEventListener('click', () => window.electronAPI.maximize());
    if (btnClose) btnClose.addEventListener('click', () => window.electronAPI.close());
  }

  // Sync configuration from server
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      downloadsDir = cfg.downloadsDir || downloadsDir;
      if ($('s-app-version') && cfg.version) {
        $('s-app-version').textContent = `v${cfg.version}`;
      }
      if (cfg.ytdlpInstalled === false) {
        $('ytdlp-banner').classList.add('show');
      }
      if (cfg.cookiesEnabled !== undefined) {
        appSettings.cookiesEnabled = cfg.cookiesEnabled;
        appSettings.cookiesBrowser = cfg.cookiesBrowser || 'chrome';
      }
      if (cfg.autoLaunchEnabled !== undefined) {
        appSettings.autoLaunchEnabled = cfg.autoLaunchEnabled;
      }
      // Update settings panel status indicators
      const ytStatus = $('s-ytdlp-status');
      const ffStatus = $('s-ffmpeg-status');
      if (ytStatus) ytStatus.innerHTML = cfg.ytdlpInstalled
        ? '<span style="color:var(--success)">✓ yt-dlp installed</span>'
        : '<span style="color:var(--danger)">✗ yt-dlp not found — YouTube downloads disabled</span>';
      if (ffStatus) ffStatus.innerHTML = cfg.ffmpegInstalled
        ? '<span style="color:var(--success)">✓ ffmpeg installed</span>'
        : '<span style="color:var(--warn)">⚠ ffmpeg not found — 1080p merge disabled</span>';
      // Sync dir display if panel is open
      if ($('s-downloads-dir')) $('s-downloads-dir').textContent = downloadsDir;
    })
    .catch(err => console.error('Failed to sync config from server:', err));

  // Sync settings from server
  syncSettingsFromServer()
    .catch(err => console.error('Failed to sync settings from server:', err));

  // ── Event Listeners ─────────────────────────────────────────
  $('btn-analyze').addEventListener('click', analyzeUrl);
  $('btn-download').addEventListener('click', startDownload);
  $('toggle-advanced-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const fields = $('advanced-fields');
    const isHidden = fields.style.display === 'none';
    fields.style.display = isHidden ? 'grid' : 'none';
    $('toggle-advanced-btn').style.color = isHidden ? 'var(--accent)' : 'var(--text-secondary)';
  });
  $('url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (analyzedInfo) startDownload();
      else analyzeUrl();
    }
  });
  $('url-input').addEventListener('input', () => {
    const url = $('url-input').value.trim();
    $('btn-download').disabled = true;
    $('file-info-badge').className = 'info-badge';
    $('video-preview').classList.remove('show');
    analyzedInfo = null;

    // Auto-detect URL type for visual hint
    if (url && looksLikeYt(url)) {
      setYtMode(true);
    } else {
      setYtMode(false);
    }

    // Auto-analyze if setting enabled
    if (url && appSettings.autoAnalyze) {
      clearTimeout($('url-input')._analyzeTimer);
      $('url-input')._analyzeTimer = setTimeout(() => {
        if ($('url-input').value.trim() === url && !analyzedInfo) analyzeUrl();
      }, 900);
    }
  });

  $('url-input').addEventListener('paste', () => {
    if (!appSettings.autoAnalyze) return;
    // Slight delay to let paste fill the input
    setTimeout(() => {
      const url = $('url-input').value.trim();
      if (url && !analyzedInfo) analyzeUrl();
    }, 80);
  });

  $('format-select').addEventListener('change', () => {
    if (!analyzedInfo || !analyzedInfo.formats) return;
    const val = $('format-select').value;
    const fmt = analyzedInfo.formats.find(f => f.value === val);
    if (fmt) {
      const badge = $('file-info-badge');
      badge.className = 'info-badge show yt';
      const sizeStr = fmt.size > 0 ? ` · ${fmtBytes(fmt.size)}` : '';
      badge.textContent = `✓ ${analyzedInfo.platform || 'Video'} · ${fmtDuration(analyzedInfo.duration)}${sizeStr}`;
    }
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      filterTasks();
    });
  });

  // Files Sidebar Icon Events
  const filesSidebarBtn = $('sidebar-btn-files');
  if (filesSidebarBtn) {
    filesSidebarBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof openFilesExplorerModal === 'function') {
        openFilesExplorerModal();
      }
    });
  }

  // Pricing Sidebar Icon → Opens Pricing modal
  const pricingSidebarBtn = $('sidebar-btn-pricing');
  if (pricingSidebarBtn) {
    pricingSidebarBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof openPricingModal === 'function') {
        openPricingModal();
      }
    });
  }

  // Settings Panel Events
  const settingsBtn = $('sidebar-btn-settings') || $('btn-open-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openSettingsPanel();
    });
  }
  $('btn-close-settings').addEventListener('click', closeSettingsPanel);
  $('settings-overlay').addEventListener('click', closeSettingsPanel);
  $('btn-save-settings').addEventListener('click', saveSettings);

  // Speed limit toggle
  $('s-speed-limit-enabled').addEventListener('change', () => {
    syncSpeedLimiterUI({ markDirty: true });
  });

  $('s-speed-limit-value').addEventListener('input', () => {
    updateSpeedPresetUI();
    markSettingsUnsaved();
  });

  $('s-speed-limit-value').addEventListener('change', () => {
    $('s-speed-limit-value').value = String(getSpeedLimitValue());
    syncSpeedLimiterUI({ markDirty: true });
  });

  document.querySelectorAll('.speed-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kbps = parseInt(btn.dataset.speedKbps || '0', 10);
      if (kbps <= 0) {
        $('s-speed-limit-enabled').checked = false;
      } else {
        $('s-speed-limit-enabled').checked = true;
        $('s-speed-limit-value').value = kbps;
      }
      syncSpeedLimiterUI({ markDirty: true });
    });
  });

  document.querySelectorAll('.speed-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setSpeedModeUI(btn.dataset.speedMode || 'full');
      markSettingsUnsaved();
    });
  });

  document.querySelectorAll('.meter-refresh-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPerformanceMeterModeUI(btn.dataset.meterRefreshMs || DEFAULT_PERFORMANCE_METER_INTERVAL_MS);
      markSettingsUnsaved();
    });
  });

  // Browser cookies toggle
  $('s-cookies-enabled').addEventListener('change', () => {
    $('s-cookies-browser').disabled = !$('s-cookies-enabled').checked;
  });

  // Open downloads folder from settings
  $('s-open-folder-btn').addEventListener('click', () => openFolder(''));

  // Native folder browser (Electron) or custom manual edit (Web)
  if (window.electronAPI) {
    const browseBtn = $('s-browse-folder-btn');
    if (browseBtn) {
      browseBtn.style.display = 'inline-block';
      browseBtn.addEventListener('click', async () => {
        const path = await window.electronAPI.selectDirectory();
        if (path) {
          $('s-downloads-dir').textContent = path;
        }
      });
    }
  } else {
    // Non-electron Web mode: Allow typing manually
    const dirWrap = $('s-dir-wrap-container');
    const dirSpan = $('s-downloads-dir');
    const dirInput = $('s-downloads-dir-input');
    
    if (dirWrap && dirSpan && dirInput) {
      dirWrap.addEventListener('click', (e) => {
        if (dirInput.style.display === 'none') {
          dirInput.value = dirSpan.textContent;
          dirSpan.style.display = 'none';
          dirInput.style.display = 'inline-block';
          dirInput.focus();
        }
      });
      
      const finishEditing = () => {
        if (dirInput.style.display !== 'none') {
          const newPath = dirInput.value.trim();
          if (newPath) {
            dirSpan.textContent = newPath;
          }
          dirInput.style.display = 'none';
          dirSpan.style.display = 'inline-block';
        }
      };
      
      dirInput.addEventListener('blur', finishEditing);
      dirInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          finishEditing();
        } else if (e.key === 'Escape') {
          dirInput.style.display = 'none';
          dirSpan.style.display = 'inline-block';
        }
      });
    }
  }

  // Test Chime Sound
  const testChimeBtn = $('btn-test-chime');
  if (testChimeBtn) {
    testChimeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof playCompletionSound === 'function') {
        playCompletionSound();
      }
    });
  }

  // Reset to defaults
  const resetBtn = $('btn-reset-settings');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.preventDefault();
      resetSettingsToDefault();
    });
  }

  // Keyboard close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('settings-panel').classList.contains('open')) {
      closeSettingsPanel();
    }
  });

  // Clipboard Toast Events
  $('clip-toast-close').addEventListener('click', hideClipToast);
  $('clip-toast-btn-dismiss').addEventListener('click', hideClipToast);
  $('clip-toast-btn-analyze').addEventListener('click', () => {
    const url = $('clip-toast-url').textContent;
    hideClipToast();
    $('url-input').value = url;
    analyzeUrl();
  });
  $('clip-toast').addEventListener('mouseenter', () => {
    clipToastIsHovered = true;
  });
  $('clip-toast').addEventListener('mouseleave', () => {
    clipToastIsHovered = false;
  });

  loadSettings();
  checkAuth();
  handleLaunchParams();
  initChart();
  
  // Initialize and render notifications popover
  initNotificationsUI();
});

function initNotificationsUI() {
  const notiBtn = $('btn-notifications');
  const notiDropdown = $('notifications-dropdown');
  
  if (notiBtn && notiDropdown) {
    notiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      notiDropdown.classList.toggle('show');
    });
    
    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!notiDropdown.contains(e.target) && e.target !== notiBtn) {
        notiDropdown.classList.remove('show');
      }
    });
  }
  
  // Mark all as read
  const markReadBtn = $('btn-noti-mark-read');
  if (markReadBtn) {
    markReadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      notifications.forEach(n => n.unread = false);
      renderNotifications();
    });
  }
  
  // Clear all notifications
  const clearAllNotiBtn = $('btn-clear-all-noti');
  if (clearAllNotiBtn) {
    clearAllNotiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      notifications = [];
      renderNotifications();
    });
  }
  
  renderNotifications();
}

function renderNotifications() {
  const listEl = $('notifications-list');
  const dotEl = $('noti-dot');
  if (!listEl) return;
  
  listEl.innerHTML = '';
  
  const unreadCount = notifications.filter(n => n.unread).length;
  if (dotEl) {
    dotEl.classList.toggle('show', unreadCount > 0);
  }
  
  if (notifications.length === 0) {
    listEl.innerHTML = `
      <div class="notifications-empty">
        <div class="notifications-empty-icon">🔔</div>
        <div class="notifications-empty-text" data-i18n="noti_empty">No new notifications</div>
      </div>
    `;
    applyLanguage(appSettings.language || 'en');
    return;
  }
  
  notifications.forEach(n => {
    const item = document.createElement('div');
    item.className = `notification-item ${n.unread ? 'unread' : ''}`;
    item.dataset.id = n.id;
    
    const title = n.titleKey ? t(n.titleKey, n.title) : n.title;
    const desc = n.descKey ? t(n.descKey, n.desc) : n.desc;
    
    let actionBtnHtml = '';
    if (n.action) {
      const actionLabel = n.action.labelKey ? t(n.action.labelKey, n.action.label) : n.action.label;
      actionBtnHtml = `<button class="notification-action-btn" onclick="${n.action.onclick}">${actionLabel}</button>`;
    }
    
    item.innerHTML = `
      <div class="notification-icon-wrap ${n.type}">
        <span>${n.icon}</span>
      </div>
      <div class="notification-content">
        <span class="notification-item-title">${title}</span>
        <span class="notification-item-desc">${desc}</span>
        ${actionBtnHtml}
        <span class="notification-item-time">${n.time}</span>
      </div>
      <button class="btn-remove-noti" title="Remove">&times;</button>
    `;
    
    // Mark as read on click
    item.addEventListener('click', (e) => {
      if (e.target.closest('.notification-action-btn') || e.target.closest('.btn-remove-noti')) return;
      if (n.unread) {
        n.unread = false;
        renderNotifications();
      }
    });
    
    // Delete item
    item.querySelector('.btn-remove-noti').addEventListener('click', (e) => {
      e.stopPropagation();
      notifications = notifications.filter(item => item.id !== n.id);
      renderNotifications();
    });
    
    listEl.appendChild(item);
  });
}

// ── Report Modal ───────────────────────────────────────────────
(function initReportModal() {
  const overlay    = $('report-modal-overlay');
  const formArea   = $('report-form-area');
  const successEl  = $('report-success');
  const btnOpen    = $('btn-open-report');
  const btnFeedback = $('sidebar-btn-feedback');
  const btnCancel  = $('report-btn-cancel');
  const btnSubmit  = $('report-btn-submit');
  const btnClose   = $('report-success-close');
  const spinner    = $('report-spinner');
  const tabs       = document.querySelectorAll('.report-type-tab');
  let currentType  = 'bug';

  function openModal() {
    overlay.classList.add('show');
    overlay.classList.remove('active');
    document.body.classList.add('modal-open');
    resetForm();
    // Auto-populate from logged-in user profile if available
    if (typeof currentUserProfile !== 'undefined' && currentUserProfile) {
      if ($('report-sender-name')) $('report-sender-name').value = currentUserProfile.displayName || '';
      if ($('report-sender-email')) $('report-sender-email').value = currentUserProfile.email || '';
    }
  }

  function closeModal() {
    overlay.classList.remove('show', 'active');
    document.body.classList.remove('modal-open');
  }

  function resetForm() {
    currentType = 'bug';
    // Reset tabs
    tabs.forEach(t => t.classList.toggle('active', t.dataset.type === 'bug'));
    // Reset fields
    ['fields-bug', 'fields-crash', 'fields-security'].forEach(id => {
      $(id).style.display = id === 'fields-bug' ? '' : 'none';
    });
    // Clear inputs
    ['report-title','report-description','report-steps',
     'report-error-msg','report-stack',
     'report-sec-title','report-sec-detail',
     'report-sender-name', 'report-sender-email'].forEach(id => {
      const el = $(id);
      if (el) el.value = '';
    });
    // Show form, hide success
    formArea.style.display = '';
    successEl.classList.remove('show');
  }

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      currentType = tab.dataset.type;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      $('fields-bug').style.display      = currentType === 'bug'      ? '' : 'none';
      $('fields-crash').style.display    = currentType === 'crash'    ? '' : 'none';
      $('fields-security').style.display = currentType === 'security' ? '' : 'none';
    });
  });

  // Submit
  btnSubmit.addEventListener('click', async () => {
    let payload = {};
    let endpoint = '';

    const senderName = $('report-sender-name').value.trim();
    const senderEmail = $('report-sender-email').value.trim();

    if (!senderName || !senderEmail) {
      toast('กรุณากรอกชื่อและอีเมล (Please fill in name and email)', 'error');
      return;
    }

    if (currentType === 'bug') {
      const title = $('report-title').value.trim();
      const desc  = $('report-description').value.trim();
      if (!title || !desc) { toast('กรุณากรอก Title และ Description', 'error'); return; }
      payload = { title, description: desc, steps: $('report-steps').value.trim() };
      endpoint = '/api/report/bug';
    } else if (currentType === 'crash') {
      const errMsg = $('report-error-msg').value.trim();
      if (!errMsg) { toast('กรุณากรอก Error Message', 'error'); return; }
      payload = { errorMessage: errMsg, stackTrace: $('report-stack').value.trim() };
      endpoint = '/api/report/crash';
    } else {
      const title  = $('report-sec-title').value.trim();
      const detail = $('report-sec-detail').value.trim();
      if (!title || !detail) { toast('กรุณากรอก Title และ Detail', 'error'); return; }
      payload = { title, detail };
      endpoint = '/api/report/security';
    }

    // Attach sender contact details
    payload.senderName = senderName;
    payload.senderEmail = senderEmail;

    // Add app version + platform (non-sensitive)
    payload.appVersion = document.getElementById('s-app-version')?.textContent || 'unknown';
    payload.platform   = navigator.platform || 'unknown';

    btnSubmit.disabled = true;
    spinner.classList.add('show');

    try {
      const res  = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok && data.success) {
        formArea.style.display = 'none';
        successEl.classList.add('show');
      } else {
        toast(data.error || 'ส่งรายงานไม่สำเร็จ กรุณาลองใหม่', 'error');
      }
    } catch (err) {
      toast('ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้', 'error');
    } finally {
      btnSubmit.disabled = false;
      spinner.classList.remove('show');
    }
  });

  btnOpen?.addEventListener('click', openModal);
  btnFeedback?.addEventListener('click', (e) => {
    e.preventDefault();
    openModal();
  });
  btnCancel?.addEventListener('click', closeModal);
  btnClose?.addEventListener('click', closeModal);
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
})();

// ── Developer Dashboard Modal ──────────────────────────────────
(function initDevDashboard() {
  const overlay     = $('dev-modal-overlay');
  const btnOpen     = $('btn-open-dev');
  const btnClose    = $('dev-btn-close');
  const btnClear    = $('dev-btn-clear');
  const listEl      = $('dev-reports-list');
  const emptyEl     = $('dev-reports-empty');
  const tabs        = document.querySelectorAll('#dev-modal-overlay .report-type-tab');
  const licensePlanSelect = $('dev-license-plan');
  const licenseQuantityInput = $('dev-license-quantity');
  const licenseGenerateBtn = $('dev-license-generate-btn');
  const licenseGeneratedEl = $('dev-license-generated');
  const licenseListEl = $('dev-license-list');
  const securityRefreshBtn = $('dev-security-refresh-btn');
  const securityClearBtn = $('dev-security-clear-btn');
  const integrityResetBtn = $('dev-integrity-reset-btn');
  const securityAuditListEl = $('dev-security-audit-list');
  
  let currentFilter = 'all';
  let reportsData   = [];
  let licenseKeysData = [];
  let securityAuditData = [];

  function openModal() {
    overlay.classList.add('show');
    fetchReports();
    fetchLicenseKeys();
    fetchSecurityAudit();
  }

  function closeModal() {
    overlay.classList.remove('show');
  }

  async function fetchReports() {
    try {
      const res = await fetch('/api/developer/reports');
      const data = await res.json();
      if (res.ok && data.success) {
        reportsData = data.reports || [];
        updateCounts();
        renderReports();
      } else {
        toast(data.error || 'Failed to fetch reports', 'error');
      }
    } catch (err) {
      toast('Failed to connect to server', 'error');
    }
  }

  async function fetchLicenseKeys() {
    if (!licenseListEl) return;
    licenseListEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;">Loading license keys...</div>';
    try {
      const res = await fetch('/api/developer/license-keys');
      const data = await res.json();
      if (res.ok && data.success) {
        licenseKeysData = data.keys || [];
        renderLicenseKeys();
      } else {
        licenseListEl.innerHTML = `<div style="color:var(--danger);font-size:11px;">${escapeHtml(data.error || 'Failed to fetch license keys')}</div>`;
      }
    } catch (err) {
      licenseListEl.innerHTML = '<div style="color:var(--danger);font-size:11px;">Failed to connect to server</div>';
    }
  }

  async function fetchSecurityAudit() {
    if (!securityAuditListEl) return;
    securityAuditListEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;">Loading security audit...</div>';
    try {
      const res = await fetch('/api/developer/security-audit');
      const data = await res.json();
      if (res.ok && data.success) {
        securityAuditData = data.events || [];
        renderSecurityAudit();
      } else {
        securityAuditListEl.innerHTML = `<div style="color:var(--danger);font-size:11px;">${escapeHtml(data.error || 'Failed to fetch security audit')}</div>`;
      }
    } catch (err) {
      securityAuditListEl.innerHTML = '<div style="color:var(--danger);font-size:11px;">Failed to connect to server</div>';
    }
  }

  function planLabel(plan) {
    if (plan === 'pro_monthly') return 'Pro Monthly';
    if (plan === 'pro_yearly') return 'Pro Yearly';
    if (plan === 'lifetime') return 'Lifetime';
    return plan || 'Unknown';
  }

  function renderLicenseKeys() {
    if (!licenseListEl) return;
    if (!licenseKeysData.length) {
      licenseListEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;">No license keys generated yet.</div>';
      return;
    }

    licenseListEl.innerHTML = licenseKeysData.slice(0, 20).map(item => {
      const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : '-';
      const redeemed = item.redeemedAt ? new Date(item.redeemedAt).toLocaleString() : '';
      const expires = item.expiresAt ? new Date(item.expiresAt).toLocaleDateString() : 'No expiry';
      const revoked = item.revokedAt ? new Date(item.revokedAt).toLocaleString() : '';
      const canRevoke = item.status !== 'revoked';
      return `
        <div class="dev-license-row ${item.suspicious ? 'is-suspicious' : ''} ${item.status === 'revoked' ? 'is-revoked' : ''}">
          <div>
            <strong>${escapeHtml(planLabel(item.plan))}</strong>
            <div class="dev-license-meta">
              <span>${escapeHtml(item.keyHash || '')}</span>
              <span>${escapeHtml(item.priceLabel || '')}</span>
              <span>Created ${escapeHtml(created)}</span>
              ${item.redeemedBy ? `<span>Redeemed by ${escapeHtml(item.redeemedBy)}</span>` : ''}
              ${redeemed ? `<span>${escapeHtml(redeemed)}</span>` : ''}
              <span>${escapeHtml(expires)}</span>
              ${item.suspicious ? '<span>Suspicious</span>' : ''}
              ${revoked ? `<span>Revoked ${escapeHtml(revoked)}</span>` : ''}
              ${item.revokedReason ? `<span>Reason: ${escapeHtml(item.revokedReason)}</span>` : ''}
            </div>
          </div>
          <div class="dev-license-row-actions">
            <span class="dev-license-status ${escapeHtml(item.status || '')}">${escapeHtml(item.status || 'active')}</span>
            ${canRevoke ? `<button type="button" class="dev-license-revoke-btn" data-license-id="${escapeHtml(item.id)}">Revoke</button>` : ''}
          </div>
          ${canRevoke ? `
            <div class="dev-license-revoke-form" data-license-revoke-form="${escapeHtml(item.id)}">
              <label class="dev-license-revoke-check">
                <input type="checkbox" class="dev-license-revoke-suspicious" checked />
                <span>Mark as suspicious</span>
              </label>
              <textarea class="dev-license-revoke-reason" rows="2" placeholder="Reason, evidence, or note for the audit log"></textarea>
              <div class="dev-license-revoke-actions">
                <button type="button" class="dev-license-revoke-cancel-btn" data-license-id="${escapeHtml(item.id)}">Cancel</button>
                <button type="button" class="dev-license-revoke-submit-btn" data-license-id="${escapeHtml(item.id)}">Confirm revoke</button>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  function toggleLicenseRevokeForm(licenseId, show = true) {
    const form = [...(licenseListEl?.querySelectorAll('[data-license-revoke-form]') || [])]
      .find(el => String(el.dataset.licenseRevokeForm) === String(licenseId));
    if (!form) return;
    form.classList.toggle('show', show);
    if (show) {
      form.querySelector('.dev-license-revoke-reason')?.focus();
    }
  }

  async function revokeLicenseKeyFromUI(licenseId, triggerButton = null) {
    const item = licenseKeysData.find(key => String(key.id) === String(licenseId));
    if (!item) return;
    const form = [...(licenseListEl?.querySelectorAll('[data-license-revoke-form]') || [])]
      .find(el => String(el.dataset.licenseRevokeForm) === String(licenseId));
    const reason = form?.querySelector('.dev-license-revoke-reason')?.value || '';
    const suspicious = !!form?.querySelector('.dev-license-revoke-suspicious')?.checked || !!String(reason).trim();
    const submitBtn = triggerButton || form?.querySelector('.dev-license-revoke-submit-btn');

    try {
      if (submitBtn) submitBtn.disabled = true;
      const res = await fetch(`/api/developer/license-keys/${encodeURIComponent(licenseId)}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          suspicious
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to revoke license key');
      }
      toast(data.userDowngraded ? 'License revoked and matching user was downgraded.' : 'License key revoked.', 'success');
      await fetchLicenseKeys();
      await fetchSecurityAudit();
    } catch (err) {
      toast(err.message, 'error');
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function renderSecurityAudit() {
    if (!securityAuditListEl) return;
    if (!securityAuditData.length) {
      securityAuditListEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;">No security events yet.</div>';
      return;
    }

    securityAuditListEl.innerHTML = securityAuditData.slice(0, 30).map(item => {
      const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : '-';
      return `
        <div class="dev-security-audit-row severity-${escapeHtml(item.severity || 'info')}">
          <div>
            <strong>${escapeHtml(item.eventType || 'security_event')}</strong>
            <div class="dev-license-meta">
              <span>${escapeHtml(created)}</span>
              ${item.actorEmail ? `<span>${escapeHtml(item.actorEmail)}</span>` : ''}
              ${item.ipAddress ? `<span>${escapeHtml(item.ipAddress)}</span>` : ''}
            </div>
            ${item.detail ? `<div class="dev-security-audit-detail">${escapeHtml(item.detail)}</div>` : ''}
          </div>
          <span class="dev-security-severity ${escapeHtml(item.severity || 'info')}">${escapeHtml(item.severity || 'info')}</span>
        </div>
      `;
    }).join('');
  }

  async function generateLicenseKeysFromUI() {
    if (!licenseGenerateBtn) return;
    const plan = licensePlanSelect?.value || 'pro_monthly';
    const quantity = Math.max(1, Math.min(parseInt(licenseQuantityInput?.value, 10) || 1, 100));
    licenseGenerateBtn.disabled = true;
    try {
      const res = await fetch('/api/developer/license-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, quantity })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate license keys');
      }
      const rawKeys = (data.keys || []).map(item => item.key).join('\n');
      if (licenseGeneratedEl) {
        licenseGeneratedEl.textContent = rawKeys || 'No keys generated';
        licenseGeneratedEl.classList.add('show');
      }
      toast(`Generated ${data.keys.length} license key(s).`, 'success');
      await fetchLicenseKeys();
      await fetchSecurityAudit();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      licenseGenerateBtn.disabled = false;
    }
  }

  async function resetIntegrityBaselineFromUI() {
    if (!integrityResetBtn) return;
    const confirmed = confirm('Trust the current local app files as the new integrity baseline? Only do this after you know these changes are yours.');
    if (!confirmed) return;

    integrityResetBtn.disabled = true;
    try {
      const res = await fetch('/api/developer/integrity-baseline/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to reset integrity baseline');
      }
      toast('Integrity baseline updated for the current trusted build.', 'success');
      await fetchSecurityAudit();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      integrityResetBtn.disabled = false;
    }
  }

  async function clearSecurityAuditFromUI() {
    if (!securityClearBtn) return;
    const confirmed = confirm('Clear the visible security audit history? This keeps a new audit-cleared event as a record.');
    if (!confirmed) return;

    securityClearBtn.disabled = true;
    try {
      const res = await fetch('/api/developer/security-audit', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to clear security audit');
      }
      toast(`Cleared ${data.removed || 0} security audit event(s).`, 'success');
      await fetchSecurityAudit();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      securityClearBtn.disabled = false;
    }
  }

  function updateCounts() {
    $('dev-count-all').textContent = reportsData.length;
    $('dev-count-bug').textContent = reportsData.filter(r => r.type === 'bug').length;
    $('dev-count-crash').textContent = reportsData.filter(r => r.type === 'crash').length;
    $('dev-count-security').textContent = reportsData.filter(r => r.type === 'security').length;
  }

  function renderReports() {
    listEl.innerHTML = '';
    const filtered = currentFilter === 'all' 
      ? reportsData 
      : reportsData.filter(r => r.type === currentFilter);

    if (filtered.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    // Show latest reports first
    const sorted = [...filtered].reverse();

    sorted.forEach(r => {
      const card = document.createElement('div');
      card.className = `dev-report-card type-${r.type}`;
      
      const dateStr = new Date(r.timestamp).toLocaleString('th-TH');
      
      const typeIcons = { bug: '🐛', crash: '💥', security: '🔒' };
      const typeLabels = { bug: 'Bug', crash: 'Crash', security: 'Security' };
      const icon = typeIcons[r.type] || '📝';
      const label = typeLabels[r.type] || 'Report';

      let detailsHtml = '';
      if (r.type === 'bug') {
        detailsHtml = `
          <div style="font-weight:600;margin-bottom:4px;">Steps to Reproduce:</div>
          <div style="color:var(--text-secondary);white-space:pre-wrap;margin-bottom:8px;">${escapeHtml(r.steps) || '(ไม่มีขั้นตอนระบุ)'}</div>
          <div style="font-weight:600;margin-bottom:4px;">Description:</div>
          <div style="color:var(--text-secondary);white-space:pre-wrap;">${escapeHtml(r.description)}</div>
        `;
      } else if (r.type === 'crash') {
        detailsHtml = `
          <div style="font-weight:600;margin-bottom:4px;">Stack Trace:</div>
          <div class="dev-report-code">${escapeHtml(r.stackTrace) || '(ไม่มี stack trace)'}</div>
        `;
      } else if (r.type === 'security') {
        detailsHtml = `
          <div style="font-weight:600;margin-bottom:4px;">Detail:</div>
          <div style="color:var(--text-secondary);white-space:pre-wrap;">${escapeHtml(r.detail)}</div>
        `;
      }

      let senderHtml = '';
      if (r.senderName || r.senderEmail) {
        senderHtml = `
          <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.08); font-size: 11px; color: var(--text-dim);">
            👤 <strong>Reporter:</strong> ${escapeHtml(r.senderName)} (${escapeHtml(r.senderEmail)})
          </div>
        `;
      }

      card.innerHTML = `
        <div class="dev-report-header">
          <div class="dev-report-title">
            <span>${icon}</span>
            <span>${escapeHtml(r.title || r.errorMessage || label)}</span>
          </div>
          <div class="dev-report-time">${dateStr}</div>
        </div>
        <div class="dev-report-meta">
          <span class="dev-report-meta-item">Type: ${label}</span>
          <span class="dev-report-meta-item">App: ${escapeHtml(r.appVersion || 'unknown')}</span>
          <span class="dev-report-meta-item">OS: ${escapeHtml(r.platform || 'unknown')}</span>
        </div>
        <div class="dev-report-body">
          ${escapeHtml(r.description || r.errorMessage || r.detail || '').substring(0, 120)}...
        </div>
        <div class="dev-report-details" id="details-${r.id}">
          ${detailsHtml}
          ${senderHtml}
        </div>
      `;

      card.addEventListener('click', (e) => {
        // Prevent click if clicking inside the code block
        if (e.target.closest('.dev-report-code')) return;
        const details = card.querySelector('.dev-report-details');
        details.classList.toggle('open');
      });

      listEl.appendChild(card);
    });
  }

  function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      currentFilter = tab.dataset.type;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      renderReports();
    });
  });

  // Clear reports
  btnClear.addEventListener('click', async () => {
    if (!confirm('คุณแน่ใจหรือไม่ว่าต้องการลบรายงานทั้งหมด? การลบนี้ไม่สามารถกู้คืนได้ (Are you sure you want to clear all reports? This action cannot be undone.)')) {
      return;
    }
    
    try {
      const res = await fetch('/api/developer/reports', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast('ลบรายงานทั้งหมดเรียบร้อยแล้ว', 'success');
        reportsData = [];
        updateCounts();
        renderReports();
      } else {
        toast(data.error || 'Failed to clear reports', 'error');
      }
    } catch (err) {
      toast('Failed to connect to server', 'error');
    }
  });

  btnOpen.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  licenseGenerateBtn?.addEventListener('click', generateLicenseKeysFromUI);
  licenseListEl?.addEventListener('click', (e) => {
    const openBtn = e.target.closest('.dev-license-revoke-btn');
    const cancelBtn = e.target.closest('.dev-license-revoke-cancel-btn');
    const submitBtn = e.target.closest('.dev-license-revoke-submit-btn');
    const btn = openBtn || cancelBtn || submitBtn;
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    if (openBtn) {
      toggleLicenseRevokeForm(openBtn.dataset.licenseId, true);
    } else if (cancelBtn) {
      toggleLicenseRevokeForm(cancelBtn.dataset.licenseId, false);
    } else if (submitBtn) {
      revokeLicenseKeyFromUI(submitBtn.dataset.licenseId, submitBtn);
    }
  });
  securityRefreshBtn?.addEventListener('click', fetchSecurityAudit);
  integrityResetBtn?.addEventListener('click', resetIntegrityBaselineFromUI);
  securityClearBtn?.addEventListener('click', clearSecurityAuditFromUI);
})();

// ── Refresh URL Modal Logic ────────────────────────────────────
(function initRefreshModal() {
  const overlay = $('refresh-modal-overlay');
  const btnCancel = $('refresh-btn-cancel');
  const btnSubmit = $('refresh-btn-submit');
  const urlInput = $('refresh-url-input');
  const spinner = $('refresh-spinner');
  let activeTaskId = null;

  window.openRefreshUrlModal = function(taskId) {
    activeTaskId = taskId;
    urlInput.value = '';
    overlay.classList.add('show');
    urlInput.focus();
  };

  function closeModal() {
    overlay.classList.remove('show');
    activeTaskId = null;
  }

  async function submitRefresh(force = false) {
    const url = urlInput.value.trim();
    if (!url) {
      toast('กรุณากรอก URL ใหม่ (Please enter a URL)', 'error');
      return;
    }

    btnSubmit.disabled = true;
    spinner.classList.add('show');

    try {
      const res = await fetch(`/api/tasks/${activeTaskId}/refresh-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, force })
      });

      const data = await res.json();
      if (res.status === 409 && data.sizeMismatch) {
        // Size mismatch warning
        const confirmForce = confirm(`${data.error}\n\nคุณแน่ใจที่จะดำเนินการต่อโดยลบส่วนที่ดาวน์โหลดแล้วและเริ่มดาวน์โหลดใหม่จากศูนย์หรือไม่?`);
        if (confirmForce) {
          // Retry with force = true
          await submitRefresh(true);
        }
      } else if (!res.ok) {
        throw new Error(data.error || 'Failed to refresh URL');
      } else {
        toast('ชุบชีวิตลิงก์สำเร็จ! กำลังดาวน์โหลดต่อ...', 'success');
        closeModal();
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btnSubmit.disabled = false;
      spinner.classList.remove('show');
    }
  }

  btnCancel.addEventListener('click', closeModal);
  btnSubmit.addEventListener('click', () => submitRefresh(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
})();

// ── Files Explorer Modal Logic ─────────────────────────────────
(function initFilesModal() {
  const overlay = $('files-modal-overlay');
  const btnClose = $('files-btn-close');
  const searchInput = $('files-search-input');
  const listViewport = $('files-list-viewport');
  const emptyState = $('files-empty-state');
  
  let filesCache = [];

  window.openFilesExplorerModal = function() {
    overlay.classList.add('show');
    searchInput.value = '';
    loadFiles();
  };

  function closeModal() {
    overlay.classList.remove('show');
  }

  async function loadFiles() {
    listViewport.innerHTML = '<div style="text-align:center; padding: 20px; color:var(--text-dim);">⏳ Loading files...</div>';
    emptyState.classList.remove('show');
    try {
      const res = await fetch('/api/files');
      if (!res.ok) throw new Error('Failed to load files');
      const data = await res.json();
      filesCache = data || [];
      renderFiles(filesCache);
    } catch (err) {
      listViewport.innerHTML = `<div style="text-align:center; padding: 20px; color:var(--danger);">Error: ${err.message}</div>`;
    }
  }

  function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v'];
    const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];
    
    if (videoExts.includes(ext)) return '🎬';
    if (audioExts.includes(ext)) return '🎵';
    if (imageExts.includes(ext)) return '🖼️';
    return '📄';
  }

  function renderFiles(files) {
    listViewport.innerHTML = '';
    
    if (files.length === 0) {
      emptyState.classList.add('show');
      return;
    }
    emptyState.classList.remove('show');

    files.forEach(file => {
      const row = document.createElement('div');
      row.className = 'file-row-item';
      
      const sizeStr = typeof fmtBytes === 'function' ? fmtBytes(file.size) : `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
      const dateStr = new Date(file.mtime).toLocaleString();
      const icon = getFileIcon(file.name);

      row.innerHTML = `
        <div class="file-row-icon">${icon}</div>
        <div class="file-row-details">
          <div class="file-row-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
          <div class="file-row-meta">
            <span>💾 ${sizeStr}</span>
            <span>📅 ${dateStr}</span>
          </div>
        </div>
        <div class="file-row-actions">
          <button class="file-action-btn btn-action-open" data-action="open" title="${t('files_btn_open', 'Open File')}">
            ▶️ ${t('files_btn_open', 'Open')}
          </button>
          <button class="file-action-btn" data-action="show" title="${t('files_btn_show', 'Show in Folder')}">
            📂
          </button>
          <button class="file-action-btn btn-action-delete" data-action="delete" title="${t('files_btn_delete', 'Delete')}">
            🗑️
          </button>
        </div>
      `;

      // Bind button click events
      row.querySelector('[data-action="open"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openFile(file.path);
      });
      row.querySelector('[data-action="show"]').addEventListener('click', (e) => {
        e.stopPropagation();
        showInFolder(file.path);
      });
      row.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(file.path, file.name);
      });

      listViewport.appendChild(row);
    });
  }

  async function openFile(filePath) {
    try {
      const res = await fetch('/api/open-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      if (!res.ok) throw new Error('Could not open file');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function showInFolder(filePath) {
    try {
      const res = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      if (!res.ok) throw new Error('Could not show folder');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteFile(filePath, filename) {
    const confirmMsg = t('files_delete_confirm', 'Are you sure you want to permanently delete this file from your computer?');
    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast('Deleted file successfully', 'success');
        // Refresh local cache and list
        filesCache = filesCache.filter(f => f.path !== filePath);
        filterAndRender();
      } else {
        throw new Error(data.error || 'Failed to delete file');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function filterAndRender() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      renderFiles(filesCache);
    } else {
      const filtered = filesCache.filter(f => f.name.toLowerCase().includes(query));
      renderFiles(filtered);
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Hook up event listeners
  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  searchInput.addEventListener('input', filterAndRender);
})();

// 💳 Pricing & Subscription Modal Logic 💳
(function initPricingModal() {
  const overlay  = $('pricing-modal-overlay');
  const btnClose = $('pricing-btn-close');
  const pricingGrid = document.querySelector('.pricing-grid');
  const pricingOverviewMain = document.querySelector('.pricing-overview-main');
  const currentPlanEl = $('pricing-current-plan');
  const currentSpeedEl = $('pricing-current-speed');
  const currentConnectionsEl = $('pricing-current-connections');
  const currentStatusEl = $('pricing-current-status');
  const licenseInput = $('license-key-input');
  const licenseRedeemBtn = $('license-redeem-btn');
  const licenseStatusEl = $('license-redeem-status');

  if (!overlay) return;

  const plans = [
    {
      id: 'free',
      normalizedPlan: 'free',
      free: true,
      badgeClass: '',
      buttonClass: 'btn-current-plan',
      disabled: true,
      titleKey: 'pricing_free_title',
      descKey: 'pricing_free_desc',
      periodKey: 'pricing_forever',
      quotaKey: 'pricing_feature_free_quota',
      afterQuotaKey: 'pricing_feature_after_quota_free',
      thirdFeatureKey: 'pricing_feature_conn_limit',
      buttonKey: 'pricing_btn_current'
    },
    {
      id: 'pro-monthly',
      normalizedPlan: 'pro_monthly',
      baseUsd: 1.09,
      badgeClass: 'pro',
      buttonClass: 'btn-pro-plan',
      titleKey: 'pricing_monthly_title',
      descKey: 'pricing_monthly_desc',
      periodKey: 'pricing_per_month',
      quotaKey: 'pricing_feature_monthly_quota',
      afterQuotaKey: 'pricing_feature_after_quota_monthly',
      thirdFeatureKey: 'pricing_feature_conn_unlimit',
      buttonKey: 'pricing_btn_select'
    },
    {
      id: 'pro-yearly',
      normalizedPlan: 'pro_yearly',
      baseUsd: 8.35,
      cardClass: 'popular',
      badgeClass: 'yearly',
      ribbonKey: 'pricing_badge_best_value',
      buttonClass: 'btn-pro-plan',
      titleKey: 'pricing_yearly_title',
      descKey: 'pricing_yearly_desc',
      periodKey: 'pricing_per_year',
      quotaKey: 'pricing_feature_yearly_quota',
      afterQuotaKey: 'pricing_feature_after_quota_yearly',
      thirdFeatureKey: 'pricing_feature_conn_unlimit',
      buttonKey: 'pricing_btn_select'
    },
    {
      id: 'lifetime',
      normalizedPlan: 'lifetime',
      baseUsd: 16.73,
      badgeClass: 'lifetime',
      ribbonKey: 'pricing_badge_one_time',
      ribbonClass: 'lifetime',
      buttonClass: 'btn-lifetime-plan',
      titleKey: 'pricing_life_title',
      descKey: 'pricing_life_desc',
      periodKey: 'pricing_one_time',
      quotaKey: 'pricing_feature_lifetime_quota',
      afterQuotaKey: 'pricing_feature_after_quota_lifetime',
      thirdFeatureKey: 'pricing_feature_conn_unlimit',
      buttonKey: 'pricing_btn_select'
    }
  ];

  function getCurrentProfile() {
    return typeof currentUserProfile !== 'undefined' ? currentUserProfile : null;
  }

  function normalizeSubscriptionPlan(value) {
    const plan = String(value || 'free').toLowerCase();
    if (plan === 'life' || plan === 'lifetime') return 'lifetime';
    if (plan === 'pro_yearly' || plan === 'pro-yearly' || plan === 'yearly') return 'pro_yearly';
    if (plan === 'pro' || plan === 'premium' || plan === 'pro_monthly' || plan === 'pro-monthly' || plan === 'monthly') return 'pro_monthly';
    return 'free';
  }

  function getCurrentEntitlement() {
    const profile = getCurrentProfile();
    const cachedRole = typeof AUTH_USER_ROLE_KEY !== 'undefined' ? localStorage.getItem(AUTH_USER_ROLE_KEY) : '';
    const role = String(profile?.role || cachedRole || 'user').toLowerCase();

    if (role === 'developer' || role === 'admin') {
      return {
        accountType: role,
        plan: role,
        title: role === 'developer'
          ? t('pricing_plan_developer', 'Developer')
          : t('pricing_plan_admin', 'Admin'),
        speed: t('pricing_entitlement_unlimited_speed', 'Unlimited full-speed downloads'),
        connections: '32',
        status: role === 'developer'
          ? t('pricing_status_developer', 'Developer Account')
          : t('pricing_status_admin', 'Admin Account'),
        note: t('pricing_overview_unlimited_note', 'This account bypasses subscription quota limits.'),
        benefits: [
          t('pricing_entitlement_unlimited_speed', 'Unlimited full-speed downloads'),
          t('pricing_entitlement_no_quota_fallback', 'No fallback speed limit'),
          role === 'developer'
            ? t('pricing_entitlement_developer_tools', 'Developer access enabled')
            : t('pricing_entitlement_admin_tools', 'Admin access enabled')
        ]
      };
    }

    const plan = normalizeSubscriptionPlan(profile?.subscription);
    const planData = {
      free: {
        title: t('pricing_free_title', 'Free'),
        speed: t('pricing_feature_free_quota', '8 full-speed downloads/day'),
        connections: '8',
        status: t('pricing_status_free', 'Free Plan'),
        note: t('pricing_overview_note', 'Your download limits are based on the active plan for this account.'),
        benefits: [
          t('pricing_feature_free_quota', '8 full-speed downloads/day'),
          t('pricing_feature_after_quota_free', '5 MB/s after quota'),
          t('pricing_feature_conn_limit', 'Max 8 Connections per task')
        ]
      },
      pro_monthly: {
        title: t('pricing_monthly_title', 'Pro Monthly'),
        speed: t('pricing_feature_monthly_quota', '50 full-speed downloads/day'),
        connections: '32',
        status: t('pricing_status_paid', 'Paid Plan'),
        note: t('pricing_overview_paid_note', 'These features are active while this paid plan is valid.'),
        benefits: [
          t('pricing_feature_monthly_quota', '50 full-speed downloads/day'),
          t('pricing_feature_after_quota_monthly', '10 MB/s after quota'),
          t('pricing_feature_conn_unlimit', 'Up to 32 Connections per task')
        ]
      },
      pro_yearly: {
        title: t('pricing_yearly_title', 'Pro Yearly'),
        speed: t('pricing_feature_yearly_quota', '100 full-speed downloads/day'),
        connections: '32',
        status: t('pricing_badge_best_value', 'Best Value'),
        note: t('pricing_overview_paid_note', 'These features are active while this paid plan is valid.'),
        benefits: [
          t('pricing_feature_yearly_quota', '100 full-speed downloads/day'),
          t('pricing_feature_after_quota_yearly', '15 MB/s after quota'),
          t('pricing_feature_conn_unlimit', 'Up to 32 Connections per task')
        ]
      },
      lifetime: {
        title: t('pricing_life_title', 'Lifetime'),
        speed: t('pricing_feature_lifetime_quota', '250 full-speed downloads/day'),
        connections: '32',
        status: t('pricing_badge_one_time', 'One-time Payment'),
        note: t('pricing_overview_paid_note', 'These features are active while this paid plan is valid.'),
        benefits: [
          t('pricing_feature_lifetime_quota', '250 full-speed downloads/day'),
          t('pricing_feature_after_quota_lifetime', '15 MB/s after quota'),
          t('pricing_feature_conn_unlimit', 'Up to 32 Connections per task')
        ]
      }
    };

    return { accountType: 'user', plan, ...planData[plan] };
  }

  function showLicenseStatus(message, type = 'success') {
    if (!licenseStatusEl) return;
    licenseStatusEl.textContent = message || '';
    licenseStatusEl.className = `license-activation-status show ${type}`;
  }

  function clearLicenseStatus() {
    if (!licenseStatusEl) return;
    licenseStatusEl.textContent = '';
    licenseStatusEl.className = 'license-activation-status';
  }

  async function refreshSubscriptionSurfaces() {
    if (typeof window.refreshCurrentUserProfile === 'function') {
      await window.refreshCurrentUserProfile();
    }
    if (typeof refreshQuotaStatus === 'function') {
      await refreshQuotaStatus();
    }
    renderPricingPlans();
    renderPricingOverview();
  }

  const defaultPricingCurrency = {
    region: 'US',
    locale: 'en-US',
    currency: 'USD',
    rate: 1,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  };

  const pricingCurrenciesByRegion = {
    US: defaultPricingCurrency,
    TH: { region: 'TH', locale: 'th-TH', currency: 'THB', rate: 35.8, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    JP: { region: 'JP', locale: 'ja-JP', currency: 'JPY', rate: 156, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    CN: { region: 'CN', locale: 'zh-CN', currency: 'CNY', rate: 7.25, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    KR: { region: 'KR', locale: 'ko-KR', currency: 'KRW', rate: 1375, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    IN: { region: 'IN', locale: 'en-IN', currency: 'INR', rate: 83.5, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    ID: { region: 'ID', locale: 'id-ID', currency: 'IDR', rate: 16200, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    MY: { region: 'MY', locale: 'ms-MY', currency: 'MYR', rate: 4.7, minimumFractionDigits: 2, maximumFractionDigits: 2 },
    PH: { region: 'PH', locale: 'en-PH', currency: 'PHP', rate: 58.5, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    VN: { region: 'VN', locale: 'vi-VN', currency: 'VND', rate: 25400, minimumFractionDigits: 0, maximumFractionDigits: 0 },
    SG: { region: 'SG', locale: 'en-SG', currency: 'SGD', rate: 1.35, minimumFractionDigits: 2, maximumFractionDigits: 2 },
    AU: { region: 'AU', locale: 'en-AU', currency: 'AUD', rate: 1.52, minimumFractionDigits: 2, maximumFractionDigits: 2 },
    NZ: { region: 'NZ', locale: 'en-NZ', currency: 'NZD', rate: 1.65, minimumFractionDigits: 2, maximumFractionDigits: 2 },
    CA: { region: 'CA', locale: 'en-CA', currency: 'CAD', rate: 1.37, minimumFractionDigits: 2, maximumFractionDigits: 2 },
    GB: { region: 'GB', locale: 'en-GB', currency: 'GBP', rate: 0.79, minimumFractionDigits: 2, maximumFractionDigits: 2 }
  };

  const euroPricingRegions = new Set([
    'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT',
    'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'
  ]);

  const pricingTimeZoneRegions = {
    'Asia/Bangkok': 'TH',
    'Asia/Tokyo': 'JP',
    'Asia/Shanghai': 'CN',
    'Asia/Seoul': 'KR',
    'Asia/Kolkata': 'IN',
    'Asia/Jakarta': 'ID',
    'Asia/Kuala_Lumpur': 'MY',
    'Asia/Manila': 'PH',
    'Asia/Ho_Chi_Minh': 'VN',
    'Asia/Singapore': 'SG',
    'Australia/Sydney': 'AU',
    'Pacific/Auckland': 'NZ',
    'Europe/London': 'GB',
    'Europe/Berlin': 'DE',
    'Europe/Paris': 'FR',
    'Europe/Madrid': 'ES',
    'Europe/Rome': 'IT',
    'Europe/Amsterdam': 'NL',
    'Europe/Brussels': 'BE',
    'Europe/Vienna': 'AT',
    'Europe/Helsinki': 'FI',
    'Europe/Dublin': 'IE',
    'Europe/Lisbon': 'PT',
    'Europe/Athens': 'GR'
  };

  function getRegionFromLocale(locale) {
    if (!locale) return '';
    try {
      const parsed = new Intl.Locale(locale);
      if (parsed.region) return parsed.region.toUpperCase();
    } catch (_) {}
    const match = String(locale).match(/[-_]([A-Za-z]{2}|\d{3})(?:[-_]|$)/);
    return match ? match[1].toUpperCase() : '';
  }

  function getMachinePricingRegion() {
    const regions = [];
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      if (pricingTimeZoneRegions[resolved.timeZone]) {
        return pricingTimeZoneRegions[resolved.timeZone];
      }
      const localeRegion = getRegionFromLocale(resolved.locale);
      if (localeRegion) regions.push(localeRegion);
    } catch (_) {}

    const languageList = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language];

    languageList.forEach(locale => {
      const region = getRegionFromLocale(locale);
      if (region) regions.push(region);
    });

    return regions.find(region => pricingCurrenciesByRegion[region] || euroPricingRegions.has(region)) || 'US';
  }

  function getPricingCurrency() {
    const region = getMachinePricingRegion();
    if (pricingCurrenciesByRegion[region]) return pricingCurrenciesByRegion[region];
    if (euroPricingRegions.has(region)) {
      return { region, locale: 'en-IE', currency: 'EUR', rate: 0.92, minimumFractionDigits: 2, maximumFractionDigits: 2 };
    }
    return defaultPricingCurrency;
  }

  function formatPlanPrice(plan) {
    if (plan.free) return t('pricing_free_price', 'Free');

    const profile = getPricingCurrency();
    const amount = (plan.baseUsd || 0) * profile.rate;
    return new Intl.NumberFormat(profile.locale, {
      style: 'currency',
      currency: profile.currency,
      minimumFractionDigits: profile.minimumFractionDigits,
      maximumFractionDigits: profile.maximumFractionDigits
    }).format(amount);
  }

  function renderPricingPlans() {
    if (!pricingGrid) return;
    const entitlement = getCurrentEntitlement();
    pricingGrid.classList.add('pricing-grid-four');
    pricingGrid.innerHTML = plans.map(plan => `
      <div class="pricing-card ${plan.cardClass || ''} ${entitlement.plan === plan.normalizedPlan ? 'current' : ''}" id="pricing-card-${plan.id}">
        ${plan.ribbonKey ? `<div class="pricing-card-ribbon ${plan.ribbonClass || ''}">${t(plan.ribbonKey)}</div>` : ''}
        <div class="pricing-card-header">
          <div class="pricing-card-badge ${plan.badgeClass || ''}">${t(plan.titleKey)}</div>
          <h3 class="pricing-card-title">${t(plan.titleKey)}</h3>
          <p class="pricing-card-desc">${t(plan.descKey)}</p>
        </div>
        <div class="pricing-card-price-wrap">
          <span class="pricing-card-price">${formatPlanPrice(plan)}</span>
          <span class="pricing-card-period">${t(plan.periodKey)}</span>
        </div>
        <ul class="pricing-card-features">
          <li class="highlight"><span>✓</span> <span>${t(plan.quotaKey)}</span></li>
          <li><span>✓</span> <span>${t(plan.afterQuotaKey || 'pricing_feature_after_quota')}</span></li>
          <li><span>✓</span> <span>${t(plan.thirdFeatureKey)}</span></li>
        </ul>
        <button class="pricing-card-btn ${entitlement.plan === plan.normalizedPlan ? 'btn-current-plan' : plan.buttonClass}" id="btn-checkout-${plan.id}" ${plan.disabled || entitlement.plan === plan.normalizedPlan ? 'disabled' : ''}>
          <span>${entitlement.plan === plan.normalizedPlan ? t('pricing_btn_current', 'Current Plan') : t(plan.buttonKey)}</span>
        </button>
      </div>
    `).join('');

    pricingGrid.querySelectorAll('[id^="btn-checkout-"]:not(#btn-checkout-free)').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.pricing-card');
        const planName = card?.querySelector('.pricing-card-title')?.textContent || t('pricing_pro_title', 'Pro Plan');
        toast(t('pricing_toast_checkout', 'Simulation: Processing {plan} order... (Demo Mode)').replace('{plan}', planName), 'info');
      });
    });
  }

  function renderPricingOverview() {
    const entitlement = getCurrentEntitlement();

    if (currentPlanEl) currentPlanEl.textContent = entitlement.title;
    if (currentSpeedEl) currentSpeedEl.textContent = entitlement.speed;
    if (currentConnectionsEl) currentConnectionsEl.textContent = entitlement.connections;
    if (currentStatusEl) currentStatusEl.textContent = entitlement.status;

    const noteEl = pricingOverviewMain?.querySelector('.pricing-overview-note');
    if (noteEl) noteEl.textContent = entitlement.note;

    if (pricingOverviewMain) {
      let benefitsEl = pricingOverviewMain.querySelector('.pricing-current-benefits');
      if (!benefitsEl) {
        benefitsEl = document.createElement('div');
        benefitsEl.className = 'pricing-current-benefits';
        pricingOverviewMain.appendChild(benefitsEl);
      }
      benefitsEl.innerHTML = entitlement.benefits.map(item => `<span>${item}</span>`).join('');
    }
  }

  window.openPricingModal = function () {
    renderPricingPlans();
    renderPricingOverview();
    clearLicenseStatus();
    overlay.classList.add('show');
    document.body.classList.add('modal-open');
  };

  function closeModal() {
    overlay.classList.remove('show', 'active');
    document.body.classList.remove('modal-open');
  }

  btnClose?.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  licenseInput?.addEventListener('input', clearLicenseStatus);
  licenseRedeemBtn?.addEventListener('click', async () => {
    const key = licenseInput?.value.trim();
    if (!key) {
      showLicenseStatus(t('license_error_required', 'Please enter a license key.'), 'error');
      return;
    }

    licenseRedeemBtn.disabled = true;
    const oldText = licenseRedeemBtn.textContent;
    licenseRedeemBtn.textContent = t('license_redeeming', 'Redeeming...');

    try {
      const res = await fetch('/api/license/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to redeem license key');
      }
      if (licenseInput) licenseInput.value = '';
      await refreshSubscriptionSurfaces();
      const expiresText = data.expiresAt
        ? ` Expires ${new Date(data.expiresAt).toLocaleDateString()}.`
        : '';
      showLicenseStatus(`${data.label || 'Plan'} unlocked successfully.${expiresText}`, 'success');
      toast(`${data.label || 'Plan'} unlocked successfully!`, 'success');
    } catch (err) {
      showLicenseStatus(err.message, 'error');
    } finally {
      licenseRedeemBtn.disabled = false;
      licenseRedeemBtn.textContent = oldText;
    }
  });

})();
