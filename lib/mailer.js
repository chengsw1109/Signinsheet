'use strict';

// Email 寄送（選用）：設定 SMTP 環境變數後啟用，未設定時為模擬模式（只寫 log）。
const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || USER;

let transporter = null;
if (HOST && USER && PASS) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465, // 465 用 SSL，其餘（如 587）用 STARTTLS
    auth: { user: USER, pass: PASS },
  });
}

const enabled = () => Boolean(transporter);

async function send(to, subject, text) {
  if (!to) return false;
  if (!transporter) {
    console.log(`[Email 模擬] 收件：${to}\n主旨：${subject}\n${text}`);
    return true;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, text });
    return true;
  } catch (e) {
    console.error('Email 寄送失敗:', e.message);
    return false;
  }
}

module.exports = { enabled, send };
