'use strict';
const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const { rateLimit } = require('../ratelimit');
const settings = require('../settings');
const { now } = require('../util');
const gate = require('../gate');

const router = express.Router();

/** Public instance info: the frontend uses this to render the login screen. */
router.get('/config', (req, res) => {
  const installed = db.getMeta('installed_at') !== null;
  const { count } = db.get('SELECT COUNT(*) AS count FROM users');
  res.json({
    server_name: settings.get('server_name'),
    registration_open: settings.get('registration_open'),
    invite_only: settings.get('invite_only'),
    welcome_message: settings.get('welcome_message'),
    motd: settings.get('motd'),
    installed,
    user_count: count,
    max_upload_mb: settings.get('max_upload_mb'),
    max_avatar_mb: Math.round(config.maxAvatarBytes / (1024 * 1024)),
    max_guilds_per_user: settings.get('max_guilds_per_user'),
    max_emoji_per_guild: config.maxEmojiPerGuild,
    voice_enabled: config.voiceEnabled,
    stun_servers: config.stunServers,
    features: {
      free_accounts: true,
      no_email_required: true,
      unlimited_free_servers: true,
      all_boost_perks_unlocked: true,
      voice: config.voiceEnabled,
      video: config.voiceEnabled,
      screenshare: config.voiceEnabled,
      custom_emoji: true,
      animated_emoji: true,
      stickers: true,
      soundboard: true,
      vanity_urls: true,
      server_banner: true,
      threads: false,
      polls: true,
      webhooks: true,
      audit_log: true,
    },
  });
});

const registerLimiter = rateLimit({
  key: 'register', max: 12, windowMs: 15 * 60000,
  message: 'Too many accounts created from this address. Try again later.',
});
const loginLimiter = rateLimit({
  key: 'login', max: 20, windowMs: 15 * 60000,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
});

/** Open signup: username + password. No email, no phone, no third parties. */
router.post('/register', registerLimiter, (req, res) => {
  if (!settings.get('registration_open')) {
    return res.status(403).json({ error: 'Sign-ups are currently closed on this server.', code: 'REGISTRATION_CLOSED' });
  }

  const body = req.body || {};
  const inviteCode = body.invite ? String(body.invite).trim() : null;

  if (settings.get('invite_only')) {
    const invite = inviteCode ? db.get('SELECT * FROM invites WHERE code = ?', [inviteCode]) : null;
    const valid = invite && (invite.max_uses === 0 || invite.uses < invite.max_uses) &&
      (!invite.expires_at || invite.expires_at > now());
    if (!valid) {
      return res.status(403).json({ error: 'This server is invite-only. You need a valid invite code to sign up.', code: 'INVITE_REQUIRED' });
    }
  }

  const user = auth.createUser({
    username: body.username,
    password: body.password,
    displayName: typeof body.display_name === 'string' ? body.display_name.trim().slice(0, 32) : null,
  });

  if (inviteCode) {
    const invite = db.get('SELECT * FROM invites WHERE code = ?', [inviteCode]);
    if (invite && invite.guild_id) {
      try {
        require('../guilds').addMember(invite.guild_id, user.id, { invitedBy: invite.inviter_id });
        db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', [inviteCode]);
        require('../guilds').postSystemMessage(invite.guild_id, `${user.display_name || user.username} joined the server.`);
      } catch { /* guild may be gone; signup still succeeds */ }
    }
  }

  const token = auth.createSession(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
  res.status(201).json({ token, user: auth.publicUser(user) });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const row = username ? db.get('SELECT * FROM users WHERE username_lc = ?', [String(username).trim().toLowerCase()]) : null;
  if (!row || !auth.checkPassword(row, password || '')) {
    return res.status(401).json({ error: 'Incorrect username or password.', code: 'INVALID_CREDENTIALS' });
  }
  if (row.disabled) {
    return res.status(403).json({ error: row.ban_reason || 'This account has been disabled by the server admin.', code: 'ACCOUNT_DISABLED' });
  }
  const token = auth.createSession(row.id, { userAgent: req.headers['user-agent'], ip: req.ip });
  db.run('UPDATE users SET last_seen = ? WHERE id = ?', [now(), row.id]);
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
  res.json({ token, user: auth.publicUser(row) });
});

router.post('/logout', (req, res) => {
  if (req.token) auth.destroySession(req.token);
  res.setHeader('Set-Cookie', auth.CLEAR_COOKIE);
  res.json({ ok: true });
});

router.get('/me', auth.requireUser, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

/** Profile editing: display name, bio, pronouns, accent colour, avatar/banner. */
router.patch('/me', auth.requireUser, (req, res) => {
  const body = req.body || {};
  const updates = {};

  if (body.display_name !== undefined) {
    const name = String(body.display_name || '').trim().slice(0, 32);
    updates.display_name = name || req.user.username;
  }
  if (body.bio !== undefined) updates.bio = String(body.bio || '').slice(0, 512);
  if (body.pronouns !== undefined) updates.pronouns = String(body.pronouns || '').slice(0, 32);
  if (body.accent_color !== undefined) {
    const raw = body.accent_color;
    if (raw === null || raw === '') updates.accent_color = null;
    else {
      const n = typeof raw === 'string' && raw.startsWith('#') ? parseInt(raw.slice(1), 16) : Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 0xffffff) {
        return res.status(400).json({ error: 'accent_color must be a hex colour like #5865f2.', code: 'INVALID_COLOR' });
      }
      updates.accent_color = String(Math.trunc(n));
    }
  }
  if (body.avatar !== undefined) {
    if (body.avatar === null || body.avatar === '') updates.avatar = null;
    else if (!gate.isValidUrl(body.avatar)) return res.status(400).json({ error: 'avatar must be an uploaded image URL.', code: 'INVALID_AVATAR' });
    else updates.avatar = String(body.avatar).slice(0, 500);
  }
  if (body.banner !== undefined) {
    if (body.banner === null || body.banner === '') updates.banner = null;
    else if (!gate.isValidUrl(body.banner)) return res.status(400).json({ error: 'banner must be an uploaded image URL.', code: 'INVALID_BANNER' });
    else updates.banner = String(body.banner).slice(0, 500);
  }
  if (body.settings && typeof body.settings === 'object') {
    const current = (() => { try { return JSON.parse(req.user.settings || '{}'); } catch { return {}; } })();
    const merged = { ...current };
    for (const [k, v] of Object.entries(body.settings)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) merged[k] = v;
    }
    updates.settings = JSON.stringify(merged).slice(0, 8000);
  }

  // Password change keeps the current session but kills every other one.
  if (body.new_password !== undefined) {
    if (!auth.checkPassword(req.user, body.current_password || '')) {
      return res.status(403).json({ error: 'Your current password is incorrect.', code: 'BAD_PASSWORD' });
    }
    auth.validatePassword(body.new_password);
    updates.password_hash = require('../util').hashPassword(String(body.new_password));
    updates.token_version = (req.user.token_version || 0) + 1;
  }

  if (Object.keys(updates).length) db.update('users', req.user.id, updates);
  if (body.new_password !== undefined) {
    db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [req.user.id, req.token]);
  }

  const fresh = auth.findUserById(req.user.id);
  res.json({ user: auth.publicUser(fresh) });
});

