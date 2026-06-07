const fs = require('fs');
const path = require('path');
const os = require('os');
const { appDataPath } = require('./app-paths');

const SETTINGS_FILE = appDataPath('settings.json');
const SETTINGS_SCHEMA_VERSION = 3;
const PERFORMANCE_METER_INTERVALS = new Set([500, 2500, 5000]);
const DEFAULT_PERFORMANCE_METER_INTERVAL_MS = 2500;

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_SCHEMA_VERSION,
  cookiesEnabled: false,
  cookiesBrowser: 'chrome',
  theme: 'default',
  language: 'en',
  downloadsDir: path.join(os.homedir(), 'Downloads', 'MIXDM'),
  defaultSegments: 16,
  maxConcurrentDownloads: 2,
  smartRetryEnabled: true,
  smartRetryMaxAttempts: 3,
  smartRetryBaseDelayMs: 5000,
  speedMode: 'full',
  performanceMeterIntervalMs: DEFAULT_PERFORMANCE_METER_INTERVAL_MS,
  speedLimitEnabled: false,
  speedLimitKbps: 5120,
  autoAnalyze: true,
  clearAfterStart: true,
  clipboardMonitorEnabled: true,
  clipboardNotificationsEnabled: true,
  completionSoundEnabled: true,
  showMiniHud: true,
  autoLaunchEnabled: false
};

let currentSettings = { ...DEFAULT_SETTINGS };

function normalizePerformanceMeterInterval(value) {
  const interval = Math.round(Number(value) || DEFAULT_PERFORMANCE_METER_INTERVAL_MS);
  return PERFORMANCE_METER_INTERVALS.has(interval) ? interval : DEFAULT_PERFORMANCE_METER_INTERVAL_MS;
}

function normalizeSettings(settings) {
  const normalized = { ...DEFAULT_SETTINGS, ...settings };
  const previousVersion = Number(settings && settings.settingsVersion) || 0;

  if (previousVersion < 2 && normalized.defaultSegments === 8) {
    normalized.defaultSegments = DEFAULT_SETTINGS.defaultSegments;
  }

  normalized.defaultSegments = Math.max(1, Math.min(Math.round(Number(normalized.defaultSegments) || DEFAULT_SETTINGS.defaultSegments), 32));
  normalized.performanceMeterIntervalMs = normalizePerformanceMeterInterval(normalized.performanceMeterIntervalMs);
  normalized.settingsVersion = SETTINGS_SCHEMA_VERSION;
  return normalized;
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(data);
      currentSettings = normalizeSettings(parsed);
      if (currentSettings.settingsVersion !== parsed.settingsVersion || currentSettings.defaultSegments !== parsed.defaultSegments) {
        saveSettings(currentSettings);
      }
    } else {
      const dir = path.dirname(SETTINGS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      saveSettings(DEFAULT_SETTINGS);
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
    currentSettings = { ...DEFAULT_SETTINGS };
  }
  return currentSettings;
}

function saveSettings(settings) {
  try {
    currentSettings = normalizeSettings({ ...currentSettings, ...settings });
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

function getSettings() {
  return currentSettings;
}

// Initial load
loadSettings();

module.exports = {
  getSettings,
  saveSettings,
  loadSettings,
};
