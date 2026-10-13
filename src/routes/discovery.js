'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const perms = require('../perms');
const serialize = require('../serialize');
const { intOr } = require('../gate');

const router = express.Router();

/** The public server directory. Every Bla server can be discovered by default. */
router.get('/', auth.requireUser, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(50, intOr(req.query.limit, 24)));
  const offset = Math.max(0, intOr(req.query.offset, 0));

  const guilds = db.all(
    `SELECT g.*, (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id) AS member_count
     FROM guilds g
     WHERE g.discovery = 1 ${q ? 'AND (LOWER(g.name) LIKE ? OR LOWER(g.description) LIKE ? OR LOWER(g.tags) LIKE ?)' : ''}
     ORDER BY member_count DESC, g.id DESC
     LIMIT ? OFFSET ?`,
    q ? [`%${q}%`, `%${q}%`, `%${q}%`, limit, offset] : [limit, offset]);

  const total = db.get(
    `SELECT COUNT(*) AS c FROM guilds WHERE discovery = 1 ${q ? 'AND (LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ?)' : ''}`,
    q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []).c;

  res.json({
    guilds: guilds.map((g) => {
      const mine = perms.getMember(g.id, req.user.id);
      return {
        id: String(g.id),
        name: g.name,
        icon: g.icon,
        banner: g.banner,
        description: g.description || '',
        vanity_url: g.vanity_url,
        tags: serialize.safeJson(g.tags, []),
        member_count: g.member_count,
        boost_level: 3,
        created_at: g.created_at,
        already_member: !!mine,
      };
    }),
    total,
    has_more: offset + guilds.length < total,
  });
});

/** Preview before joining. */
router.get('/:guildId', auth.requireUser, (req, res) => {
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [Number(req.params.guildId)]);
  if (!guild) return res.status(404).json({ error: 'Unknown server.', code: 'UNKNOWN_GUILD' });
  const preview = require('./invites').publicGuild(guild);
  res.json({
    ...preview,
    already_member: !!perms.getMember(guild.id, req.user.id),
    joinable: !!guild.discovery,
    discovery: !!guild.discovery,
  });
});

/** Join a discoverable server directly — no invite code needed. */
router.post('/:guildId/join', auth.requireUser, (req, res) => {
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [Number(req.params.guildId)]);
  if (!guild) return res.status(404).json({ error: 'Unknown server.', code: 'UNKNOWN_GUILD' });
  if (!guild.discovery) {
    return res.status(403).json({ error: 'That server is not listed in the directory. You need an invite.', code: 'NOT_DISCOVERABLE' });
  }
  if (perms.getMember(guild.id, req.user.id)) {
    return res.json({ guild_id: String(guild.id), already_member: true });
  }
  const guilds = require('../guilds');
  guilds.addMember(guild.id, req.user.id, {});
  const bus = require('../bus');
  bus.toUser(req.user.id, {
    type: 'GUILD_CREATE',
    data: require('../guildState').guildPayload(guild, req.user.id, { isAdmin: req.user.is_admin }),
  });
  bus.toGuild(guild.id, {
    type: 'GUILD_MEMBER_ADD',
    data: { guild_id: String(guild.id), user: serialize.userBrief(req.user), member_count: serialize.memberCount(guild.id) },
  });
  res.json({ guild_id: String(guild.id) });
});

module.exports = router;
