'use strict';

const crypto = require('crypto');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const SECRET = process.env.LINE_CHANNEL_SECRET || '';

const enabled = () => Boolean(TOKEN);

async function send(endpoint, body) {
  if (!TOKEN) {
    // 未設定 LINE 金鑰時以模擬模式記錄，方便本機測試
    console.log(`[LINE 模擬 ${endpoint}]`, JSON.stringify(body, null, 2));
    return true;
  }
  try {
    const res = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`LINE ${endpoint} 失敗:`, res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error(`LINE ${endpoint} 錯誤:`, e.message);
    return false;
  }
}

async function pushText(to, text) {
  if (!to || !text) return false;
  return send('push', { to, messages: [{ type: 'text', text: String(text).slice(0, 5000) }] });
}

async function replyText(replyToken, text) {
  if (!replyToken) return false;
  return send('reply', { replyToken, messages: [{ type: 'text', text: String(text).slice(0, 5000) }] });
}

function verifySignature(rawBody, signature) {
  if (!SECRET || !rawBody) return false;
  const mac = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(mac), b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { enabled, pushText, replyText, verifySignature };
