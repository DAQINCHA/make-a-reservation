'use strict';
/** SQLite 存储与密码兼容层；只用 Node 内置模块。 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  console.error(`需要 Node.js 22.13 或更高版本（内置 node:sqlite）。当前版本：${process.version}。`);
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'data', 'studio.sqlite');
const EMPTY = {
  rooms: [],
  people: [],
  bookings: [],
  fields: { rooms: [], people: [], bookings: [] },
  hidden: { rooms: [], people: [], bookings: [] },
  columnOrder: { rooms: [], people: [], bookings: [] },
  bookingOrder: 'auto',
};
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, person_id TEXT UNIQUE, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)',
  'CREATE TABLE IF NOT EXISTS avatars (person_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(person_id,seq))',
];

function connect(file = DEFAULT_DB) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=15000');
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}

function passwordHash(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const value = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), 100000, 32, 'sha256').toString('hex');
  return 'pbkdf2$' + salt + '$' + value;
}

function verifyPassword(password, stored) {
  const parts = String(stored == null ? '' : stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const actual = Buffer.from(passwordHash(password, parts[1]), 'utf8');
  const expected = Buffer.from(String(stored), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function initialPasswordPath(file) {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return path.join(path.dirname(file), stem + '.initial-password.txt');
}

function initialize(file = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = connect(file);
  try {
    for (const statement of SCHEMA) db.exec(statement);
    const columns = db.prepare('PRAGMA table_info(users)').all().map((row) => row.name);
    if (!columns.includes('must_change_password')) {
      db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT OR IGNORE INTO workspace VALUES (?, ?, ?)').run('studio', 1, JSON.stringify(EMPTY));
    const row = db.prepare("SELECT payload FROM workspace WHERE id='studio'").get();
    const data = JSON.parse(row.payload);
    const bookings = data.bookings;
    const current = [];
    for (const booking of bookings) {
      if (booking.cancelled) continue;
      const next = {};
      for (const [key, value] of Object.entries(booking)) if (key !== 'cancelled') next[key] = value;
      current.push(next);
    }
    if (JSON.stringify(current) !== JSON.stringify(bookings)) {
      data.bookings = current;
      db.prepare("UPDATE workspace SET revision=revision+1,payload=? WHERE id='studio'").run(JSON.stringify(data));
    }
    if (!db.prepare('SELECT 1 FROM users').get()) {
      const secretPath = initialPasswordPath(file);
      let initial;
      try {
        const fd = fs.openSync(secretPath, 'wx', 0o600);
        try {
          initial = crypto.randomBytes(24).toString('base64url');
          fs.writeSync(fd, initial + '\n');
          fs.fchmodSync(fd, 0o600);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // 首次启动被中断后重试：沿用已写入的初始密码。
        initial = fs.readFileSync(secretPath, 'utf8').trim();
        const length = [...initial].length;
        if (!(length >= 24 && length <= 128)) throw new Error('初始密码文件无效，请检查：' + secretPath);
      }
      db.prepare('INSERT INTO users (id,username,password_hash,role,must_change_password) VALUES (?,?,?,?,1)').run(
        'administrator',
        'admin',
        passwordHash(initial),
        'admin',
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (ignored) {}
    throw error;
  } finally {
    db.close();
  }
  fs.chmodSync(file, 0o600);
}

module.exports = { ROOT, DEFAULT_DB, EMPTY, connect, initialize, passwordHash, verifyPassword, tokenHash, initialPasswordPath };
