'use strict';
const crypto = require('crypto');

/** Short, URL-safe random id (for sessions, invites, webhooks, filenames). */
function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomDigits(n) {
  let out = '';
  while (out.length < n) out += crypto.randomInt(0, 10).toString();
  return out;
}

function now() {
  return Date.now();
}

function scrypt(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Hash a password. Format: scrypt$N$r$p$salt$hash (all hex). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = scrypt(String(password), salt);
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Constant-time compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Escape a string for safe inclusion in HTML text/attributes. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(input, fallback = 'channel') {
  const s = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return s || fallback;
}

function parseId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** "3 hours ago"-ish relative time, used by the API for compact payloads. */
function relativeTime(ts) {
  const diff = Date.now() - Number(ts);
  const units = [
    ['y', 31536000000], ['mo', 2592000000], ['w', 604800000], ['d', 86400000],
    ['h', 3600000], ['m', 60000], ['s', 1000],
  ];
  for (const [label, ms] of units) {
    if (diff >= ms) return `${Math.floor(diff / ms)}${label}`;
  }
  return 'now';
}

function isSnowflakeLike(value) {
  return /^\d{5,25}$/.test(String(value));
}

module.exports = {
  randomId, randomDigits, now, hashPassword, verifyPassword, newToken, safeEqual,
  clamp, escapeHtml, slugify, parseId, relativeTime, isSnowflakeLike,
};
