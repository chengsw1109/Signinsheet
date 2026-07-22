'use strict';

// Google 日曆（選用）：使用「服務帳戶」將預約寫入指定日曆。
// 設定方式（未設定時為模擬模式，只寫 log，不影響預約）：
//   1. 在 Google Cloud 建立服務帳戶，下載 JSON 金鑰
//   2. GOOGLE_SERVICE_ACCOUNT_JSON = 該 JSON 檔路徑
//   3. 在 Google 日曆設定把日曆「共用」給服務帳戶的 client_email（權限：變更活動）
//   4. GOOGLE_CALENDAR_ID = 該日曆 ID（個人日曆通常是你的 Gmail）
const fs = require('fs');
const crypto = require('crypto');

const TZ = process.env.TZ_NAME || 'Asia/Taipei';
const CAL_ID = process.env.GOOGLE_CALENDAR_ID || '';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

let creds = null;
if (KEY_PATH && CAL_ID && fs.existsSync(KEY_PATH)) {
  try {
    creds = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    if (!creds.client_email || !creds.private_key) creds = null;
  } catch { creds = null; }
}

const enabled = () => Boolean(creds);
const b64u = (s) => Buffer.from(s).toString('base64url');

let cachedToken = null; // { token, exp }

async function getAccessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256')
    .update(`${header}.${claim}`).sign(creds.private_key).toString('base64url');
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google 授權失敗：' + JSON.stringify(data));
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

// 建立日曆活動，回傳 event id（失敗回 null，不中斷預約流程）
async function createEvent({ summary, description, startIso, endIso }) {
  if (!creds) {
    console.log(`[Google 日曆 模擬] 建立活動：${summary}（${startIso} ~ ${endIso}）`);
    return null;
  }
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary,
          description,
          start: { dateTime: startIso, timeZone: TZ },
          end: { dateTime: endIso, timeZone: TZ },
        }),
      });
    const data = await res.json();
    if (!res.ok) { console.error('Google 日曆建立失敗:', JSON.stringify(data)); return null; }
    return data.id || null;
  } catch (e) {
    console.error('Google 日曆錯誤:', e.message);
    return null;
  }
}

async function deleteEvent(eventId) {
  if (!creds || !eventId) return;
  try {
    const token = await getAccessToken();
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    console.error('Google 日曆刪除失敗:', e.message);
  }
}

module.exports = { enabled, createEvent, deleteEvent };
