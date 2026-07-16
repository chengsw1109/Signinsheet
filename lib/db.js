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
`);

module.exports = { db, DATA_DIR };
