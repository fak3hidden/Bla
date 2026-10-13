'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const guilds = require('../guilds');
const perms = require('../perms');
const serialize = require('../serialize');
const bus = require('../bus');
const { now } = require('../util');
const { flag } = require('../gate');

const router = express.Router();

function findInvite(code) {
  const invite = db.get('SELECT * FROM invites WHERE code = ?', [String(code)]);
  if (!invite) return { error: 'invite' };
  if (invite.expires_at && invite.expires_at < now()) return { error: 'expired', invite };
  if (invite.max_uses > 0 && invite.uses >= invite.max_uses) return { error: 'uses', invite };
  if (!db.get('SELECT 1 FROM guilds WHERE id = ?', [invite.guild_id])) return { error: 'guild', invite };
  return { invite };
}

/** Public invite preview — works before you have an account. */
router.get('/:code', (req, res) => {
  const code = String(req.params.code);
  const byVanity = db.get('SELECT * FROM guilds WHERE vanity_url = ?', [code]);
  if (byVanity) {
    return res.json({
      type: 'vanity',
      code,
      guild: publicGuild(byVanity),
      is_member: req.user ? !!perms.getMember(byVanity.id, req.user.id) : false,
    });
  }
  const { invite, error } = findInvite(code);
  if (!invite) return res.status(404).json({ error: 'That invite does not exist.', code: 'UNKNOWN_INVITE' });
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [invite.guild_id]);
  const inviter = invite.inviter_id
    ? serialize.userBrief(db.get('SELECT * FROM users WHERE id = ?', [invite.inviter_id]))
    : null;
  res.json({
    type: 'invite',
    code: invite.code,
    valid: !error,
    invalid_reason: error || null,
    uses: invite.uses,
    max_uses: invite.max_uses,
    expires_at: invite.expires_at,
    guild: publicGuild(guild),
    channel: invite.channel_id ? serialize.serializeChannel(db.get('SELECT * FROM channels WHERE id = ?', [invite.channel_id])) : null,
    inviter,
    is_member: req.user ? !!perms.getMember(guild.id, req.user.id) : false,
  });
});

function publicGuild(guild) {
  const members = db.all(
    `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar
     FROM guild_members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ?
     ORDER BY m.joined_at LIMIT 12`, [guild.id]);
  const channels = db.all(
    `SELECT id, name, type FROM channels WHERE guild_id = ? AND type IN (0, 2, 4) ORDER BY position LIMIT 60`, [guild.id]);
  return {
    id: String(guild.id),
    name: guild.name,
    icon: guild.icon,
    banner: guild.banner,
    splash: guild.splash,
    description: guild.description || '',
    vanity_url: guild.vanity_url,
    boost_level: 3,
    features: ['ALL_BOOST_PERKS_FREE', 'ANIMATED_ICON', 'BANNER', 'VANITY_URL', 'COMMUNITY'],
    member_count: serialize.memberCount(guild.id),
    created_at: guild.created_at,
    tags: serialize.safeJson(guild.tags, []),
    sample_members: members.map((m) => serialize.userBrief(m)),
    categories: channels.filter((c) => c.type === 4).map((c) => ({ id: String(c.id), name: c.name })),
    channels: channels.filter((c) => c.type !== 4).map((c) => ({ id: String(c.id), name: c.name, type: c.type })),
  };
}

/** Accept an invite (requires an account, works with vanity URLs too). */
router.post('/:code', auth.requireUser, (req, res) => {
  const code = String(req.params.code);
  const vanity = db.get('SELECT * FROM guilds WHERE vanity_url = ?', [code]);
  if (vanity) {
    if (perms.getMember(vanity.id, req.user.id)) {
      return res.json({ guild_id: String(vanity.id), already_member: true });
    }
    guilds.addMember(vanity.id, req.user.id, { invitedBy: null });
    bus.toUser(req.user.id, { type: 'GUILD_CREATE', data: require('../guildState').guildPayload(vanity, req.user.id, { isAdmin: req.user.is_admin }) });
    return res.json({ guild_id: String(vanity.id) });
  }

  const { invite, error } = findInvite(code);
  if (!invite) return res.status(404).json({ error: 'That invite does not exist.', code: 'UNKNOWN_INVITE' });
  if (error === 'expired') return res.status(410).json({ error: 'That invite has expired.', code: 'INVITE_EXPIRED' });
  if (error === 'uses') return res.status(410).json({ error: 'That invite has reached its use limit.', code: 'INVITE_MAX_USES' });

  if (perms.getMember(invite.guild_id, req.user.id)) {
    return res.json({ guild_id: String(invite.guild_id), already_member: true });
  }

  db.tx(() => {
    guilds.addMember(invite.guild_id, req.user.id, { invitedBy: invite.inviter_id });
    db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', [invite.code]);
  });

  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [invite.guild_id]);
  bus.toUser(req.user.id, {
    type: 'GUILD_CREATE',
    data: require('../guildState').guildPayload(guild, req.user.id, { isAdmin: req.user.is_admin }),
  });
  bus.toGuild(invite.guild_id, {
    type: 'GUILD_MEMBER_ADD',
    data: { guild_id: String(invite.guild_id), user: serialize.userBrief(req.user), member_count: serialize.memberCount(invite.guild_id) },
  });
  res.json({ guild_id: String(invite.guild_id), channel_id: invite.channel_id ? String(invite.channel_id) : null });
});

/** Every invite that currently points at a server (used by the invite manager). */
router.get('/guild/:guildId', auth.requireUser, (req, res) => {
  const guildId = Number(req.params.guildId);
  const member = perms.getMember(guildId, req.user.id);
  if (!member) return res.status(403).json({ error: 'You are not a member of that server.', code: 'NOT_A_MEMBER' });
  const rows = db.all('SELECT * FROM invites WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
  res.json({
    invites: rows.map((r) => ({
      code: r.code, uses: r.uses, max_uses: r.max_uses, max_age: r.max_age,
      expires_at: r.expires_at, inviter_id: r.inviter_id ? String(r.inviter_id) : null,
      channel_id: r.channel_id ? String(r.channel_id) : null, created_at: r.created_at,
    })),
  });
});

module.exports = router;
module.exports.publicGuild = publicGuild;
module.exports.flagUnused = flag;
