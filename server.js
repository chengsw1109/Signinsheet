'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { db, DATA_DIR } = require('./lib/db');
const { hashPin, verifyPin, randomPin } = require('./lib/auth');
const line = require('./lib/line');
const notify = require('./lib/notify');
const stats = require('./lib/stats');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TOKEN_TTL_MS = 60 * 1000;          // 動態條碼有效時間
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REJOIN_GAP_MS = 16 * 60 * 60 * 1000; // 超過此間隔一律視為新的「簽到」

// ---- 伺服器簽章金鑰（持久化，重啟後舊條碼仍可驗證）----
const secretFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
const SERVER_SECRET = Buffer.from(fs.readFileSync(secretFile, 'utf8').trim(), 'hex');

const app = express();
// 保留原始 body 供 LINE webhook 簽章驗證
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/html5-qrcode.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/html5-qrcode/html5-qrcode.min.js')));

// ---------- 工具 ----------
const nowIso = () => new Date().toISOString();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function createSession(kind, personId = null) {
  const token = b64u(crypto.randomBytes(24));
  db.prepare(`INSERT INTO sessions (token, kind, person_id, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(token, kind, personId, nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return token;
}
function getSession(req, kind) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM sessions WHERE token = ? AND kind = ?`).get(token, kind);
  if (!s || s.expires_at < nowIso()) return null;
  return s;
}
function requireAdmin(req, res, next) {
  if (!getSession(req, 'admin')) return res.status(401).json({ error: '請先以管理員身分登入' });
  next();
}
function requirePhone(req, res, next) {
  const s = getSession(req, 'phone');
  if (!s) return res.status(401).json({ error: '登入已過期，請重新登入' });
  const person = db.prepare(`SELECT * FROM persons WHERE id = ? AND active = 1`).get(s.person_id);
  if (!person) return res.status(401).json({ error: '帳號已停用' });
  req.person = person;
  next();
}

// ---- 動態條碼 token：payload.簽章，60 秒有效、nonce 一次性 ----
function issueQrToken(personId) {
  const payload = JSON.stringify({
    uid: personId,
    exp: Date.now() + TOKEN_TTL_MS,
    nonce: b64u(crypto.randomBytes(9)),
  });
  const body = b64u(payload);
  const sig = b64u(crypto.createHmac('sha256', SERVER_SECRET).update(body).digest());
  return `SIS1.${body}.${sig}`;
}
function verifyQrToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'SIS1') return { error: '條碼格式不正確' };
  const [, body, sig] = parts;
  const expect = b64u(crypto.createHmac('sha256', SERVER_SECRET).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: '條碼驗證失敗' };
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return { error: '條碼內容毀損' }; }
  if (!payload.uid || !payload.exp || !payload.nonce) return { error: '條碼內容不完整' };
  if (Date.now() > payload.exp) return { error: '條碼已過期，請使用手機上最新的條碼' };
  const inserted = db.prepare(`INSERT OR IGNORE INTO used_nonces (nonce, used_at) VALUES (?, ?)`)
    .run(payload.nonce, Date.now());
  if (inserted.changes === 0) return { error: '此條碼已被使用過（重複掃描）' };
  return { payload };
}

// 定期清理過期資料
setInterval(() => {
  db.prepare(`DELETE FROM used_nonces WHERE used_at < ?`).run(Date.now() - 10 * 60 * 1000);
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(nowIso());
}, 5 * 60 * 1000).unref();

// ---------- 個人手機端 ----------
app.post('/api/phone/login', (req, res) => {
  const { emp_no, pin } = req.body || {};
  const person = db.prepare(`SELECT * FROM persons WHERE emp_no = ? AND active = 1`).get(String(emp_no || '').trim());
  if (!person || !verifyPin(pin, person.pin_hash)) {
    return res.status(401).json({ error: '工號或 PIN 碼錯誤' });
  }
  const token = createSession('phone', person.id);
  res.json({ session: token, person: { name: person.name, emp_no: person.emp_no, dept: person.dept } });
});

