'use strict';
const db = require('./db');
const config = require('./config');
const {
  hashPassword, verifyPassword, newToken, randomId, now, slugify,
} = require('./util');

const USERNAME_RE = /^[a-z0-9._-]{2,32}$/i;

const USER_SELECT = `
  SELECT id, username, discriminator, display_name, avatar, banner, bio, accent_color,
         pronouns, created_at, is_bot, is_admin, is_system, disabled, settings
  FROM users`;

function publicUser(row) {
  if (!row) return null;
  let settings = {};
  try { settings = JSON.parse(row.settings || '{}'); } catch { settings = {}; }
  return {
    id: String(row.id),
    username: row.username,
    discriminator: row.discriminator,
    display_name: row.display_name || null,
    tag: `${row.display_name || row.username}#${row.discriminator}`,
    avatar: row.avatar,
    banner: row.banner,
    bio: row.bio || '',
    accent_color: row.accent_color ? Number(row.accent_color) : null,
    pronouns: row.pronouns || '',
    bot: !!row.is_bot,
    system: !!row.is_system,
    admin: !!row.is_admin,
    created_at: row.created_at,
    settings,
  };
}

function findUserById(id) {
  return db.get(`${USER_SELECT} WHERE id = ?`, [Number(id)]);
}

function findUserByUsername(username) {
  return db.get(`${USER_SELECT} WHERE username_lc = ?`, [String(username).toLowerCase()]);
}

function authError(message, code = 'AUTH_FAILED') {
  const err = new Error(message);
  err.status = 401;
  err.code = code;
  return err;
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) {
    const err = new Error('Usernames must be 2-32 characters: letters, numbers, dot, dash or underscore.');
    err.status = 400;
    err.code = 'INVALID_USERNAME';
    throw err;
  }
  if (/^(@|everyone|here)$/i.test(value)) {
    const err = new Error('That username is reserved.');
    err.status = 400;
    err.code = 'RESERVED_USERNAME';
    throw err;
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) {
    const err = new Error('Passwords must be at least 8 characters.');
    err.status = 400;
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  if (value.length > 512) {
    const err = new Error('That password is too long (max 512 characters).');
    err.status = 400;
    err.code = 'LONG_PASSWORD';
    throw err;
  }
  return value;
}

/**
 * Register a user. No email, no phone number, no captcha service — just a
 * username and a password, exactly as it should be on a server you host.
 */
function createUser({ username, password, displayName = null, isAdmin = false, isBot = false, settings = {} }) {
  const name = validateUsername(username);
  const pw = validatePassword(password);
  const lc = name.toLowerCase();
  if (db.get('SELECT 1 FROM users WHERE username_lc = ?', [lc])) {
    const err = new Error('That username is already taken on this server.');
    err.status = 409;
    err.code = 'USERNAME_TAKEN';
    throw err;
  }
  if (config.maxUsers > 0) {
    const { count } = db.get('SELECT COUNT(*) AS count FROM users');
    if (count >= config.maxUsers) {
      const err = new Error('This server has reached its user limit.');
      err.status = 403;
      err.code = 'USER_LIMIT';
      throw err;
    }
  }
  const ts = now();
  // The very first account on a fresh instance owns it. No setup wizard, no
  // config file editing — just sign up and you are the admin.
  const isFirstAccount = db.get('SELECT COUNT(*) AS c FROM users').c === 0;
  const id = db.insert('users', {
    username: name,
    username_lc: lc,
    discriminator: '0000',
    display_name: displayName || name,
    password_hash: hashPassword(pw),
    created_at: ts,
    is_admin: isAdmin || isFirstAccount || config.adminUsers.includes(lc) ? 1 : 0,
    is_bot: isBot ? 1 : 0,
    settings: JSON.stringify(settings),
    last_seen: ts,
  });
  db.markInstalled();
  return findUserById(id);
}

function checkPassword(user, password) {
  return verifyPassword(password, user.password_hash);
}

function createSession(userId, { userAgent = '', ip = '' } = {}) {
  const token = newToken();
  const ts = now();
  db.insert('sessions', {
    token,
    user_id: userId,
    created_at: ts,
    last_used: ts,
    user_agent: String(userAgent).slice(0, 300),
    ip: String(ip).slice(0, 64),
  });
  return token;
}

function touchSession(token) {
  db.run('UPDATE sessions SET last_used = ? WHERE token = ?', [now(), token]);
}

function destroySession(token) {
  db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

function destroyAllSessions(userId) {
  db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

function userFromToken(token) {
  if (!token) return null;
  const row = db.get(
    `SELECT u.*, s.token AS session_token, s.created_at AS session_created
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`, [token]);
  if (!row) return null;
  if (row.disabled) return null;
  const maxAge = config.sessionDays * 86400000;
  if (now() - row.session_created > maxAge) {
    destroySession(token);
    return null;
  }
  return row;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

const COOKIE_NAME = 'bla_session';

function sessionCookie(token, { maxAgeSeconds = config.sessionDays * 86400 } = {}) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

const CLEAR_COOKIE = `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Express middleware: attaches req.user (raw user row) when authenticated. */
function attachUser(req, res, next) {
  const cookieToken = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
  const token = bearer || cookieToken || req.query.token || null;
  req.token = token;
  req.user = token ? userFromToken(token) : null;
  if (req.user) req.userPublic = publicUser(req.user);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'You need to sign in to do that.', code: 'UNAUTHORIZED' });
  }
  next();
}

function makeInviteCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

module.exports = {
  USERNAME_RE, COOKIE_NAME, publicUser, findUserById, findUserByUsername, createUser,
  checkPassword, createSession, touchSession, destroySession, destroyAllSessions,
  userFromToken, parseCookies, sessionCookie, CLEAR_COOKIE, attachUser, requireUser,
  makeInviteCode, validateUsername, validatePassword, randomId, slugify,
};