router.get('/sessions', auth.requireUser, (req, res) => {
  const rows = db.all('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used DESC', [req.user.id]);
  res.json({
    sessions: rows.map((s) => ({
      id: s.token.slice(0, 12),
      current: s.token === req.token,
      created_at: s.created_at,
      last_used: s.last_used,
      user_agent: s.user_agent,
      ip: s.ip,
    })),
  });
});

router.delete('/sessions/:prefix', auth.requireUser, (req, res) => {
  const rows = db.all('SELECT token FROM sessions WHERE user_id = ?', [req.user.id]);
  const target = rows.find((r) => r.token.slice(0, 12) === req.params.prefix);
  if (!target) return res.status(404).json({ error: 'Session not found.', code: 'UNKNOWN_SESSION' });
  auth.destroySession(target.token);
  res.json({ ok: true });
});

/** Delete your own account. Owned servers are transferred or removed. */
router.delete('/me', auth.requireUser, (req, res) => {
  const body = req.body || {};
  if (!auth.checkPassword(req.user, body.password || '')) {
    return res.status(403).json({ error: 'Enter your password to delete your account.', code: 'BAD_PASSWORD' });
  }
  const owned = db.all('SELECT id, name FROM guilds WHERE owner_id = ?', [req.user.id]);
  for (const guild of owned) {
    const next = db.get(
      `SELECT user_id FROM guild_members WHERE guild_id = ? AND user_id != ?
       ORDER BY joined_at ASC LIMIT 1`, [guild.id, req.user.id]);
    if (next) {
      db.run('UPDATE guilds SET owner_id = ? WHERE id = ?', [next.user_id, guild.id]);
    } else {
      db.run('DELETE FROM guilds WHERE id = ?', [guild.id]);
    }
  }
  db.run('DELETE FROM users WHERE id = ?', [req.user.id]);
  res.setHeader('Set-Cookie', auth.CLEAR_COOKIE);
  res.json({ ok: true });
});

module.exports = router;
