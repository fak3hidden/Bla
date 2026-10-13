'use strict';
const express = require('express');
const os = require('os');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const settings = require('../settings');
const serialize = require('../serialize');
const guildsModule = require('../guilds');
const { rateLimit } = require('../ratelimit');
const { now, randomId } = require('../util');
const { flag } = require('../gate');

const router = express.Router();
router.use(auth.requireUser);

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Instance admin only.', code: 'NOT_ADMIN' });
  }
  next();
}

router.use(requireAdmin);

/** Instance health + counts. */
router.get('/stats', (req, res) => {
  const counts = {
    users: db.get('SELECT COUNT(*) AS c FROM users').c,
    bots: db.get('SELECT COUNT(*) AS c FROM users WHERE is_bot = 1').c,
    guilds: db.get('SELECT COUNT(*) AS c FROM guilds').c,
    channels: db.get('SELECT COUNT(*) AS c FROM channels').c,
    messages: db.get('SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NULL').c,
    attachments: db.get('SELECT COUNT(*) AS c FROM attachments').c,
    sessions: db.get('SELECT COUNT(*) AS c FROM sessions').c,
    in_voice: db.get('SELECT COUNT(*) AS c FROM voice_states').c,
  };
  let mediaBytes = 0;
  try {
    for (const file of fs.readdirSync(config.uploadDir)) {
      mediaBytes += fs.statSync(`${config.uploadDir}/${file}`).size;
    }
  } catch { mediaBytes = 0; }

  let dbBytes = 0;
  try { dbBytes = fs.statSync(config.dbFile).size; } catch { dbBytes = 0; }

  res.json({
    counts,
    storage: { media_bytes: mediaBytes, database_bytes: dbBytes, upload_dir: config.uploadDir },
    process: {
      uptime_seconds: Math.floor(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
      pid: process.pid,
      platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length,
      load: os.loadavg().map((n) => Number(n.toFixed(2))),
    },
    config: {
      server_name: settings.get('server_name'),
      registration_open: settings.get('registration_open'),
      invite_only: settings.get('invite_only'),
      max_upload_mb: settings.get('max_upload_mb'),
      max_guilds_per_user: settings.get('max_guilds_per_user'),
      voice_enabled: config.voiceEnabled,
      stun_servers: config.stunServers,
      data_dir: config.dataDir,
    },
    install: {
      installed_at: Number(db.getMeta('installed_at') || 0),
      schema_version: Number(db.getMeta('schema_version') || 1),
    },
  });
});

router.get('/settings', (req, res) => {
  res.json({
    settings: settings.all(),
    definitions: Object.entries(settings.OVERRIDABLE).map(([key, spec]) => ({
      key, type: spec.type, label: spec.label, value: settings.get(key),
    })),
  });
});

router.patch('/settings', (req, res) => {
  const updates = {};
  for (const [key, value] of Object.entries(req.body || {})) {
    try { updates[key] = settings.set(key, value); } catch (err) { return res.status(err.status || 400).json({ error: err.message, code: err.code }); }
  }
  res.json({ settings: updates });
});

/** User management. */
router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const rows = db.all(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.created_at, u.is_admin, u.is_bot, u.disabled,
            u.ban_reason, u.last_seen,
            (SELECT COUNT(*) FROM guild_members m WHERE m.user_id = u.id) AS guild_count,
            (SELECT COUNT(*) FROM messages msg WHERE msg.author_id = u.id AND msg.deleted_at IS NULL) AS message_count
     FROM users u
     ${q ? 'WHERE u.username_lc LIKE ? OR LOWER(u.display_name) LIKE ?' : ''}
     ORDER BY u.id DESC LIMIT ?`,
    q ? [`%${q}%`, `%${q}%`, limit] : [limit]);
  res.json({ users: rows.map((row) => ({ ...serialize.userBrief(row), disabled: !!row.disabled, admin: !!row.is_admin, guild_count: row.guild_count, message_count: row.message_count, created_at: row.created_at, last_seen: row.last_seen, ban_reason: row.ban_reason })) });
});

router.patch('/users/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'Unknown user.', code: 'UNKNOWN_USER' });
  const body = req.body || {};
  const updates = {};
  if (body.disabled !== undefined) {
    updates.disabled = flag(body.disabled) ? 1 : 0;
    updates.ban_reason = body.ban_reason ? String(body.ban_reason).slice(0, 300) : null;
    if (flag(body.disabled)) db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  if (body.admin !== undefined) updates.is_admin = flag(body.admin) ? 1 : 0;
  if (body.reset_password !== undefined) {
    auth.validatePassword(body.reset_password);
    updates.password_hash = require('../util').hashPassword(String(body.reset_password));
    db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  if (Object.keys(updates).length) db.update('users', userId, updates);
  const fresh = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  res.json({ user: { ...auth.publicUser(fresh), disabled: !!fresh.disabled } });
});

router.delete('/users/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  if (userId === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account here.', code: 'SELF_DELETE' });
  const owned = db.all('SELECT id FROM guilds WHERE owner_id = ?', [userId]);
  db.tx(() => {
    for (const guild of owned) {
      const next = db.get('SELECT user_id FROM guild_members WHERE guild_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1', [guild.id, userId]);
      if (next) db.run('UPDATE guilds SET owner_id = ? WHERE id = ?', [next.user_id, guild.id]);
      else db.run('DELETE FROM guilds WHERE id = ?', [guild.id]);
    }
    db.run('DELETE FROM users WHERE id = ?', [userId]);
  });
  res.json({ ok: true });
});

/** Server management. */
router.get('/guilds', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const rows = db.all(
    `SELECT g.*, (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id) AS member_count,
            (SELECT COUNT(*) FROM messages msg WHERE msg.guild_id = g.id) AS message_count,
            o.username AS owner_username, o.display_name AS owner_display_name
     FROM guilds g LEFT JOIN users o ON o.id = g.owner_id
     ${q ? 'WHERE LOWER(g.name) LIKE ?' : ''}
     ORDER BY g.id DESC LIMIT ?`,
    q ? [`%${q}%`, limit] : [limit]);
  res.json({
    guilds: rows.map((g) => ({
      id: String(g.id),
      name: g.name,
      icon: g.icon,
      owner_id: String(g.owner_id),
      owner: g.owner_username,
      member_count: g.member_count,
      message_count: g.message_count,
      discovery: !!g.discovery,
      vanity_url: g.vanity_url,
      created_at: g.created_at,
    })),
  });
});

router.delete('/guilds/:guildId', (req, res) => {
  const guildId = Number(req.params.guildId);
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [guildId]);
  if (!guild) return res.status(404).json({ error: 'Unknown server.', code: 'UNKNOWN_GUILD' });
  require('../bus').toGuild(guildId, { type: 'GUILD_DELETE', data: { id: String(guildId) } });
  guildsModule.deleteGuild(guildId);
  res.json({ ok: true });
});

/** Instance invite links (for invite-only instances). */
router.get('/instance-invites', (req, res) => {
  const rows = db.all(
    `SELECT i.*, u.username FROM invites i LEFT JOIN users u ON u.id = i.inviter_id
     WHERE i.guild_id IS NULL ORDER BY i.created_at DESC`);
  res.json({ invites: rows.map((r) => ({ code: r.code, uses: r.uses, max_uses: r.max_uses, created_at: r.created_at, inviter: r.username })) });
});

router.post('/instance-invites', (req, res) => {
  const body = req.body || {};
  const code = randomId(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  db.insert('invites', {
    code, guild_id: null, channel_id: null, inviter_id: req.user.id,
    max_uses: Math.max(0, Number(body.max_uses) || 0), max_age: 0, temporary: 0,
    created_at: now(), expires_at: null,
  });
  res.status(201).json({ code, url: `${config.publicUrl || ''}/#/register?invite=${code}` });
});

/** Database maintenance. */
router.post('/maintenance/vacuum', (req, res) => {
  db.run('VACUUM');
  res.json({ ok: true });
});

router.post('/maintenance/purge-orphan-uploads', (req, res) => {
  const cutoff = now() - 24 * 3600000;
  const orphans = db.all('SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ?', [cutoff]);
  for (const orphan of orphans) {
    try { fs.unlinkSync(`${config.uploadDir}/${require('path').basename(orphan.stored_name)}`); } catch { /* ignore */ }
    db.run('DELETE FROM attachments WHERE id = ?', [orphan.id]);
  }
  res.json({ ok: true, purged: orphans.length });
});

router.use(rateLimit({ key: 'admin', max: 600, windowMs: 60000 }));

module.exports = router;