app.get('/api/phone/qr', requirePhone, async (req, res) => {
  const token = issueQrToken(req.person.id);
  const dataUrl = await QRCode.toDataURL(token, { width: 320, margin: 1 });
  res.json({ qr: dataUrl, ttl_ms: TOKEN_TTL_MS });
});

app.get('/api/phone/records', requirePhone, (req, res) => {
  const rows = db.prepare(
    `SELECT action, station, lat, lng, scanned_at FROM records
     WHERE person_id = ? ORDER BY scanned_at DESC LIMIT 20`).all(req.person.id);
  res.json({ records: rows });
});

// ---------- 掃描站（需管理員登入）----------
app.post('/api/scan', requireAdmin, (req, res) => {
  const { token, station, lat, lng, mode } = req.body || {};
  const { payload, error } = verifyQrToken(token);
  if (error) return res.status(400).json({ error });

  const person = db.prepare(`SELECT * FROM persons WHERE id = ? AND active = 1`).get(payload.uid);
  if (!person) return res.status(404).json({ error: '查無此人員或帳號已停用' });

  let action = mode === 'in' || mode === 'out' ? mode : null;
  if (!action) {
    const last = db.prepare(
      `SELECT action, scanned_at FROM records WHERE person_id = ? ORDER BY scanned_at DESC LIMIT 1`
    ).get(person.id);
    const lastMs = last ? Date.parse(last.scanned_at) : 0;
    action = (last && last.action === 'in' && Date.now() - lastMs < REJOIN_GAP_MS) ? 'out' : 'in';
  }

  const scannedAt = nowIso();
  const stationName = String(station || '').slice(0, 100);
  db.prepare(`INSERT INTO records (person_id, action, station, lat, lng, scanned_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(person.id, action, stationName,
         Number.isFinite(Number(lat)) ? Number(lat) : null,
         Number.isFinite(Number(lng)) ? Number(lng) : null,
         scannedAt);

  // 非同步發送 LINE 簽到退通知，不影響掃描回應速度
  notify.notifyScan(person, action, stationName, scannedAt)
    .catch((e) => console.error('LINE 通知失敗:', e));

  res.json({
    ok: true, action, scanned_at: scannedAt,
    person: { name: person.name, emp_no: person.emp_no, dept: person.dept },
  });
});

// ---------- 管理端 ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '管理員密碼錯誤' });
  }
  res.json({ session: createSession('admin') });
});

app.get('/api/admin/persons', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT id, emp_no, name, dept, active, created_at,
            (line_user_id IS NOT NULL) AS line_bound
     FROM persons ORDER BY emp_no`).all();
  res.json({ persons: rows });
});

app.post('/api/admin/persons/:id/unbind-line', requireAdmin, (req, res) => {
  const info = db.prepare(`UPDATE persons SET line_user_id = NULL WHERE id = ?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: '查無此人員' });
  res.json({ ok: true });
});

// ---------- LINE Webhook（好友加入、綁定指令）----------
app.post('/api/line/webhook', (req, res) => {
  if (!line.verifySignature(req.rawBody, req.get('x-line-signature'))) {
    return res.status(403).send('signature verification failed');
  }
  res.sendStatus(200);
  for (const ev of (req.body && req.body.events) || []) {
    notify.handleLineEvent(ev).catch((e) => console.error('LINE 事件處理失敗:', e));
  }
});

app.post('/api/admin/persons', requireAdmin, (req, res) => {
  const { emp_no, name, dept } = req.body || {};
  if (!String(emp_no || '').trim() || !String(name || '').trim()) {
    return res.status(400).json({ error: '工號與姓名為必填' });
  }
  const pin = randomPin();
  try {
    const info = db.prepare(`INSERT INTO persons (emp_no, name, dept, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(String(emp_no).trim(), String(name).trim(), String(dept || '').trim(), hashPin(pin), nowIso());
    res.json({ id: info.lastInsertRowid, pin });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '此工號已存在' });
    throw e;
  }
});

