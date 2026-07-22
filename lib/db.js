'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'signin.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS persons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  dept       TEXT NOT NULL DEFAULT '',
  pin_hash   TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,              -- 'phone' | 'admin'
  person_id  INTEGER,                    -- phone 登入時對應人員
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS used_nonces (
  nonce   TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES persons(id),
  action     TEXT NOT NULL,              -- 'in' | 'out'
  station    TEXT NOT NULL DEFAULT '',
  lat        REAL,
  lng        REAL,
  scanned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_person_time ON records(person_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_records_time ON records(scanned_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 預約：服務項目
CREATE TABLE IF NOT EXISTS services (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  price        INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- 預約：客戶預約單
CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id    INTEGER NOT NULL REFERENCES services(id),
  customer_name TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  line_user_id  TEXT,
  note          TEXT NOT NULL DEFAULT '',
  start_at      TEXT NOT NULL,          -- ISO UTC
  end_at        TEXT NOT NULL,          -- ISO UTC
  status        TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
  gcal_event_id TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_service ON bookings(service_id, start_at);
`);

// 既有資料庫升級：persons 加入 LINE 綁定欄位
const personCols = db.prepare(`PRAGMA table_info(persons)`).all();
if (!personCols.some((c) => c.name === 'line_user_id')) {
  db.exec(`ALTER TABLE persons ADD COLUMN line_user_id TEXT`);
}

module.exports = { db, DATA_DIR };
