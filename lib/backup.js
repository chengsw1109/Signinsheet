'use strict';

const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const { tzOffsetMs, localNow, minutes } = require('./stats');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_TIME = process.env.BACKUP_TIME || '03:00'; // 每日自動備份時間
const BACKUP_KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30); // 保留天數

const getSetting = (k) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k)?.value;
const setSetting = (k, v) => db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
).run(k, String(v));

const localStamp = () =>
  new Date(Date.now() + tzOffsetMs()).toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');

// 執行一次備份（使用 SQLite 線上備份 API，執行中系統可照常使用）
// tag 用於區分特殊備份（如還原前的安全備份），避免與一般備份同名互相覆蓋
async function runBackup(tag = '') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = `signin-${localStamp()}${tag ? '-' + tag : ''}.db`;
  const dest = path.join(BACKUP_DIR, file);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await db.backup(dest);

  // 簽章金鑰一併留存（還原後舊條碼簽章仍可驗證）
  const keySrc = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keySrc)) fs.copyFileSync(keySrc, path.join(BACKUP_DIR, 'secret.key'));

  // 清除超過保留天數的舊備份
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!/^signin-.*\.db$/.test(f)) continue;
    const p = path.join(BACKUP_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }

  const size = fs.statSync(dest).size;
  setSetting('backup:last', JSON.stringify({ file, size, at: new Date().toISOString() }));
  console.log(`[備份] 已建立 ${file}（${(size / 1024).toFixed(0)} KB）`);
  return { file, size, at: new Date().toISOString() };
}

// 備份狀態：最新一筆與總數
function backupStatus() {
  let files = [];
  if (fs.existsSync(BACKUP_DIR)) {
    files = fs.readdirSync(BACKUP_DIR).filter((f) => /^signin-.*\.db$/.test(f)).sort();
  }
  const last = getSetting('backup:last');
  return {
    count: files.length,
    latest: last ? JSON.parse(last) : null,
    schedule_time: BACKUP_TIME,
    keep_days: BACKUP_KEEP_DAYS,
  };
}

// 最新備份檔完整路徑（供下載）
function latestBackupPath() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^signin-.*\.db$/.test(f)).sort();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

// 合法備份檔名（防路徑跳脫），並回傳完整路徑
function resolveBackupFile(file) {
  if (!/^[\w.-]+\.db$/.test(String(file || ''))) return null;
  const p = path.join(BACKUP_DIR, file);
  return fs.existsSync(p) ? p : null;
}

// 列出所有備份檔（新到舊）
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// 驗證備份檔：是簽到系統的 SQLite 檔且未損毀，回傳內容摘要
function validateBackupFile(p) {
  const Database = require('better-sqlite3');
  let src;
  try {
    src = new Database(p, { readonly: true, fileMustExist: true });
    const tables = src.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((t) => t.name);
    if (!tables.includes('persons') || !tables.includes('records')) {
      return { error: '這不是簽到系統的備份檔（缺少必要資料表）' };
    }
    const chk = src.prepare(`PRAGMA quick_check`).get();
    if (Object.values(chk)[0] !== 'ok') return { error: '備份檔已損毀，無法還原' };
    return {
      persons: src.prepare(`SELECT COUNT(*) c FROM persons`).get().c,
      records: src.prepare(`SELECT COUNT(*) c FROM records`).get().c,
    };
  } catch {
    return { error: '無法讀取備份檔（不是有效的 SQLite 資料庫）' };
  } finally {
    if (src) src.close();
  }
}

// 儲存上傳的備份檔（驗證通過才保留）
function saveUploadedBackup(buffer) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = `uploaded-${localStamp()}.db`;
  const p = path.join(BACKUP_DIR, file);
  fs.writeFileSync(p, buffer);
  const info = validateBackupFile(p);
  if (info.error) {
    fs.unlinkSync(p);
    return { error: info.error };
  }
  return { file, ...info };
}

// 線上還原：以備份內容取代 persons 與 records（不需停機）
// 還原前自動先備份現況；登入狀態（sessions）保留，操作者不會被登出
async function restoreBackup(file) {
  const p = resolveBackupFile(file);
  if (!p) throw new Error('找不到指定的備份檔');
  const info = validateBackupFile(p);
  if (info.error) throw new Error(info.error);

  const safety = await runBackup('pre-restore'); // 先備份現況，還原錯了可以再還原回來

  db.exec(`ATTACH '${p.replace(/'/g, "''")}' AS src`);
  try {
    const commonCols = (table) => {
      const cur = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const bak = db.prepare(`PRAGMA src.table_info(${table})`).all().map((c) => c.name);
      return cur.filter((c) => bak.includes(c)).join(', ');
    };
    db.transaction(() => {
      db.prepare(`DELETE FROM records`).run();
      db.prepare(`DELETE FROM persons`).run();
      const pc = commonCols('persons');
      db.prepare(`INSERT INTO persons (${pc}) SELECT ${pc} FROM src.persons`).run();
      const rc = commonCols('records');
      db.prepare(`INSERT INTO records (${rc}) SELECT ${rc} FROM src.records`).run();
    })();
  } finally {
    db.exec(`DETACH src`);
  }
  console.log(`[備份] 已從 ${file} 還原（人員 ${info.persons}、記錄 ${info.records}），還原前現況已存為 ${safety.file}`);
  return { restored: file, persons: info.persons, records: info.records, safety: safety.file };
}

// 刪除指定備份檔
function deleteBackup(file) {
  const p = resolveBackupFile(file);
  if (!p) throw new Error('找不到指定的備份檔');
  fs.unlinkSync(p);
  return { deleted: file };
}

// 每日自動備份排程（每天執行，含週末）
function startScheduler() {
  setInterval(() => {
    const local = localNow();
    const t = minutes(BACKUP_TIME), c = minutes(local.hhmm);
    if (c >= t && c < t + 60 && !getSetting(`job:backup:${local.date}`)) {
      setSetting(`job:backup:${local.date}`, '1');
      runBackup().catch((e) => console.error('[備份] 自動備份失敗:', e));
    }
  }, 60 * 1000).unref();
  console.log(`資料庫自動備份已啟動：每日 ${BACKUP_TIME}，保留 ${BACKUP_KEEP_DAYS} 天（目錄：${BACKUP_DIR}）`);
}

module.exports = {
  runBackup, backupStatus, latestBackupPath, startScheduler,
  listBackups, resolveBackupFile, saveUploadedBackup, restoreBackup, deleteBackup,
};