app.post('/api/admin/persons/:id/reset-pin', requireAdmin, (req, res) => {
  const pin = randomPin();
  const info = db.prepare(`UPDATE persons SET pin_hash = ? WHERE id = ?`).run(hashPin(pin), req.params.id);
  if (!info.changes) return res.status(404).json({ error: '查無此人員' });
  res.json({ pin });
});

app.post('/api/admin/persons/:id/active', requireAdmin, (req, res) => {
  const active = req.body && req.body.active ? 1 : 0;
  const info = db.prepare(`UPDATE persons SET active = ? WHERE id = ?`).run(active, req.params.id);
  if (!info.changes) return res.status(404).json({ error: '查無此人員' });
  res.json({ ok: true });
});

function queryRecords(q) {
  const cond = [];
  const args = [];
  if (q.from) { cond.push(`r.scanned_at >= ?`); args.push(new Date(q.from).toISOString()); }
  if (q.to) { cond.push(`r.scanned_at <= ?`); args.push(new Date(new Date(q.to).getTime() + 86399999).toISOString()); }
  if (q.q) { cond.push(`(p.name LIKE ? OR p.emp_no LIKE ?)`); args.push(`%${q.q}%`, `%${q.q}%`); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return db.prepare(
    `SELECT r.id, p.emp_no, p.name, p.dept, r.action, r.station, r.lat, r.lng, r.scanned_at
     FROM records r JOIN persons p ON p.id = r.person_id
     ${where} ORDER BY r.scanned_at DESC LIMIT 2000`).all(...args);
}

app.get('/api/admin/records', requireAdmin, (req, res) => {
  res.json({ records: queryRecords(req.query) });
});

// ---------- 出勤統計 ----------
app.get('/api/admin/stats/daily', requireAdmin, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : stats.localNow().date;
  res.json({ date, work_start: stats.WORK_START, rows: stats.dailyDetail(date) });
});

app.get('/api/admin/stats/monthly', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : stats.localNow().date.slice(0, 7);
  res.json(stats.monthlyReport(month));
});

app.get('/api/admin/stats/monthly.csv', (req, res) => {
  const s = db.prepare(`SELECT * FROM sessions WHERE token = ? AND kind = 'admin'`).get(req.query.session || '');
  if (!s || s.expires_at < nowIso()) return res.status(401).send('unauthorized');
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : stats.localNow().date.slice(0, 7);
  const report = stats.monthlyReport(month);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [`月份,${month},已過工作日,${report.workdays_elapsed}`, '工號,姓名,部門,出勤天數,遲到次數,缺勤工作日,總工時(小時)'];
  for (const r of report.rows) {
    lines.push([r.emp_no, r.name, r.dept, r.attend_days, r.late_count,
      r.absent_workdays, (r.total_minutes / 60).toFixed(1)].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="attendance-${month}.csv"`);
  res.send('\ufeff' + lines.join('\r\n'));
});

app.get('/api/admin/records.csv', (req, res) => {
  // CSV 下載透過網址列 session 參數驗證（瀏覽器下載無法帶 Authorization 標頭）
  const s = db.prepare(`SELECT * FROM sessions WHERE token = ? AND kind = 'admin'`).get(req.query.session || '');
  if (!s || s.expires_at < nowIso()) return res.status(401).send('unauthorized');
  const rows = queryRecords(req.query);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['工號,姓名,部門,動作,站點,緯度,經度,時間'];
  for (const r of rows) {
    lines.push([r.emp_no, r.name, r.dept, r.action === 'in' ? '簽到' : '簽退',
      r.station, r.lat ?? '', r.lng ?? '', r.scanned_at].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="records.csv"');
  res.send('\ufeff' + lines.join('\r\n'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '伺服器發生錯誤' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`簽到退系統已啟動： http://localhost:${PORT}`));
  notify.startScheduler();
}
module.exports = app;
