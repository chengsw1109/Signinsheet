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
async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = `signin-${localStamp()}.db`;
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

module.exports = { runBackup, backupStatus, latestBackupPath, startScheduler };
