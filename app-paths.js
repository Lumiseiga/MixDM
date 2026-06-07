const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DATA_DIR_NAME = 'MIXDM';
const LEGACY_TEMP_DATA_DIR = path.join(os.tmpdir(), APP_DATA_DIR_NAME);
let migratedLegacyData = false;

function existingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean);
}

function defaultDataDir() {
  if (process.env.MIXDM_USER_DATA_DIR) {
    return process.env.MIXDM_USER_DATA_DIR;
  }

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_DATA_DIR_NAME);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DATA_DIR_NAME);
  }

  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_DATA_DIR_NAME);
}

function migrateLegacyTempData(targetDir) {
  if (migratedLegacyData) return;
  migratedLegacyData = true;

  if (path.resolve(targetDir) === path.resolve(LEGACY_TEMP_DATA_DIR)) return;
  if (!fs.existsSync(LEGACY_TEMP_DATA_DIR)) return;

  const filesToCopy = [
    'mixdm.db',
    'mixdm.db-wal',
    'mixdm.db-shm',
    'users.json',
    'users.json.migrated.bak',
    'reports.json',
    'reports.json.migrated.bak'
  ];

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of filesToCopy) {
      const legacyFile = path.join(LEGACY_TEMP_DATA_DIR, file);
      const targetFile = path.join(targetDir, file);
      if (fs.existsSync(legacyFile) && !fs.existsSync(targetFile)) {
        fs.copyFileSync(legacyFile, targetFile);
      }
    }
  } catch (err) {
    console.warn('[Paths] Failed to migrate legacy temp app data:', err.message);
  }
}

function resourcePath(...parts) {
  const localPath = path.join(__dirname, ...parts);
  const packagedPath = process.resourcesPath
    ? path.join(process.resourcesPath, ...parts)
    : null;

  return existingPath([packagedPath, localPath]);
}

function appDataPath(...parts) {
  const base = defaultDataDir();
  migrateLegacyTempData(base);
  return path.join(base, ...parts);
}

module.exports = {
  appDataPath,
  resourcePath,
};
