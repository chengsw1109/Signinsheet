'use strict';

const { db } = require('./db');
const line = require('./line');
const mailer = require('./mailer');
const gcal = require('./gcal');
const { TZ, tzOffsetMs, localNow, dayRangeUtc, localTimeMs, minutes } = require('./stats');

// ---- 營業時間設定（可用環境變數覆寫）----
const OPEN = process.env.BOOK_OPEN || '10:00';       // 每日最早可約
const CLOSE = process.env.BOOK_CLOSE || '20:00';     // 每日最晚結束
const SLOT_MIN = Number(process.env.BOOK_SLOT_MIN || 30); // 時段間隔（分）
const BOOK_WORKDAYS = new Set(
  (process.env.BOOK_WORKDAYS || '1,2,3,4,5,6').split(',').map(Number)); // 可預約的星期
const ADMIN_IDS = (process.env.LINE_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const fmtLocal = (iso) => new Date(iso).toLocaleString('zh-TW', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const weekdayOfLocalDate = (d) => ((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;

// ---------- 服務項目 ----------
const listServices = (activeOnly = true) =>
  db.prepare(`SELECT * FROM services ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`).all();
const getService = (id) => db.prepare(`SELECT * FROM services WHERE id = ?`).get(id);
function addService({ name, duration_min, price }) {
  const info = db.prepare(`INSERT INTO services (name, duration_min, price) VALUES (?, ?, ?)`)
    .run(String(name).trim(), Number(duration_min) || 60, Number(price) || 0);
  return info.lastInsertRowid;
}
function updateService(id, { name, duration_min, price, active }) {
  db.prepare(`UPDATE services SET name = ?, duration_min = ?, price = ?, active = ? WHERE id = ?`)
    .run(String(name).trim(), Number(duration_min) || 60, Number(price) || 0, active ? 1 : 0, id);
}

// ---------- 可預約時段計算 ----------
// 回傳指定服務、指定日期（當地 YYYY-MM-DD）的可預約起始時刻清單
function availableSlots(serviceId, date) {
  const svc = getService(serviceId);
  if (!svc || !svc.active) return { error: '服務不存在或已停用' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日期格式錯誤' };
  if (!BOOK_WORKDAYS.has(weekdayOfLocalDate(date))) return { slots: [], reason: '當日不開放預約' };

  const dur = svc.duration_min;
  const openMs = localTimeMs(date, OPEN);
  const closeMs = localTimeMs(date, CLOSE);

  // 當日既有預約（未取消），用來排除衝突
  const { startIso, endIso } = dayRangeUtc(date);
  const booked = db.prepare(
    `SELECT start_at, end_at FROM bookings
     WHERE status = 'confirmed' AND start_at < ? AND end_at > ?`
  ).all(endIso, startIso).map((b) => [Date.parse(b.start_at), Date.parse(b.end_at)]);

  const nowMs = Date.now();
  const slots = [];
  for (let t = openMs; t + dur * 60000 <= closeMs; t += SLOT_MIN * 60000) {
    const s = t, e = t + dur * 60000;
    if (s < nowMs) continue; // 不能約過去的時間
    const clash = booked.some(([bs, be]) => s < be && e > bs);
    if (!clash) {
      slots.push({
        start: new Date(s).toISOString(),
        label: new Date(s).toLocaleTimeString('zh-TW', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }),
      });
    }
  }
  return { slots, service: { id: svc.id, name: svc.name, duration_min: dur, price: svc.price } };
}

// ---------- 建立預約 ----------
async function createBooking({ service_id, customer_name, phone, email, line_user_id, note, start }) {
  const svc = getService(service_id);
  if (!svc || !svc.active) return { error: '服務不存在或已停用' };
  if (!String(customer_name || '').trim()) return { error: '請填寫姓名' };
  if (!String(phone || '').trim() && !String(email || '').trim())
    return { error: '請至少留下電話或 Email 其中一項' };
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return { error: '預約時間格式錯誤' };
  if (startMs < Date.now()) return { error: '不能預約過去的時間' };
  const endMs = startMs + svc.duration_min * 60000;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  // 再次確認時段未被搶先預約（避免同時送出）
  const clash = db.prepare(
    `SELECT COUNT(*) c FROM bookings WHERE status = 'confirmed' AND start_at < ? AND end_at > ?`
  ).get(endIso, startIso).c;
  if (clash > 0) return { error: '此時段剛剛已被預約，請選擇其他時間' };

  const info = db.prepare(
    `INSERT INTO bookings (service_id, customer_name, phone, email, line_user_id, note, start_at, end_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(svc.id, String(customer_name).trim(), String(phone || '').trim(), String(email || '').trim(),
        line_user_id || null, String(note || '').slice(0, 500), startIso, endIso, new Date().toISOString());
  const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(info.lastInsertRowid);

  // 各通知管道皆非阻塞，任一失敗不影響預約成立
  fanoutNotifications(booking, svc).catch((e) => console.error('預約通知失敗:', e));
  return { booking, service: svc };
}

async function fanoutNotifications(booking, svc) {
  const when = fmtLocal(booking.start_at);
  const priceStr = svc.price ? `\n費用：${svc.price} 元` : '';

  // 1) 加入 Google 日曆
  const eventId = await gcal.createEvent({
    summary: `${svc.name} - ${booking.customer_name}`,
    description: `客戶：${booking.customer_name}\n電話：${booking.phone || '-'}\nEmail：${booking.email || '-'}\n備註：${booking.note || '-'}`,
    startIso: booking.start_at,
    endIso: booking.end_at,
  });
  if (eventId) db.prepare(`UPDATE bookings SET gcal_event_id = ? WHERE id = ?`).run(eventId, booking.id);

  // 2) Email 給客戶
  if (booking.email) {
    await mailer.send(booking.email, `預約確認：${svc.name}`,
      `${booking.customer_name} 您好，\n\n您的預約已成立：\n服務：${svc.name}\n時間：${when}${priceStr}\n\n如需變更或取消，請與我們聯繫。感謝您的預約！`);
  }

  // 3) LINE 通知客戶（若預約時帶入其 LINE ID）
  if (booking.line_user_id) {
    await line.pushText(booking.line_user_id,
      `✅ 預約成功！\n服務：${svc.name}\n時間：${when}${priceStr}\n\n期待為您服務 😊`);
  }

  // 4) LINE 通知管理員
  for (const id of ADMIN_IDS) {
    await line.pushText(id,
      `🔔 新預約\n服務：${svc.name}\n客戶：${booking.customer_name}\n電話：${booking.phone || '-'}\n時間：${when}`);
  }
}

// ---------- 查詢與取消 ----------
function listBookings({ from, to, status } = {}) {
  const cond = [], args = [];
  if (from) { const r = dayRangeUtc(from); cond.push(`b.start_at >= ?`); args.push(r.startIso); }
  if (to) { const r = dayRangeUtc(to); cond.push(`b.start_at < ?`); args.push(r.endIso); }
  if (status) { cond.push(`b.status = ?`); args.push(status); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return db.prepare(
    `SELECT b.*, s.name AS service_name FROM bookings b JOIN services s ON s.id = b.service_id
     ${where} ORDER BY b.start_at DESC LIMIT 500`).all(...args);
}

async function cancelBooking(id) {
  const b = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
  if (!b) return { error: '查無此預約' };
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(id);
  if (b.gcal_event_id) gcal.deleteEvent(b.gcal_event_id).catch(() => {});
  const svc = getService(b.service_id);
  const when = fmtLocal(b.start_at);
  if (b.email) mailer.send(b.email, `預約已取消：${svc.name}`,
    `${b.customer_name} 您好，您的預約（${svc.name}，${when}）已取消。`).catch(() => {});
  if (b.line_user_id) line.pushText(b.line_user_id,
    `⚠️ 您的預約已取消\n服務：${svc.name}\n時間：${when}`).catch(() => {});
  return { ok: true };
}

const config = () => ({ open: OPEN, close: CLOSE, slot_min: SLOT_MIN, workdays: [...BOOK_WORKDAYS] });

module.exports = {
  listServices, getService, addService, updateService,
  availableSlots, createBooking, listBookings, cancelBooking, config,
};
