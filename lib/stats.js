'use strict';

const { db } = require('./db');

// ---- 出勤統計共用設定與時區工具（記錄以 UTC 儲存，統計以 TZ 當地時間為準）----
const TZ = process.env.TZ_NAME || 'Asia/Taipei';
const WORK_START = process.env.WORK_START || '09:00';
const LATE_GRACE_MIN = Number(process.env.LATE_GRACE_MIN || 0);
const WORKDAYS = new Set((process.env.WORKDAYS || '1,2,3,4,5').split(',').map(Number)); // 1=週一

function tzOffsetMs(d = new Date()) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return Date.parse(s.replace(' ', 'T') + 'Z') - d.getTime();
}
function localNow(d = new Date()) {
  const l = new Date(d.getTime() + tzOffsetMs(d));
  return {
    date: l.toISOString().slice(0, 10),
    hhmm: l.toISOString().slice(11, 16),
    weekday: ((l.getUTCDay() + 6) % 7) + 1,
  };
}
// 當地某日 00:00 起算的 UTC ISO 區間 [start, end)
function dayRangeUtc(localDate, days = 1) {
  const start = Date.parse(`${localDate}T00:00:00Z`) - tzOffsetMs();
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(start + days * 86400000).toISOString(),
  };
}
// 當地某日某時刻的 UTC 毫秒
function localTimeMs(localDate, hhmm) {
  return Date.parse(`${localDate}T${hhmm}:00Z`) - tzOffsetMs();
}
const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fmtTime = (iso) => new Date(iso).toLocaleString('zh-TW', {
  timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

const lateThresholdMs = (date) => localTimeMs(date, WORK_START) + LATE_GRACE_MIN * 60000;
const weekdayOfLocalDate = (dateStr) => ((new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;

// ---- 日統計：每人當日簽到/簽退時間、遲到、工時、狀態 ----
function dailyDetail(date) {
  const { startIso, endIso } = dayRangeUtc(date);
  const persons = db.prepare(`SELECT * FROM persons WHERE active = 1 ORDER BY emp_no`).all();
  const rows = [];
  for (const p of persons) {
    const firstIn = db.prepare(
      `SELECT MIN(scanned_at) m FROM records WHERE person_id = ? AND action = 'in'
       AND scanned_at >= ? AND scanned_at < ?`).get(p.id, startIso, endIso)?.m || null;
    const lastOut = db.prepare(
      `SELECT MAX(scanned_at) m FROM records WHERE person_id = ? AND action = 'out'
       AND scanned_at >= ? AND scanned_at < ?`).get(p.id, startIso, endIso)?.m || null;
    const late = firstIn ? Date.parse(firstIn) > lateThresholdMs(date) : false;
    let workMinutes = null;
    if (firstIn && lastOut && Date.parse(lastOut) > Date.parse(firstIn)) {
      workMinutes = Math.round((Date.parse(lastOut) - Date.parse(firstIn)) / 60000);
    }
    rows.push({
      emp_no: p.emp_no, name: p.name, dept: p.dept,
      first_in: firstIn, last_out: lastOut, late, work_minutes: workMinutes,
      status: !firstIn ? 'absent' : (!lastOut ? 'no_out' : 'done'),
    });
  }
  return rows;
}

// ---- 月報表：每人出勤天數、遲到次數、缺勤工作日、總工時 ----
function monthlyReport(month /* 'YYYY-MM' */) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const { startIso, endIso } = dayRangeUtc(`${month}-01`, daysInMonth);
  const off = tzOffsetMs();
  const today = localNow().date;

  // 該月已經過的工作日數（統計當月時只算到今天）
  let workdaysElapsed = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${month}-${String(d).padStart(2, '0')}`;
    if (ds > today) break;
    if (WORKDAYS.has(weekdayOfLocalDate(ds))) workdaysElapsed += 1;
  }

  const persons = db.prepare(`SELECT * FROM persons WHERE active = 1 ORDER BY emp_no`).all();
  const rows = [];
  for (const p of persons) {
    const recs = db.prepare(
      `SELECT action, scanned_at FROM records WHERE person_id = ?
       AND scanned_at >= ? AND scanned_at < ? ORDER BY scanned_at`).all(p.id, startIso, endIso);
    const byDay = new Map();
    for (const r of recs) {
      const day = new Date(Date.parse(r.scanned_at) + off).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, { firstIn: null, lastOut: null });
      const v = byDay.get(day);
      if (r.action === 'in' && !v.firstIn) v.firstIn = r.scanned_at;
      if (r.action === 'out') v.lastOut = r.scanned_at;
    }
    let attendDays = 0, lateCount = 0, totalMinutes = 0, workdayAttend = 0;
    for (const [day, v] of byDay) {
      if (!v.firstIn) continue;
      attendDays += 1;
      if (WORKDAYS.has(weekdayOfLocalDate(day))) workdayAttend += 1;
      if (Date.parse(v.firstIn) > lateThresholdMs(day)) lateCount += 1;
      if (v.lastOut && Date.parse(v.lastOut) > Date.parse(v.firstIn)) {
        totalMinutes += Math.round((Date.parse(v.lastOut) - Date.parse(v.firstIn)) / 60000);
      }
    }
    rows.push({
      emp_no: p.emp_no, name: p.name, dept: p.dept,
      attend_days: attendDays, late_count: lateCount,
      absent_workdays: Math.max(workdaysElapsed - workdayAttend, 0),
      total_minutes: totalMinutes,
    });
  }
  return { month, workdays_elapsed: workdaysElapsed, rows };
}

module.exports = {
  TZ, WORK_START, LATE_GRACE_MIN, WORKDAYS,
  tzOffsetMs, localNow, dayRangeUtc, localTimeMs, minutes, fmtTime,
  dailyDetail, monthlyReport,
};
