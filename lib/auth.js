'use strict';

const crypto = require('crypto');

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${h}`;
}

function verifyPin(pin, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(calc, 'hex'));
}

function randomPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

module.exports = { hashPin, verifyPin, randomPin };
