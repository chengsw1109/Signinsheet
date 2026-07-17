'use strict';

const { db } = require('./db');
const line = require('./line');
const { verifyPin } = require('./auth');
const {
  TZ, WORK_START, LATE_GRACE_MIN, WORKDAYS,
  tzOffsetMs, localNow, dayRangeUtc, localTimeMs, minutes, fmtTime,
} = require('./stats');

// ---- 排程時間設定（皆可用環境變數覆寫）----
const LATE_REMIND_TIME = process.env.LATE_REMIND_TIME || '09:15';       // 未簽到（遲到）提醒
const CHECKOUT_REMIND_TIME = process.env.CHECKOUT_REMIND_TIME || '18:30'; // 未簽退提醒
const DAILY_SUMMARY_TIME = process.env.DAILY_SUMMARY_TIME || '19:00';   // 每日統計推播
const MONTHLY_REPORT_TIME = process.env.MONTHLY_REPORT_TIME || '09:00'; // 每月 1 日報表推播
const ADMIN_IDS = (process.env.LINE_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const getSetting = (k) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k)?.value;
const setSetting = (k, v) => db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
).run(k, String(v));

// ---------- 1+2. 簽到／簽退即時通知（掃描成功後呼叫）----------
async function notifyScan(person, action, station, scannedAtIso) {
  if (!person.line_user_id) return;
  const when = fmtTime(scannedAtIso);
  const where = station ? `\n地點：${station}` : '';
  if (action === 'in') {
    const { date } = localNow(new Date(scannedAtIso));
    const late = Date.parse(scannedAtIso) > localTimeMs(date, WORK_START) + LATE_GRACE_MIN * 60000;
    await line.pushText(person.line_user_id,
      `✅ 上班簽到成功\n${person.name}（${person.emp_no}）\n時間：${when}${where}` +
      (late ? `\n⚠️ 已逾上班時間 ${WORK_START}，本次記錄為遲到` : ''));
  } else {
    const { startIso, endIso } = dayRangeUtc(localNow(new Date(scannedAtIso)).date);
    const first = db.prepare(
      `SELECT MIN(scanned_at) m FROM records
       WHERE person_id = ? AND action = 'in' AND scanned_at >= ? AND scanned_at < ?`
    ).get(person.id, startIso, endIso)?.m;
    let hours = '';
    if (first) {
      const min = Math.round((Date.parse(scannedAtIso) - Date.parse(first)) / 60000);
      hours = `\n今日工時：${Math.floor(min / 60)} 小時 ${min % 60} 分鐘`;
    }
    await line.pushText(person.line_user_id,
      `👋 下班簽退成功\n${person.name}（${person.emp_no}）\n時間：${when}${where}${hours}`);
  }
}

// ---------- 3. 遲到提醒：上班時間後仍未簽到的人 ----------
async function jobLateReminder(now = new Date()) {
  const { date } = localNow(now);
  const { startIso, endIso } = dayRangeUtc(date);
  const rows = db.prepare(
    `SELECT * FROM persons p WHERE p.active = 1 AND p.line_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM records r WHERE r.person_id = p.id
                     AND r.action = 'in' AND r.scanned_at >= ? AND r.scanned_at < ?)`
  ).all(startIso, endIso);
  for (const p of rows) {
    await line.pushText(p.line_user_id,
      `⏰ 遲到提醒\n${p.name} 您好，今日（${date}）尚未簽到，上班時間為 ${WORK_START}。\n若已到班請儘速至掃描站簽到；如休假請忽略此訊息。`);
  }
  return rows.length;
}

// ---------- 4. 未簽退提醒：今天有簽到、但最後一筆不是簽退的人 ----------
async function jobCheckoutReminder(now = new Date()) {
  const { date } = localNow(now);
  const { startIso, endIso } = dayRangeUtc(date);
  const rows = db.prepare(
    `SELECT p.* FROM persons p WHERE p.active = 1 AND p.line_user_id IS NOT NULL
     AND (SELECT r.action FROM records r WHERE r.person_id = p.id
          AND r.scanned_at >= ? AND r.scanned_at < ?
          ORDER BY r.scanned_at DESC LIMIT 1) = 'in'`
  ).all(startIso, endIso);
  for (const p of rows) {
    await line.pushText(p.line_user_id,
      `🔔 未簽退提醒\n${p.name} 您好，您今日（${date}）已簽到但尚未簽退。\n下班離開前請記得至掃描站簽退。`);
  }
  return rows.length;
}

