'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const serialize = require('../serialize');
const { rateLimit } = require('../ratelimit');

const router = express.Router();

/** Resolve a user by id, @username, or username#0000. */
function resolveUser(identifier) {
  const value = decodeURIComponent(String(identifier || '').trim());
  if (/^\d+$/.test(value)) return db.get('SELECT * FROM users WHERE id = ?', [Number(value)]);
  const [name] = value.split('#');
  return db.get('SELECT * FROM users WHERE username_lc = ?', [name.replace(/^@/, '').toLowerCase()]);
}

/** The identifier "me"/"@me" always means the caller. */
function resolveRequestUser(req) {
  const raw = String(req.params.userId || '').toLowerCase();
  if (raw === 'me' || raw === '@me') return req.user;
  return resolveUser(req.params.userId);
}

router.get('/:userId', auth.requireUser, (req, res) => {
  const user = resolveRequestUser(req);
  if (!user) return res.status(404).json({ error: 'No user with that name on this server.', code: 'UNKNOWN_USER' });

  const mutualGuilds = db.all(
    `SELECT g.id, g.name, g.icon FROM guilds g
     JOIN guild_members m1 ON m1.guild_id = g.id AND m1.user_id = ?
     JOIN guild_members m2 ON m2.guild_id = g.id AND m2.user_id = ?
     ORDER BY g.name LIMIT 50`, [req.user.id, user.id]);

  const relationship = db.get('SELECT type FROM relationships WHERE user_id = ? AND target_id = ?', [req.user.id, user.id]);
  const memberships = db.all(
    `SELECT gm.guild_id, gm.nickname, gm.joined_at, gm.role_ids FROM guild_members gm WHERE gm.user_id = ? LIMIT 200`, [user.id]);

  res.json({
    user: serialize.serializeUser(user),
    mutual_guilds: mutualGuilds.map((g) => ({ id: String(g.id), name: g.name, icon: g.icon })),
    mutual_guild_count: mutualGuilds.length,
    relationship_type: relationship ? relationship.type : null,
    memberships: memberships.map((m) => ({
      guild_id: String(m.guild_id),
      nickname: m.nickname,
      joined_at: m.joined_at,
      roles: JSON.parse(m.role_ids || '[]').map(String),
    })),
  });
});

router.get('/:userId/profile', auth.requireUser, (req, res) => {
  const user = resolveRequestUser(req);
  if (!user) return res.status(404).json({ error: 'No user with that name on this server.', code: 'UNKNOWN_USER' });
  const guildIds = db.all('SELECT guild_id FROM guild_members WHERE user_id = ?', [user.id]).map((r) => r.guild_id);
  const mutual = guildIds.length
    ? db.all(
      `SELECT g.id, g.name, g.icon, gm.nickname, gm.joined_at, gm.role_ids
       FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id AND gm.user_id = ?
       WHERE g.id IN (${guildIds.map(() => '?').join(',')})`, [user.id, ...guildIds])
    : [];
  res.json({
    user: serialize.serializeUser(user),
    profile: { bio: user.bio, pronouns: user.pronouns, banner: user.banner, accent_color: user.accent_color },
    mutual_guilds: mutual.map((m) => ({
      id: String(m.id), name: m.name, icon: m.icon, nickname: m.nickname,
      joined_at: m.joined_at, roles: JSON.parse(m.role_ids || '[]').map(String),
    })),
  });
});

/** Search the local directory by username or display name. */
router.get('/', auth.requireUser, rateLimit({ key: 'user-search', max: 120, windowMs: 60000 }), (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  let rows;
  if (!q) {
    rows = db.all(
      `SELECT id, username, discriminator, display_name, avatar, banner, bio, accent_color, is_bot, created_at
       FROM users WHERE disabled = 0 ORDER BY created_at DESC LIMIT ?`, [limit]);
  } else {
    const like = `%${q.toLowerCase()}%`;
    rows = db.all(
      `SELECT id, username, discriminator, display_name, avatar, banner, bio, accent_color, is_bot, created_at
       FROM users WHERE disabled = 0 AND (username_lc LIKE ? OR LOWER(display_name) LIKE ?)
       ORDER BY username_lc LIMIT ?`, [like, like, limit]);
  }
  res.json({ users: rows.map((r) => serialize.serializeUser(r)) });
});

/** Servers this user is in (used by the profile popout and the member list). */
router.get('/:userId/guilds', auth.requireUser, (req, res) => {
  const user = resolveRequestUser(req);
  if (!user) return res.status(404).json({ error: 'Unknown user.', code: 'UNKNOWN_USER' });
  const shared = db.all(
    `SELECT g.id, g.name, g.icon FROM guilds g
     JOIN guild_members a ON a.guild_id = g.id AND a.user_id = ?
     JOIN guild_members b ON b.guild_id = g.id AND b.user_id = ?`, [req.user.id, user.id]);
  const all = db.all(
    `SELECT g.id, g.name, g.icon FROM guilds g JOIN guild_members m ON m.guild_id = g.id WHERE m.user_id = ?`,
    [user.id]);
  const sharedIds = new Set(shared.map((g) => g.id));
  res.json({
    shared: shared.map((g) => ({ id: String(g.id), name: g.name, icon: g.icon })),
    all: all.filter((g) => !sharedIds.has(g.id)).map((g) => ({ id: String(g.id), name: g.name, icon: g.icon })),
    max_guilds: config.maxGuildsPerUser,
  });
});

module.exports = router;
