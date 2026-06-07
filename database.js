/**
 * database.js
 * Central SQLite database manager for MIXDM.
 * Handles schema creation, persistent config, and one-time migration from legacy JSON files.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { appDataPath } = require('./app-paths');

const DB_PATH = appDataPath('mixdm.db');

// Ensure the data directory exists before opening the database
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// ─── Performance Pragmas ──────────────────────────────────────────────────────
db.pragma('journal_mode = WAL');   // Better concurrent read performance
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL'); // Safe + faster than FULL

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    username        TEXT    NOT NULL,
    display_name    TEXT    NOT NULL,
    password        TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'user',
    reset_token     TEXT,
    reset_token_expires INTEGER,
    avatar_url      TEXT    DEFAULT '',
    bio             TEXT    DEFAULT '',
    subscription    TEXT    DEFAULT 'free',
    subscription_expires_at TEXT,
    subscription_machine_id TEXT,
    subscription_signature TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS license_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash      TEXT    NOT NULL UNIQUE,
    plan          TEXT    NOT NULL,
    duration_days INTEGER,
    price_label   TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    created_by    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    redeemed_by   TEXT,
    redeemed_at   TEXT,
    expires_at    TEXT,
    machine_id    TEXT,
    license_signature TEXT
  );

  CREATE TABLE IF NOT EXISTS reports (
    id            TEXT    PRIMARY KEY,
    type          TEXT    NOT NULL,
    title         TEXT,
    description   TEXT,
    steps         TEXT,
    error_message TEXT,
    stack_trace   TEXT,
    detail        TEXT,
    app_version   TEXT,
    platform      TEXT,
    sender_name   TEXT    DEFAULT '',
    sender_email  TEXT    DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS security_audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT    NOT NULL,
    severity    TEXT    NOT NULL DEFAULT 'info',
    actor_email TEXT,
    ip_address  TEXT,
    detail      TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Try updating existing database tables with new columns
try { db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN subscription TEXT DEFAULT 'free'"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN subscription_expires_at TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN subscription_machine_id TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN subscription_signature TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE license_keys ADD COLUMN machine_id TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE license_keys ADD COLUMN license_signature TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE reports ADD COLUMN sender_name TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE reports ADD COLUMN sender_email TEXT DEFAULT ''"); } catch (_) {}

// ─── One-Time Migration from JSON Files ──────────────────────────────────────

/**
 * Migrate users.json → users table (only runs if table is empty and file exists)
 */
function migrateUsersFromJson() {
  const usersFile = appDataPath('users.json');
  if (!fs.existsSync(usersFile)) return;

  const existingCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (existingCount > 0) return; // Already migrated

  console.log('[DB] Migrating users from users.json → SQLite...');
  try {
    const raw = fs.readFileSync(usersFile, 'utf8');
    const users = JSON.parse(raw);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO users (email, username, display_name, password, role, created_at)
      VALUES (@email, @username, @display_name, @password, @role, @created_at)
    `);
    const insertMany = db.transaction((list) => {
      for (const u of list) {
        insert.run({
          email:        u.email,
          username:     u.username || u.email.split('@')[0],
          display_name: u.displayName || u.username || u.email.split('@')[0],
          password:     u.password,
          role:         u.role || 'user',
          created_at:   u.createdAt || new Date().toISOString()
        });
      }
    });
    insertMany(users);
    console.log(`[DB] Migrated ${users.length} user(s) successfully.`);

    // Back up the old file so we don't re-migrate on next start
    fs.renameSync(usersFile, usersFile + '.migrated.bak');
    console.log('[DB] users.json backed up as users.json.migrated.bak');
  } catch (err) {
    console.error('[DB] users.json migration failed:', err.message);
  }
}

/**
 * Migrate reports.json → reports table (only runs if table is empty and file exists)
 */
function migrateReportsFromJson() {
  const reportsFile = appDataPath('reports.json');
  if (!fs.existsSync(reportsFile)) return;

  const existingCount = db.prepare('SELECT COUNT(*) as n FROM reports').get().n;
  if (existingCount > 0) return; // Already migrated

  console.log('[DB] Migrating reports from reports.json → SQLite...');
  try {
    const raw = fs.readFileSync(reportsFile, 'utf8');
    const reports = JSON.parse(raw);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO reports
        (id, type, title, description, steps, error_message, stack_trace, detail, app_version, platform, created_at)
      VALUES
        (@id, @type, @title, @description, @steps, @error_message, @stack_trace, @detail, @app_version, @platform, @created_at)
    `);
    const insertMany = db.transaction((list) => {
      for (const r of list) {
        insert.run({
          id:            r.id,
          type:          r.type || 'bug',
          title:         r.title        || null,
          description:   r.description  || null,
          steps:         r.steps        || null,
          error_message: r.errorMessage || null,
          stack_trace:   r.stackTrace   || null,
          detail:        r.detail       || null,
          app_version:   r.appVersion   || null,
          platform:      r.platform     || null,
          created_at:    r.timestamp    || new Date().toISOString()
        });
      }
    });
    insertMany(reports);
    console.log(`[DB] Migrated ${reports.length} report(s) successfully.`);

    fs.renameSync(reportsFile, reportsFile + '.migrated.bak');
    console.log('[DB] reports.json backed up as reports.json.migrated.bak');
  } catch (err) {
    console.error('[DB] reports.json migration failed:', err.message);
  }
}

// Run migrations at startup
migrateUsersFromJson();
migrateReportsFromJson();

// ─── Config helpers ───────────────────────────────────────────────────────────

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { db, getConfig, setConfig };