// ---------- 每日出勤統計資料（供每日推播與月報共用）----------
function dailyStats(date) {
  const { startIso, endIso } = dayRangeUtc(date);
  const lateAfterMs = localTimeMs(date, WORK_START) + LATE_GRACE_MIN * 60000;
  const persons = db.prepare(`SELECT * FROM persons WHERE active = 1`).all();
  const stats = { date, total: persons.length, signedIn: [], late: [], absent: [], notSignedOut: [] };
  for (const p of persons) {
    const first = db.prepare(
      `SELECT MIN(scanned_at) m FROM records WHERE person_id = ? AND action = 'in'
       AND scanned_at >= ? AND scanned_at < ?`).get(p.id, startIso, endIso)?.m;
    if (!first) { stats.absent.push(p); continue; }
    stats.signedIn.push(p);
    if (Date.parse(first) > lateAfterMs) stats.late.push(p);
    const last = db.prepare(
      `SELECT action FROM records WHERE person_id = ? AND scanned_at >= ? AND scanned_at < ?
       ORDER BY scanned_at DESC LIMIT 1`).get(p.id, startIso, endIso);
    if (last && last.action === 'in') stats.notSignedOut.push(p);
  }
  return stats;
}

const nameList = (arr) => arr.length ? arr.map((p) => p.name).join('、') : '無';

// ---------- 5. 每日簽到統計（推播給管理員）----------
async function jobDailySummary(now = new Date()) {
  if (!ADMIN_IDS.length) return 0;
  const s = dailyStats(localNow(now).date);
  const text =
    `📊 每日出勤統計 ${s.date}\n` +
    `應出勤：${s.total} 人\n` +
    `已簽到：${s.signedIn.length} 人\n` +
    `遲到：${s.late.length} 人（${nameList(s.late)}）\n` +
    `未簽到：${s.absent.length} 人（${nameList(s.absent)}）\n` +
    `未簽退：${s.notSignedOut.length} 人（${nameList(s.notSignedOut)}）`;
  for (const id of ADMIN_IDS) await line.pushText(id, text);
  return ADMIN_IDS.length;
}

// ---------- 6. 每月出勤報表（每月 1 日推播上個月報表給管理員）----------
async function jobMonthlyReport(now = new Date()) {
  if (!ADMIN_IDS.length) return 0;
  const { date } = localNow(now);
  const [y, m] = date.split('-').map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const monthStr = `${prevY}-${String(prevM).padStart(2, '0')}`;
  const daysInMonth = new Date(prevY, prevM, 0).getDate();
  const { startIso, endIso } = dayRangeUtc(`${monthStr}-01`, daysInMonth);
  const off = tzOffsetMs();

  const persons = db.prepare(`SELECT * FROM persons WHERE active = 1 ORDER BY emp_no`).all();
  const lines = [`📈 ${prevY} 年 ${prevM} 月出勤報表`];
  for (const p of persons) {
    const rows = db.prepare(
      `SELECT action, scanned_at FROM records WHERE person_id = ?
       AND scanned_at >= ? AND scanned_at < ? AND action = 'in'
       ORDER BY scanned_at`).all(p.id, startIso, endIso);
    const firstInByDay = new Map();
    for (const r of rows) {
      const day = new Date(Date.parse(r.scanned_at) + off).toISOString().slice(0, 10);
      if (!firstInByDay.has(day)) firstInByDay.set(day, r.scanned_at);
    }
    let lateDays = 0;
    for (const [day, iso] of firstInByDay) {
      if (Date.parse(iso) > localTimeMs(day, WORK_START) + LATE_GRACE_MIN * 60000) lateDays += 1;
    }
    lines.push(`${p.name}（${p.emp_no}）：出勤 ${firstInByDay.size} 天，遲到 ${lateDays} 次`);
  }
  const text = lines.join('\n');
  for (const id of ADMIN_IDS) await line.pushText(id, text);
  return ADMIN_IDS.length;
}

// ---------- LINE Webhook 事件處理（好友加入、綁定指令）----------
const HELP =
  `您好！這是簽到退系統通知帳號，可用指令：\n` +
  `・綁定 工號 PIN碼 → 綁定本人帳號（例：綁定 A001 123456）\n` +
  `・查詢 → 查看今日簽到退記錄\n` +
  `・解除綁定 → 停止接收通知\n` +
  `綁定後即可收到簽到／簽退通知與提醒。`;

async function handleLineEvent(ev) {
  const uid = ev.source && ev.source.userId;
  const reply = (text) => ev.replyToken ? line.replyText(ev.replyToken, text) : line.pushText(uid, text);

  if (ev.type === 'follow') return reply(HELP);
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !uid) return;
  const text = String(ev.message.text || '').trim();

  let m;
  if ((m = text.match(/^綁定\s+(\S+)\s+(\S+)$/))) {
    const person = db.prepare(`SELECT * FROM persons WHERE emp_no = ? AND active = 1`).get(m[1]);
    if (!person || !verifyPin(m[2], person.pin_hash)) return reply('工號或 PIN 碼錯誤，綁定失敗。');
    db.prepare(`UPDATE persons SET line_user_id = NULL WHERE line_user_id = ?`).run(uid);
    db.prepare(`UPDATE persons SET line_user_id = ? WHERE id = ?`).run(uid, person.id);
    return reply(`✅ 綁定成功！\n${person.name}（${person.emp_no}）\n之後簽到退時會收到 LINE 通知。`);
  }
  if (/^(解綁|解除綁定)$/.test(text)) {
    db.prepare(`UPDATE persons SET line_user_id = NULL WHERE line_user_id = ?`).run(uid);
    return reply('已解除綁定，不會再收到通知。');
  }
  if (/^查詢$/.test(text)) {
    const p = db.prepare(`SELECT * FROM persons WHERE line_user_id = ?`).get(uid);
    if (!p) return reply('尚未綁定帳號。' + '\n\n' + HELP);
    const { startIso, endIso } = dayRangeUtc(localNow().date);
    const rows = db.prepare(
      `SELECT action, station, scanned_at FROM records WHERE person_id = ?
       AND scanned_at >= ? AND scanned_at < ? ORDER BY scanned_at`).all(p.id, startIso, endIso);
    if (!rows.length) return reply(`${p.name} 您好，今日尚無簽到退記錄。`);
    const list = rows.map((r) =>
      `${r.action === 'in' ? '✅ 簽到' : '👋 簽退'} ${fmtTime(r.scanned_at)}${r.station ? '（' + r.station + '）' : ''}`).join('\n');
    return reply(`${p.name} 今日記錄：\n${list}`);
  }
  if (/^(id|ID|我的id|我的ID)$/.test(text)) {
    return reply(`您的 LINE ID：\n${uid}\n（管理員可將此 ID 加入 LINE_ADMIN_IDS 以接收統計報表）`);
  }
  return reply(HELP);
}

// ---------- 排程器：每 30 秒檢查一次是否有到點的工作 ----------
function tick(now = new Date()) {
  const local = localNow(now);
  const runIfDue = (name, target, workdayOnly, fn) => {
    if (workdayOnly && !WORKDAYS.has(local.weekday)) return;
    const t = minutes(target), c = minutes(local.hhmm);
    // 到點後 60 分鐘內執行一次（容忍伺服器短暫重啟），以 settings 防止重複
    if (c >= t && c < t + 60 && !getSetting(`job:${name}:${local.date}`)) {
      setSetting(`job:${name}:${local.date}`, '1');
      Promise.resolve(fn(now)).catch((e) => console.error(`排程 ${name} 執行失敗:`, e));
    }
  };
  runIfDue('late', LATE_REMIND_TIME, true, jobLateReminder);
  runIfDue('checkout', CHECKOUT_REMIND_TIME, true, jobCheckoutReminder);
  runIfDue('daily', DAILY_SUMMARY_TIME, true, jobDailySummary);
  if (local.date.endsWith('-01')) runIfDue('monthly', MONTHLY_REPORT_TIME, false, jobMonthlyReport);
}

function startScheduler() {
  setInterval(() => tick(), 30 * 1000).unref();
  console.log(`LINE 通知排程已啟動（時區 ${TZ}）：遲到提醒 ${LATE_REMIND_TIME}、未簽退提醒 ${CHECKOUT_REMIND_TIME}、每日統計 ${DAILY_SUMMARY_TIME}、每月 1 日報表 ${MONTHLY_REPORT_TIME}${line.enabled() ? '' : '（尚未設定 LINE 金鑰，目前為模擬模式）'}`);
}

module.exports = {
  notifyScan, handleLineEvent, startScheduler, tick,
  jobLateReminder, jobCheckoutReminder, jobDailySummary, jobMonthlyReport, dailyStats,
};
