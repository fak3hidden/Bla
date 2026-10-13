'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const guilds = require('../guilds');
const perms = require('../perms');
const serialize = require('../serialize');
const state = require('../guildState');
const { guildContext } = require('../context');
const { P, PERMISSION_LIST, toBigInt, toNumberString, parsePermissionInput, ALL } = require('../permissions');
const { now, slugify, randomId } = require('../util');
const { flag, intOr, isValidUrl } = require('../gate');
const { rateLimit } = require('../ratelimit');
const bus = require('../bus');

const router = express.Router();

router.use(auth.requireUser);

/* ------------------------------------------------------------------ *
 * Server directory + creation
 * ------------------------------------------------------------------ */

router.get('/', (req, res) => {
  const rows = guilds.guildsForUser(req.user.id);
  res.json({
    guilds: rows.map((g) => {
      const payload = state.guildPayload(g, req.user.id, { withMembers: false, isAdmin: req.user.is_admin });
      return {
        id: payload.id, name: payload.name, icon: payload.icon, banner: payload.banner,
        owner_id: payload.owner_id, vanity_url: payload.vanity_url, boost_level: 3,
        approximate_member_count: payload.member_count,
        roles: payload.roles, channels: payload.channels,
        my_permissions: payload.my_permissions, is_owner: payload.is_owner,
        features: payload.features, tags: payload.tags,
      };
    }),
    max_guilds: config.maxGuildsPerUser,
  });
});

router.post('/', rateLimit({ key: 'guild-create', max: 20, windowMs: 3600000 }), (req, res) => {
  const body = req.body || {};
  if (body.icon && !isValidUrl(body.icon)) {
    return res.status(400).json({ error: 'icon must be an uploaded image URL.', code: 'INVALID_ICON' });
  }
  const guildId = guilds.createGuild({
    name: body.name,
    ownerId: req.user.id,
    icon: body.icon || null,
    description: body.description || '',
    template: body.template === 'empty' ? 'empty' : 'default',
  });
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [guildId]);
  const payload = state.guildPayload(guild, req.user.id, { isAdmin: req.user.is_admin });
  bus.toUser(req.user.id, { type: 'GUILD_CREATE', data: payload });
  res.status(201).json({ guild: payload });
});

/* ------------------------------------------------------------------ *
 * Single server
 * ------------------------------------------------------------------ */

router.get('/:guildId', guildContext(), (req, res) => {
  res.json({ guild: state.guildPayload(req.guild, req.user.id, { isAdmin: req.user.is_admin }) });
});

/** Lightweight resync used by clients that reconnect after a dropped socket. */
router.get('/:guildId/sync', guildContext(), (req, res) => {
  res.json({
    guild: state.guildPayload(req.guild, req.user.id, { isAdmin: req.user.is_admin }),
    read_states: require('./syncHelpers').guildReadStates(req.user.id, req.guild.id),
  });
});

router.patch('/:guildId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_GUILD, 'You need Manage Server to edit this server.');
  const body = req.body || {};
  const updates = {};
  const changes = [];

  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 100);
    if (name.length < 2) return res.status(400).json({ error: 'Server names must be at least 2 characters.', code: 'INVALID_GUILD_NAME' });
    updates.name = name;
    changes.push({ key: 'name', before: req.guild.name, after: name });
  }
  for (const field of ['icon', 'banner', 'splash']) {
    if (body[field] !== undefined) {
      if (body[field] === null || body[field] === '') {
        updates[field] = null;
      } else if (!isValidUrl(body[field])) {
        return res.status(400).json({ error: `${field} must be an uploaded image URL.`, code: 'INVALID_IMAGE' });
      } else {
        updates[field] = String(body[field]).slice(0, 500);
      }
      changes.push({ key: field, before: req.guild[field], after: updates[field] });
    }
  }
  if (body.description !== undefined) updates.description = String(body.description || '').slice(0, 300);
  if (body.tags !== undefined) {
    const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : [];
    updates.tags = JSON.stringify(tags);
  }
  if (body.vanity_url !== undefined) {
    if (body.vanity_url === null || body.vanity_url === '') {
      updates.vanity_url = null;
    } else {
      const slug = slugify(body.vanity_url, 'server').slice(0, 30);
      const taken = db.get('SELECT id FROM guilds WHERE vanity_url = ? AND id != ?', [slug, req.guild.id]);
      if (taken) return res.status(409).json({ error: 'That vanity URL is already taken.', code: 'VANITY_TAKEN' });
      updates.vanity_url = slug;
    }
  }
  if (body.afk_channel_id !== undefined) {
    updates.afk_channel_id = body.afk_channel_id === null ? null : Number(body.afk_channel_id);
  }
  if (body.afk_timeout !== undefined) updates.afk_timeout = Math.max(60, Math.min(3600, intOr(body.afk_timeout, 300)));
  if (body.system_channel_id !== undefined) {
    updates.system_channel_id = body.system_channel_id === null ? null : Number(body.system_channel_id);
  }
  if (body.rules_channel_id !== undefined) {
    updates.rules_channel_id = body.rules_channel_id === null ? null : Number(body.rules_channel_id);
  }
  if (body.verification_level !== undefined) updates.verification_level = Math.max(0, Math.min(4, intOr(body.verification_level, 0)));
  if (body.explicit_content_filter !== undefined) updates.explicit_content_filter = flag(body.explicit_content_filter) ? 1 : 0;
  if (body.default_notifications !== undefined) updates.default_notifications = intOr(body.default_notifications, 0) ? 1 : 0;
  if (body.discovery !== undefined) updates.discovery = flag(body.discovery) ? 1 : 0;

  if (!Object.keys(updates).length) return res.json({ guild: state.guildPayload(req.guild, req.user.id, { isAdmin: req.user.is_admin }) });

  db.update('guilds', req.guild.id, updates);
  guilds.audit(req.guild.id, req.user.id, 'GUILD_UPDATE', { targetId: req.guild.id, targetType: 'guild', changes });
  const fresh = db.get('SELECT * FROM guilds WHERE id = ?', [req.guild.id]);
  const payload = state.guildPayload(fresh, req.user.id, { isAdmin: req.user.is_admin });
  bus.toGuild(req.guild.id, { type: 'GUILD_UPDATE', data: payload });
  res.json({ guild: payload });
});

router.delete('/:guildId', guildContext(), (req, res) => {
  if (!req.isOwner && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only the server owner can delete this server.', code: 'NOT_OWNER' });
  }
  bus.toGuild(req.guild.id, { type: 'GUILD_DELETE', data: { id: String(req.guild.id) } });
  guilds.deleteGuild(req.guild.id);
  res.json({ ok: true });
});

router.post('/:guildId/leave', guildContext(), (req, res) => {
  if (req.isOwner) {
    return res.status(400).json({
      error: 'You own this server. Transfer ownership or delete the server instead of leaving.',
      code: 'OWNER_CANNOT_LEAVE',
    });
  }
  guilds.removeMember(req.guild.id, req.user.id);
  bus.toGuild(req.guild.id, { type: 'GUILD_MEMBER_REMOVE', data: { guild_id: String(req.guild.id), user_id: String(req.user.id) } });
  bus.toUser(req.user.id, { type: 'GUILD_DELETE', data: { id: String(req.guild.id) } });
  res.json({ ok: true });
});

router.post('/:guildId/transfer-ownership', guildContext(), (req, res) => {
  if (!req.isOwner && !req.user.is_admin) {
    return res.status(403).json({ error: 'Only the owner can transfer this server.', code: 'NOT_OWNER' });
  }
  const targetId = Number((req.body || {}).user_id);
  const target = db.get('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?', [req.guild.id, targetId]);
  if (!target) return res.status(404).json({ error: 'That person is not a member of this server.', code: 'NOT_A_MEMBER' });

  db.tx(() => {
    db.run('UPDATE guilds SET owner_id = ? WHERE id = ?', [targetId, req.guild.id]);
    const ownerRole = db.get('SELECT id FROM roles WHERE guild_id = ? AND name = ? AND is_everyone = 0', [req.guild.id, 'Owner']);
    if (ownerRole) {
      const oldMember = perms.getMember(req.guild.id, req.user.id);
      const oldRoles = guilds.memberRoleIds(oldMember).filter((r) => r !== ownerRole.id);
      db.run('UPDATE guild_members SET role_ids = ? WHERE guild_id = ? AND user_id = ?',
        [JSON.stringify(oldRoles), req.guild.id, req.user.id]);
      const newRoles = new Set(guilds.memberRoleIds(target));
      newRoles.add(ownerRole.id);
      db.run('UPDATE guild_members SET role_ids = ? WHERE guild_id = ? AND user_id = ?',
        [JSON.stringify([...newRoles]), req.guild.id, targetId]);
    }
    guilds.audit(req.guild.id, req.user.id, 'GUILD_OWNER_TRANSFER', { targetId, targetType: 'user' });
  });

  const fresh = db.get('SELECT * FROM guilds WHERE id = ?', [req.guild.id]);
  bus.toGuild(req.guild.id, { type: 'GUILD_UPDATE', data: state.guildPayload(fresh, targetId, { isAdmin: false }) });
  res.json({ ok: true, owner_id: String(targetId) });
});

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

router.get('/:guildId/channels', guildContext(), (req, res) => {
  const payload = state.guildPayload(req.guild, req.user.id, { withMembers: false, isAdmin: req.user.is_admin });
  res.json({ channels: payload.channels });
});

router.post('/:guildId/channels', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_CHANNELS, 'You need Manage Channels to create channels.');
  const body = req.body || {};
  const type = intOr(body.type, 0);
  if (![0, 2, 4, 5, 13, 15].includes(type)) {
    return res.status(400).json({ error: 'Unsupported channel type.', code: 'INVALID_CHANNEL_TYPE' });
  }
  const count = db.get('SELECT COUNT(*) AS c FROM channels WHERE guild_id = ?', [req.guild.id]).c;
  if (count >= config.maxChannelsPerGuild) {
    return res.status(403).json({ error: 'This server has hit the channel limit.', code: 'CHANNEL_LIMIT' });
  }
  let name = String(body.name || '').trim();
  if (type === 4) name = name.slice(0, 100) || 'New Category';
  else name = slugify(name, 'new-channel');
  if (!name) name = 'new-channel';

  let parentId = null;
  if (body.parent_id) {
    const parent = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(body.parent_id), req.guild.id]);
    if (!parent) return res.status(400).json({ error: 'Unknown category.', code: 'UNKNOWN_PARENT' });
    parentId = parent.id;
  }
  const positionRow = db.get(
    `SELECT MAX(position) AS maxPos FROM channels WHERE guild_id = ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`,
    parentId ? [req.guild.id, parentId] : [req.guild.id]);

  const channelId = db.insert('channels', {
    guild_id: req.guild.id,
    parent_id: parentId,
    name,
    topic: String(body.topic || '').slice(0, 1024),
    type,
    position: (positionRow?.maxPos ?? -1) + 1,
    nsfw: flag(body.nsfw) ? 1 : 0,
    slowmode: Math.max(0, Math.min(21600, intOr(body.rate_limit_per_user, 0))),
    user_limit: Math.max(0, Math.min(99, intOr(body.user_limit, 0))),
    bitrate: Math.max(8000, Math.min(384000, intOr(body.bitrate, config.voiceBitrate))),
    created_at: now(),
  });

  // Copy category overwrites down to the new channel, like Discord does.
  if (parentId) {
    const parentOw = db.all('SELECT * FROM permission_overwrites WHERE channel_id = ?', [parentId]);
    for (const ow of parentOw) {
      db.insert('permission_overwrites', {
        channel_id: channelId, target_id: ow.target_id, target_type: ow.target_type,
        allow: ow.allow, deny: ow.deny,
      });
    }
  }

  guilds.audit(req.guild.id, req.user.id, 'CHANNEL_CREATE', { targetId: channelId, targetType: 'channel' });
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
  const payload = state.channelEditorPayload(channel);
  bus.toGuild(req.guild.id, { type: 'CHANNEL_CREATE', data: payload });
  res.status(201).json({ channel: payload });
});

router.patch('/:guildId/channels/:channelId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_CHANNELS, 'You need Manage Channels to edit channels.');
  const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(req.params.channelId), req.guild.id]);
  if (!channel) return res.status(404).json({ error: 'Unknown channel.', code: 'UNKNOWN_CHANNEL' });
  const body = req.body || {};
  const updates = {};

  if (body.name !== undefined) {
    const raw = String(body.name || '').trim();
    updates.name = channel.type === 4 ? raw.slice(0, 100) || channel.name : (slugify(raw, channel.name) || channel.name).slice(0, 100);
  }
  if (body.topic !== undefined) updates.topic = String(body.topic || '').slice(0, 1024);
  if (body.nsfw !== undefined) updates.nsfw = flag(body.nsfw) ? 1 : 0;
  if (body.rate_limit_per_user !== undefined) updates.slowmode = Math.max(0, Math.min(21600, intOr(body.rate_limit_per_user, 0)));
  if (body.user_limit !== undefined) updates.user_limit = Math.max(0, Math.min(99, intOr(body.user_limit, 0)));
  if (body.bitrate !== undefined) updates.bitrate = Math.max(8000, Math.min(384000, intOr(body.bitrate, config.voiceBitrate)));
  if (body.parent_id !== undefined) {
    if (body.parent_id === null) updates.parent_id = null;
    else {
      const parent = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ? AND type = 4', [Number(body.parent_id), req.guild.id]);
      if (!parent) return res.status(400).json({ error: 'Unknown category.', code: 'UNKNOWN_PARENT' });
      if (parent.id === channel.id) return res.status(400).json({ error: 'A category cannot contain itself.', code: 'INVALID_PARENT' });
      updates.parent_id = parent.id;
    }
  }
  if (body.position !== undefined) updates.position = Math.max(0, intOr(body.position, channel.position));

  if (!Object.keys(updates).length) return res.json({ channel: state.channelEditorPayload(channel) });
  db.update('channels', channel.id, updates);

  // Moving a channel between categories remaps positions.
  if (updates.parent_id !== undefined) {
    db.run('UPDATE channels SET parent_id = ? WHERE id = ?', [updates.parent_id, channel.id]);
  }

  guilds.audit(req.guild.id, req.user.id, 'CHANNEL_UPDATE', { targetId: channel.id, targetType: 'channel' });
  const fresh = db.get('SELECT * FROM channels WHERE id = ?', [channel.id]);
  const payload = state.channelEditorPayload(fresh);
  bus.toGuild(req.guild.id, { type: 'CHANNEL_UPDATE', data: payload });
  res.json({ channel: payload });
});

router.delete('/:guildId/channels/:channelId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_CHANNELS, 'You need Manage Channels to delete channels.');
  const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(req.params.channelId), req.guild.id]);
  if (!channel) return res.status(404).json({ error: 'Unknown channel.', code: 'UNKNOWN_CHANNEL' });
  if (String(req.guild.system_channel_id) === String(channel.id)) {
    db.run('UPDATE guilds SET system_channel_id = NULL WHERE id = ?', [req.guild.id]);
  }
  if (String(req.guild.rules_channel_id) === String(channel.id)) {
    db.run('UPDATE guilds SET rules_channel_id = NULL WHERE id = ?', [req.guild.id]);
  }
  db.run('DELETE FROM channels WHERE id = ?', [channel.id]);
  guilds.audit(req.guild.id, req.user.id, 'CHANNEL_DELETE', { targetId: channel.id, targetType: 'channel' });
  bus.toGuild(req.guild.id, { type: 'CHANNEL_DELETE', data: { id: String(channel.id), guild_id: String(req.guild.id) } });
  res.json({ ok: true });
});

/** Reorder channels and re-parent them in one shot (drag & drop in the UI). */
router.patch('/:guildId/channels', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_CHANNELS, 'You need Manage Channels to reorder channels.');
  const positions = Array.isArray((req.body || {}).positions) ? req.body.positions : [];
  db.tx(() => {
    for (const entry of positions) {
      const id = Number(entry.id);
      const channel = db.get('SELECT id FROM channels WHERE id = ? AND guild_id = ?', [id, req.guild.id]);
      if (!channel) continue;
      const parentId = entry.parent_id === null || entry.parent_id === undefined ? null : Number(entry.parent_id);
      db.run('UPDATE channels SET position = ?, parent_id = ? WHERE id = ?',
        [Math.max(0, intOr(entry.position, 0)), parentId, id]);
    }
  });
  const payload = state.guildPayload(req.guild, req.user.id, { withMembers: false, isAdmin: req.user.is_admin });
  bus.toGuild(req.guild.id, { type: 'GUILD_CHANNELS_RESYNC', data: { guild_id: String(req.guild.id), channels: payload.channels } });
  res.json({ channels: payload.channels });
});

/* ------------------------------------------------------------------ *
 * Channel permission overwrites
 * ------------------------------------------------------------------ */

router.put('/:guildId/channels/:channelId/permissions/:targetId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to edit channel permissions.');
  const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(req.params.channelId), req.guild.id]);
  if (!channel) return res.status(404).json({ error: 'Unknown channel.', code: 'UNKNOWN_CHANNEL' });
  const body = req.body || {};
  const type = intOr(body.type, 0) === 1 ? 'member' : 'role';
  const targetId = Number(req.params.targetId);
  const allow = toNumberString(parsePermissionInput(body.allow ?? 0));
  const deny = toNumberString(parsePermissionInput(body.deny ?? 0));

  if (type === 'role') {
    const role = db.get('SELECT * FROM roles WHERE id = ? AND guild_id = ?', [targetId, req.guild.id]);
    if (!role) return res.status(404).json({ error: 'Unknown role.', code: 'UNKNOWN_ROLE' });
  } else {
    const member = perms.getMember(req.guild.id, targetId);
    if (!member) return res.status(404).json({ error: 'That person is not in this server.', code: 'NOT_A_MEMBER' });
  }

  db.run(
    `INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, target_id, target_type) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
    [channel.id, targetId, type, allow, deny]);

  guilds.audit(req.guild.id, req.user.id, 'CHANNEL_OVERWRITE_UPDATE', {
    targetId: channel.id, targetType: 'channel', changes: [{ key: 'overwrite', before: null, after: `${type}:${targetId}` }],
  });
  const payload = state.channelEditorPayload(channel);
  bus.toGuild(req.guild.id, { type: 'CHANNEL_UPDATE', data: payload });
  res.json({ channel: payload });
});

router.delete('/:guildId/channels/:channelId/permissions/:targetId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to edit channel permissions.');
  const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(req.params.channelId), req.guild.id]);
  if (!channel) return res.status(404).json({ error: 'Unknown channel.', code: 'UNKNOWN_CHANNEL' });
  const type = req.query.type === 'member' ? 'member' : 'role';
  db.run('DELETE FROM permission_overwrites WHERE channel_id = ? AND target_id = ? AND target_type = ?',
    [channel.id, Number(req.params.targetId), type]);
  const payload = state.channelEditorPayload(channel);
  bus.toGuild(req.guild.id, { type: 'CHANNEL_UPDATE', data: payload });
  res.json({ channel: payload });
});

/* ------------------------------------------------------------------ *
 * Message search (per server, optionally per channel)
 * ------------------------------------------------------------------ */

router.get('/:guildId/messages/search', guildContext(), (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ messages: [], total: 0 });
  const limit = Math.max(1, Math.min(50, intOr(req.query.limit, 25)));
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  const authorId = req.query.author_id ? Number(req.query.author_id) : null;
  const mentionsMe = flag(req.query.mentions_me);
  const pinned = flag(req.query.pinned);

  const visible = state.guildPayload(req.guild, req.user.id, { withMembers: false, isAdmin: req.user.is_admin }).channels
    .filter((c) => c.type === 0 || c.type === 5 || c.type === 15)
    .map((c) => Number(c.id));
  if (!visible.length) return res.json({ messages: [], total: 0 });
  const scope = channelId ? visible.filter((id) => id === channelId) : visible;
  if (!scope.length) return res.json({ messages: [], total: 0 });

  const params = [];
  let sql = `${serialize.MESSAGE_SELECT} AND m.guild_id = ? AND m.channel_id IN (${scope.map(() => '?').join(',')})
             AND LOWER(m.content) LIKE ?`;
  params.push(req.guild.id, ...scope, `%${q.toLowerCase()}%`);
  if (authorId) { sql += ' AND m.author_id = ?'; params.push(authorId); }
  if (mentionsMe) { sql += ' AND (m.mention_everyone = 1 OR m.mentions LIKE ?)'; params.push(`%${req.user.id}%`); }
  if (pinned) sql += ' AND m.pinned = 1';
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(limit);

  const rows = db.all(sql, params);
  res.json({
    messages: serialize.hydrateMessages(rows, { currentUserId: req.user.id }),
    total: rows.length,
    searched_channels: scope.length,
  });
});

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

router.get('/:guildId/roles', guildContext(), (req, res) => {
  const roles = perms.getRoles(req.guild.id);
  const counts = new Map();
  for (const row of db.all('SELECT role_ids FROM guild_members WHERE guild_id = ?', [req.guild.id])) {
    for (const id of (JSON.parse(row.role_ids || '[]') || [])) counts.set(Number(id), (counts.get(Number(id)) || 0) + 1);
  }
  res.json({
    roles: roles.map((r) => serialize.serializeRole(r, counts.get(r.id) || 0)),
    permission_list: PERMISSION_LIST.map(([key, name, description]) => ({ key, name, description, bit: P[key] ? P[key].toString() : '0' })),
  });
});

router.post('/:guildId/roles', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to create roles.');
  const count = db.get('SELECT COUNT(*) AS c FROM roles WHERE guild_id = ?', [req.guild.id]).c;
  if (count >= config.maxRolesPerGuild) {
    return res.status(403).json({ error: 'This server has hit the role limit.', code: 'ROLE_LIMIT' });
  }
  const body = req.body || {};
  const myTop = req.isOwner || req.user.is_admin ? 1000 : perms.highestRolePosition(req.guild.id, req.member);
  const position = Math.min(myTop, Math.max(1, intOr(body.position, 1)));
  const requested = parsePermissionInput(body.permissions ?? 0);
  if (!req.isOwner && !req.user.is_admin && (toBigInt(req.guildPerms) & requested) !== requested) {
    return res.status(403).json({ error: 'You cannot grant permissions you do not have yourself.', code: 'PERMISSION_ESCALATION' });
  }
  const roleId = db.insert('roles', {
    guild_id: req.guild.id,
    name: String(body.name || 'new role').trim().slice(0, 100) || 'new role',
    color: Math.max(0, Math.min(0xffffff, intOr(body.color, 0))),
    icon: body.icon && isValidUrl(body.icon) ? body.icon : null,
    unicode_emoji: body.unicode_emoji ? String(body.unicode_emoji).slice(0, 16) : null,
    position: Math.min(1000, position),
    permissions: toNumberString(requested || 0n),
    hoist: flag(body.hoist) ? 1 : 0,
    mentionable: flag(body.mentionable) ? 1 : 0,
  });
  guilds.audit(req.guild.id, req.user.id, 'ROLE_CREATE', { targetId: roleId, targetType: 'role' });
  const role = db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
  const payload = serialize.serializeRole(role, 0);
  bus.toGuild(req.guild.id, { type: 'GUILD_ROLE_CREATE', data: { guild_id: String(req.guild.id), role: payload } });
  res.status(201).json({ role: payload });
});

router.patch('/:guildId/roles/:roleId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to edit roles.');
  const role = db.get('SELECT * FROM roles WHERE id = ? AND guild_id = ?', [Number(req.params.roleId), req.guild.id]);
  if (!role) return res.status(404).json({ error: 'Unknown role.', code: 'UNKNOWN_ROLE' });
  if (role.is_everyone && (req.body || {}).position !== undefined) {
    return res.status(400).json({ error: '@everyone always sits at the bottom.', code: 'EVERYONE_POSITION' });
  }
  const body = req.body || {};
  const updates = {};
  const changes = [];

  if (body.name !== undefined && !role.is_everyone) {
    updates.name = String(body.name || '').trim().slice(0, 100) || role.name;
    changes.push({ key: 'name', before: role.name, after: updates.name });
  }
  if (body.color !== undefined) updates.color = Math.max(0, Math.min(0xffffff, intOr(body.color, role.color)));
  if (body.icon !== undefined) updates.icon = body.icon && isValidUrl(body.icon) ? body.icon : null;
  if (body.unicode_emoji !== undefined) updates.unicode_emoji = body.unicode_emoji ? String(body.unicode_emoji).slice(0, 16) : null;
  if (body.hoist !== undefined) updates.hoist = flag(body.hoist) ? 1 : 0;
  if (body.mentionable !== undefined) updates.mentionable = flag(body.mentionable) ? 1 : 0;
  if (body.position !== undefined) {
    const maxPosition = req.isOwner || req.user.is_admin ? 1000 : perms.highestRolePosition(req.guild.id, req.member);
    updates.position = Math.max(1, Math.min(maxPosition, intOr(body.position, role.position)));
  }
  if (body.permissions !== undefined) {
    const requested = parsePermissionInput(body.permissions);
    if (!req.isOwner && !req.user.is_admin) {
      const mine = toBigInt(req.guildPerms);
      if ((mine & requested) !== requested) {
        return res.status(403).json({ error: 'You cannot grant permissions you do not have yourself.', code: 'PERMISSION_ESCALATION' });
      }
      if (role.position >= perms.highestRolePosition(req.guild.id, req.member)) {
        return res.status(403).json({ error: 'You cannot edit a role that is equal to or above your highest role.', code: 'ROLE_HIERARCHY' });
      }
    }
    updates.permissions = toNumberString(requested);
    changes.push({ key: 'permissions', before: toNumberString(role.permissions), after: toNumberString(requested) });
  }

  if (Object.keys(updates).length) db.update('roles', role.id, updates);
  guilds.audit(req.guild.id, req.user.id, 'ROLE_UPDATE', { targetId: role.id, targetType: 'role', changes });
  const fresh = db.get('SELECT * FROM roles WHERE id = ?', [role.id]);
  const payload = serialize.serializeRole(fresh);
  bus.toGuild(req.guild.id, { type: 'GUILD_ROLE_UPDATE', data: { guild_id: String(req.guild.id), role: payload } });
  res.json({ role: payload });
});

router.delete('/:guildId/roles/:roleId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to delete roles.');
  const role = db.get('SELECT * FROM roles WHERE id = ? AND guild_id = ?', [Number(req.params.roleId), req.guild.id]);
  if (!role) return res.status(404).json({ error: 'Unknown role.', code: 'UNKNOWN_ROLE' });
  if (role.is_everyone) return res.status(400).json({ error: 'The @everyone role cannot be deleted.', code: 'EVERYONE_ROLE' });
  if (!req.isOwner && !req.user.is_admin && role.position >= perms.highestRolePosition(req.guild.id, req.member)) {
    return res.status(403).json({ error: 'That role is above your highest role.', code: 'ROLE_HIERARCHY' });
  }
  db.tx(() => {
    db.run('DELETE FROM roles WHERE id = ?', [role.id]);
    for (const member of db.all('SELECT * FROM guild_members WHERE guild_id = ?', [req.guild.id])) {
      const ids = JSON.parse(member.role_ids || '[]').map(Number).filter((id) => id !== role.id);
      db.run('UPDATE guild_members SET role_ids = ? WHERE guild_id = ? AND user_id = ?',
        [JSON.stringify(ids), req.guild.id, member.user_id]);
    }
    db.run('DELETE FROM permission_overwrites WHERE target_id = ? AND target_type = ?', [role.id, 'role']);
  });
  guilds.audit(req.guild.id, req.user.id, 'ROLE_DELETE', { targetId: role.id, targetType: 'role' });
  bus.toGuild(req.guild.id, { type: 'GUILD_ROLE_DELETE', data: { guild_id: String(req.guild.id), role_id: String(role.id) } });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Members
 * ------------------------------------------------------------------ */

router.get('/:guildId/members', guildContext(), (req, res) => {
  const limit = Math.max(0, Math.min(1000, intOr(req.query.limit, 1000)));
  const members = state.membersPayload(req.guild.id, { limit });
  const after = req.query.after ? String(req.query.after) : null;
  const filtered = after ? members.filter((m) => m.user_id > after) : members;
  res.json({ members: filtered });
});

router.get('/:guildId/members/search', guildContext(), (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const members = state.membersPayload(req.guild.id, { limit: 1000 })
    .filter((m) => !q ||
      m.user.username.toLowerCase().includes(q) ||
      String(m.user.display_name || '').toLowerCase().includes(q) ||
      String(m.nickname || '').toLowerCase().includes(q))
    .slice(0, 50);
  res.json({ members });
});

router.get('/:guildId/members/:userId', guildContext(), (req, res) => {
  const userId = Number(req.params.userId);
  const member = perms.getMember(req.guild.id, userId);
  if (!member) return res.status(404).json({ error: 'That person is not in this server.', code: 'NOT_A_MEMBER' });
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  const row = state.membersPayload(req.guild.id, { limit: 0 }).find((m) => String(m.user_id) === String(userId));
  res.json({
    member: row || {
      guild_id: String(req.guild.id), user_id: String(userId), roles: [], nickname: member.nickname,
      joined_at: member.joined_at, user: serialize.serializeUser(user),
    },
    roles: perms.getRoles(req.guild.id).filter((r) => JSON.parse(member.role_ids || '[]').map(Number).includes(r.id))
      .map((r) => serialize.serializeRole(r)),
    note: 'Moderation: use the member context menu for timeout, kick and ban.',
  });
});

router.patch('/:guildId/members/:userId', guildContext(), (req, res) => {
  const userId = Number(req.params.userId);
  const member = perms.getMember(req.guild.id, userId);
  if (!member) return res.status(404).json({ error: 'That person is not in this server.', code: 'NOT_A_MEMBER' });
  const body = req.body || {};
  const isSelf = String(userId) === String(req.user.id);
  const updates = {};

  // Changing your own nickname only needs CHANGE_NICKNAME.
  if (body.nick !== undefined) {
    if (isSelf) perms.assertPermission(req.guildPerms, P.CHANGE_NICKNAME, 'You cannot change your nickname in this server.');
    else perms.assertPermission(req.guildPerms, P.MANAGE_NICKNAMES, 'You need Manage Nicknames to rename others.');
    updates.nickname = body.nick ? String(body.nick).trim().slice(0, 32) : null;
  }
  if (body.muted !== undefined || body.deafened !== undefined) {
    if (isSelf) {
      // Self mute/deafen in a server is a voice-only state, handled by the voice route.
      if (body.muted !== undefined) db.run('UPDATE guild_members SET muted = ? WHERE guild_id = ? AND user_id = ?', [flag(body.muted) ? 1 : 0, req.guild.id, userId]);
    } else {
      perms.assertPermission(req.guildPerms, body.muted !== undefined ? P.MUTE_MEMBERS : P.DEAFEN_MEMBERS,
        'You need Mute Members or Deafen Members to do that.');
      if (body.muted !== undefined) {
        updates.muted = flag(body.muted) ? 1 : 0;
        db.run('UPDATE voice_states SET server_mute = ? WHERE guild_id = ? AND user_id = ?', [flag(body.muted) ? 1 : 0, req.guild.id, userId]);
      }
      if (body.deafened !== undefined) {
        updates.deafened = flag(body.deafened) ? 1 : 0;
        db.run('UPDATE voice_states SET server_deaf = ? WHERE guild_id = ? AND user_id = ?', [flag(body.deafened) ? 1 : 0, req.guild.id, userId]);
      }
    }
  }
  if (body.roles !== undefined && Array.isArray(body.roles)) {
    perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to change someone\u2019s roles.');
    const myTop = req.isOwner || req.user.is_admin ? 1000 : perms.highestRolePosition(req.guild.id, req.member);
    const roleRows = perms.getRoles(req.guild.id);
    const everyoneRole = roleRows.find((r) => r.is_everyone);
    const requested = new Set(body.roles.map(Number));
    if (everyoneRole) requested.add(everyoneRole.id);
    for (const roleId of requested) {
      const role = roleRows.find((r) => r.id === roleId);
      if (!role) return res.status(400).json({ error: `Unknown role ${roleId}.`, code: 'UNKNOWN_ROLE' });
      if (!role.is_everyone && role.position >= myTop) {
        return res.status(403).json({ error: 'You cannot manage a role at or above your highest role.', code: 'ROLE_HIERARCHY' });
      }
    }
    updates.role_ids = JSON.stringify([...requested]);
  }
  if (body.communication_disabled_until !== undefined) {
    perms.assertPermission(req.guildPerms, P.MODERATE_MEMBERS, 'You need Timeout Members to do that.');
    const until = body.communication_disabled_until === null ? null : Number(body.communication_disabled_until);
    if (until !== null && !Number.isFinite(until)) return res.status(400).json({ error: 'Invalid timeout timestamp.', code: 'INVALID_TIMEOUT' });
    if (until !== null && until > now() + 28 * 86400000) return res.status(400).json({ error: 'Timeouts can be at most 28 days.', code: 'TIMEOUT_TOO_LONG' });
    updates.timeout_until = until;
    guilds.audit(req.guild.id, req.user.id, until ? 'MEMBER_TIMEOUT' : 'MEMBER_TIMEOUT_REMOVE', { targetId: userId, targetType: 'user' });
  }

  if (Object.keys(updates).length) {
    const keys = Object.keys(updates);
    db.run(`UPDATE guild_members SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ? AND user_id = ?`,
      [...keys.map((k) => updates[k]), req.guild.id, userId]);
  }

  const payload = state.membersPayload(req.guild.id, { limit: 1000 }).find((m) => String(m.user_id) === String(userId));
  bus.toGuild(req.guild.id, { type: 'GUILD_MEMBER_UPDATE', data: { guild_id: String(req.guild.id), member: payload } });
  res.json({ member: payload });
});

router.delete('/:guildId/members/:userId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.KICK_MEMBERS, 'You need Kick Members to do that.');
  const userId = Number(req.params.userId);
  if (String(userId) === String(req.user.id)) return res.status(400).json({ error: 'Use "Leave Server" to leave.', code: 'SELF_KICK' });
  const member = perms.getMember(req.guild.id, userId);
  if (!member) return res.status(404).json({ error: 'That person is not in this server.', code: 'NOT_A_MEMBER' });
  if (!req.isOwner && !req.user.is_admin) {
    const myTop = perms.highestRolePosition(req.guild.id, req.member);
    const theirTop = perms.highestRolePosition(req.guild.id, member);
    if (theirTop >= myTop) return res.status(403).json({ error: 'You cannot kick someone with an equal or higher role.', code: 'ROLE_HIERARCHY' });
  }
  guilds.removeMember(req.guild.id, userId, { kicker: req.user.id, reason: (req.body || {}).reason || '' });
  bus.toGuild(req.guild.id, { type: 'GUILD_MEMBER_REMOVE', data: { guild_id: String(req.guild.id), user_id: String(userId) } });
  bus.toUser(userId, { type: 'GUILD_DELETE', data: { id: String(req.guild.id) } });
  res.json({ ok: true });
});

router.put('/:guildId/members/:userId/roles/:roleId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to assign roles.');
  return applyRoleChange(req, res, 'add');
});

router.delete('/:guildId/members/:userId/roles/:roleId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_ROLES, 'You need Manage Roles to remove roles.');
  return applyRoleChange(req, res, 'remove');
});

function applyRoleChange(req, res, mode) {
  const userId = Number(req.params.userId);
  const roleId = Number(req.params.roleId);
  const member = perms.getMember(req.guild.id, userId);
  if (!member) return res.status(404).json({ error: 'That person is not in this server.', code: 'NOT_A_MEMBER' });
  const role = db.get('SELECT * FROM roles WHERE id = ? AND guild_id = ?', [roleId, req.guild.id]);
  if (!role) return res.status(404).json({ error: 'Unknown role.', code: 'UNKNOWN_ROLE' });
  if (role.is_everyone) return res.status(400).json({ error: '@everyone applies to everyone automatically.', code: 'EVERYONE_ROLE' });
  const myTop = req.isOwner || req.user.is_admin ? 1000 : perms.highestRolePosition(req.guild.id, req.member);
  if (role.position >= myTop) return res.status(403).json({ error: 'That role is at or above your highest role.', code: 'ROLE_HIERARCHY' });

  const ids = new Set(JSON.parse(member.role_ids || '[]').map(Number));
  if (mode === 'add') ids.add(roleId); else ids.delete(roleId);
  ids.add(perms.getRoles(req.guild.id).find((r) => r.is_everyone)?.id);
  db.run('UPDATE guild_members SET role_ids = ? WHERE guild_id = ? AND user_id = ?',
    [JSON.stringify([...ids].filter(Boolean)), req.guild.id, userId]);
  bus.toGuild(req.guild.id, {
    type: 'GUILD_MEMBER_UPDATE',
    data: { guild_id: String(req.guild.id), user_id: String(userId), roles: [...ids].filter(Boolean).map(String) },
  });
  res.json({ ok: true, roles: [...ids].filter(Boolean).map(String) });
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

router.get('/:guildId/bans', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.BAN_MEMBERS, 'You need Ban Members to view the ban list.');
  const rows = db.all(
    `SELECT b.*, u.username, u.discriminator, u.display_name, u.avatar
     FROM bans b JOIN users u ON u.id = b.user_id WHERE b.guild_id = ? ORDER BY b.created_at DESC`, [req.guild.id]);
  res.json({
    bans: rows.map((b) => ({
      user: serialize.userBrief({ id: b.user_id, username: b.username, discriminator: b.discriminator, display_name: b.display_name, avatar: b.avatar }),
      reason: b.reason || '',
      created_at: b.created_at,
      moderator_id: b.moderator_id ? String(b.moderator_id) : null,
    })),
  });
});

router.put('/:guildId/bans/:userId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.BAN_MEMBERS, 'You need Ban Members to ban people.');
  const userId = Number(req.params.userId);
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'Unknown user.', code: 'UNKNOWN_USER' });
  if (String(userId) === String(req.user.id) || String(userId) === String(req.guild.owner_id)) {
    return res.status(400).json({ error: 'You cannot ban yourself or the server owner.', code: 'CANNOT_BAN' });
  }
  const member = perms.getMember(req.guild.id, userId);
  if (member && !req.isOwner && !req.user.is_admin) {
    const myTop = perms.highestRolePosition(req.guild.id, req.member);
    if (perms.highestRolePosition(req.guild.id, member) >= myTop) {
      return res.status(403).json({ error: 'You cannot ban someone with an equal or higher role.', code: 'ROLE_HIERARCHY' });
    }
  }
  const body = req.body || {};
  const reason = String(body.reason || '').slice(0, 500);
  db.tx(() => {
    db.run(
      `INSERT INTO bans (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, moderator_id = excluded.moderator_id`,
      [req.guild.id, userId, req.user.id, reason, now()]);
    db.run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', [req.guild.id, userId]);
    db.run('DELETE FROM voice_states WHERE guild_id = ? AND user_id = ?', [req.guild.id, userId]);
    guilds.audit(req.guild.id, req.user.id, 'MEMBER_BAN_ADD', { targetId: userId, targetType: 'user', reason });
    // Delete the banned person's recent messages (Discord's default behaviour).
    db.run(
      `UPDATE messages SET deleted_at = ? WHERE guild_id = ? AND author_id = ? AND created_at > ? AND deleted_at IS NULL`,
      [now(), req.guild.id, userId, now() - 86400000]);
  });
  bus.toGuild(req.guild.id, { type: 'GUILD_BAN_ADD', data: { guild_id: String(req.guild.id), user_id: String(userId) } });
  bus.toUser(userId, { type: 'GUILD_DELETE', data: { id: String(req.guild.id) } });
  res.json({ ok: true });
});

router.delete('/:guildId/bans/:userId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.BAN_MEMBERS, 'You need Ban Members to unban people.');
  db.run('DELETE FROM bans WHERE guild_id = ? AND user_id = ?', [req.guild.id, Number(req.params.userId)]);
  guilds.audit(req.guild.id, req.user.id, 'MEMBER_BAN_REMOVE', { targetId: Number(req.params.userId), targetType: 'user' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Audit log
 * ------------------------------------------------------------------ */

router.get('/:guildId/audit-logs', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.VIEW_AUDIT_LOG, 'You need View Audit Log to read this.');
  const limit = Math.max(1, Math.min(200, intOr(req.query.limit, 50)));
  const action = req.query.action_type ? String(req.query.action_type) : null;
  const rows = db.all(
    `SELECT a.*, u.username, u.display_name, u.avatar FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.guild_id = ? ${action ? 'AND a.action = ?' : ''}
     ORDER BY a.id DESC LIMIT ?`,
    action ? [req.guild.id, action, limit] : [req.guild.id, limit]);
  res.json({
    audit_log_entries: rows.map((row) => ({
      id: String(row.id),
      action: row.action,
      target_id: row.target_id ? String(row.target_id) : null,
      target_type: row.target_type,
      reason: row.reason,
      changes: serialize.safeJson(row.changes, []),
      user_id: row.user_id ? String(row.user_id) : null,
      user: row.user_id ? serialize.userBrief({ id: row.user_id, username: row.username, display_name: row.display_name, avatar: row.avatar }) : null,
      created_at: row.created_at,
    })),
  });
});

/* ------------------------------------------------------------------ *
 * Emoji, stickers, soundboard — unlimited and free on every server
 * ------------------------------------------------------------------ */

router.get('/:guildId/emojis', guildContext(), (req, res) => {
  res.json({ emojis: db.all('SELECT * FROM emojis WHERE guild_id = ?', [req.guild.id]).map(serialize.serializeEmoji) });
});

router.post('/:guildId/emojis', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_EXPRESSIONS, 'You need Manage Emoji & Stickers to add emoji.');
  const body = req.body || {};
  const name = String(body.name || '').trim().replace(/\W/g, '').slice(0, 32);
  if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) {
    return res.status(400).json({ error: 'Emoji names must be 2-32 characters of letters, numbers or underscores.', code: 'INVALID_EMOJI_NAME' });
  }
  if (!body.image || !isValidUrl(body.image)) {
    return res.status(400).json({ error: 'image must be an uploaded file URL.', code: 'INVALID_IMAGE' });
  }
  const count = db.get('SELECT COUNT(*) AS c FROM emojis WHERE guild_id = ?', [req.guild.id]).c;
  if (count >= config.maxEmojiPerGuild) {
    return res.status(403).json({ error: `This server has the maximum of ${config.maxEmojiPerGuild} emoji (which is a lot!).`, code: 'EMOJI_LIMIT' });
  }
  const id = db.insert('emojis', {
    guild_id: req.guild.id, name, image: String(body.image).slice(0, 500),
    animated: flag(body.animated) ? 1 : 0, creator_id: req.user.id, available: 1, created_at: now(),
  });
  const emoji = serialize.serializeEmoji(db.get('SELECT * FROM emojis WHERE id = ?', [id]));
  bus.toGuild(req.guild.id, { type: 'GUILD_EMOJIS_UPDATE', data: { guild_id: String(req.guild.id), emoji } });
  res.status(201).json({ emoji });
});

router.patch('/:guildId/emojis/:emojiId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_EXPRESSIONS, 'You need Manage Emoji & Stickers to edit emoji.');
  const emoji = db.get('SELECT * FROM emojis WHERE id = ? AND guild_id = ?', [Number(req.params.emojiId), req.guild.id]);
  if (!emoji) return res.status(404).json({ error: 'Unknown emoji.', code: 'UNKNOWN_EMOJI' });
  const updates = {};
  if ((req.body || {}).name !== undefined) {
    const name = String(req.body.name).trim().replace(/\W/g, '').slice(0, 32);
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) return res.status(400).json({ error: 'Invalid emoji name.', code: 'INVALID_EMOJI_NAME' });
    updates.name = name;
  }
  if (Object.keys(updates).length) db.update('emojis', emoji.id, updates);
  const payload = serialize.serializeEmoji(db.get('SELECT * FROM emojis WHERE id = ?', [emoji.id]));
  bus.toGuild(req.guild.id, { type: 'GUILD_EMOJIS_UPDATE', data: { guild_id: String(req.guild.id), emoji: payload } });
  res.json({ emoji: payload });
});

router.delete('/:guildId/emojis/:emojiId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_EXPRESSIONS, 'You need Manage Emoji & Stickers to delete emoji.');
  const emoji = db.get('SELECT * FROM emojis WHERE id = ? AND guild_id = ?', [Number(req.params.emojiId), req.guild.id]);
  if (!emoji) return res.status(404).json({ error: 'Unknown emoji.', code: 'UNKNOWN_EMOJI' });
  db.run('DELETE FROM emojis WHERE id = ?', [emoji.id]);
  bus.toGuild(req.guild.id, { type: 'GUILD_EMOJIS_UPDATE', data: { guild_id: String(req.guild.id), emoji_id: String(emoji.id), deleted: true } });
  res.json({ ok: true });
});

router.post('/:guildId/stickers', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_EXPRESSIONS, 'You need Manage Emoji & Stickers to add stickers.');
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Stickers need a name.', code: 'INVALID_STICKER_NAME' });
  if (!body.image || !isValidUrl(body.image)) return res.status(400).json({ error: 'image must be an uploaded file URL.', code: 'INVALID_IMAGE' });
  const count = db.get('SELECT COUNT(*) AS c FROM stickers WHERE guild_id = ?', [req.guild.id]).c;
  if (count >= config.maxStickerPerGuild) {
    return res.status(403).json({ error: 'This server has hit the sticker limit.', code: 'STICKER_LIMIT' });
  }
  const id = db.insert('stickers', {
    guild_id: req.guild.id, name, description: String(body.description || '').slice(0, 100),
    tags: String(body.tags || '').slice(0, 200), image: String(body.image).slice(0, 500),
    format: intOr(body.format_type, 1), creator_id: req.user.id, created_at: now(),
  });
  const sticker = serialize.serializeSticker(db.get('SELECT * FROM stickers WHERE id = ?', [id]));
  bus.toGuild(req.guild.id, { type: 'GUILD_STICKERS_UPDATE', data: { guild_id: String(req.guild.id), sticker } });
  res.status(201).json({ sticker });
});

router.delete('/:guildId/stickers/:stickerId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_EXPRESSIONS, 'You need Manage Emoji & Stickers to delete stickers.');
  const sticker = db.get('SELECT * FROM stickers WHERE id = ? AND guild_id = ?', [Number(req.params.stickerId), req.guild.id]);
  if (!sticker) return res.status(404).json({ error: 'Unknown sticker.', code: 'UNKNOWN_STICKER' });
  db.run('DELETE FROM stickers WHERE id = ?', [sticker.id]);
  bus.toGuild(req.guild.id, { type: 'GUILD_STICKERS_UPDATE', data: { guild_id: String(req.guild.id), sticker_id: String(sticker.id), deleted: true } });
  res.json({ ok: true });
});

router.post('/:guildId/soundboard', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_EXPRESSIONS, 'You need Manage Emoji & Stickers to add sounds.');
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Sounds need a name.', code: 'INVALID_SOUND_NAME' });
  if (!body.file || !isValidUrl(body.file)) return res.status(400).json({ error: 'file must be an uploaded audio URL.', code: 'INVALID_FILE' });
  const id = db.insert('soundboard_sounds', {
    guild_id: req.guild.id, name, file: String(body.file).slice(0, 500),
    volume: Math.max(0, Math.min(1, Number(body.volume) || 1)), emoji: body.emoji ? String(body.emoji).slice(0, 32) : null,
    creator_id: req.user.id, created_at: now(),
  });
  const sound = serialize.serializeSound(db.get('SELECT * FROM soundboard_sounds WHERE id = ?', [id]));
  bus.toGuild(req.guild.id, { type: 'GUILD_SOUNDBOARD_UPDATE', data: { guild_id: String(req.guild.id), sound } });
  res.status(201).json({ sound });
});

router.delete('/:guildId/soundboard/:soundId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_EXPRESSIONS, 'You need Manage Emoji & Stickers to delete sounds.');
  const sound = db.get('SELECT * FROM soundboard_sounds WHERE id = ? AND guild_id = ?', [Number(req.params.soundId), req.guild.id]);
  if (!sound) return res.status(404).json({ error: 'Unknown sound.', code: 'UNKNOWN_SOUND' });
  db.run('DELETE FROM soundboard_sounds WHERE id = ?', [sound.id]);
  bus.toGuild(req.guild.id, { type: 'GUILD_SOUNDBOARD_UPDATE', data: { guild_id: String(req.guild.id), sound_id: String(sound.id), deleted: true } });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

router.get('/:guildId/webhooks', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_WEBHOOKS, 'You need Manage Webhooks to list webhooks.');
  const rows = db.all(
    `SELECT w.*, c.name AS channel_name FROM webhooks w LEFT JOIN channels c ON c.id = w.channel_id
     WHERE w.guild_id = ? ORDER BY w.id DESC`, [req.guild.id]);
  res.json({ webhooks: rows.map(serializeWebhook) });
});

router.post('/:guildId/webhooks', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_WEBHOOKS, 'You need Manage Webhooks to create webhooks.');
  const body = req.body || {};
  const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(body.channel_id), req.guild.id]);
  if (!channel) return res.status(400).json({ error: 'Pick a channel in this server.', code: 'UNKNOWN_CHANNEL' });
  if (![0, 2, 5, 15].includes(channel.type)) return res.status(400).json({ error: 'Webhooks only work in text channels.', code: 'WRONG_CHANNEL_TYPE' });
  const id = db.insert('webhooks', {
    guild_id: req.guild.id, channel_id: channel.id,
    name: String(body.name || 'Webhook').trim().slice(0, 80) || 'Webhook',
    avatar: body.avatar && isValidUrl(body.avatar) ? body.avatar : null,
    token: randomId(32), creator_id: req.user.id, created_at: now(),
  });
  const webhook = serializeWebhook(db.get('SELECT * FROM webhooks WHERE id = ?', [id]));
  res.status(201).json({ webhook });
});

router.patch('/:guildId/webhooks/:webhookId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_WEBHOOKS, 'You need Manage Webhooks to edit webhooks.');
  const hook = db.get('SELECT * FROM webhooks WHERE id = ? AND guild_id = ?', [Number(req.params.webhookId), req.guild.id]);
  if (!hook) return res.status(404).json({ error: 'Unknown webhook.', code: 'UNKNOWN_WEBHOOK' });
  const body = req.body || {};
  const updates = {};
  if (body.name !== undefined) updates.name = String(body.name).trim().slice(0, 80) || hook.name;
  if (body.avatar !== undefined) updates.avatar = body.avatar && isValidUrl(body.avatar) ? body.avatar : null;
  if (body.channel_id !== undefined) {
    const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(body.channel_id), req.guild.id]);
    if (!channel) return res.status(400).json({ error: 'Unknown channel.', code: 'UNKNOWN_CHANNEL' });
    updates.channel_id = channel.id;
  }
  if (Object.keys(updates).length) db.update('webhooks', hook.id, updates);
  res.json({ webhook: serializeWebhook(db.get('SELECT * FROM webhooks WHERE id = ?', [hook.id])) });
});

router.delete('/:guildId/webhooks/:webhookId', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_WEBHOOKS, 'You need Manage Webhooks to delete webhooks.');
  const hook = db.get('SELECT * FROM webhooks WHERE id = ? AND guild_id = ?', [Number(req.params.webhookId), req.guild.id]);
  if (!hook) return res.status(404).json({ error: 'Unknown webhook.', code: 'UNKNOWN_WEBHOOK' });
  db.run('DELETE FROM webhooks WHERE id = ?', [hook.id]);
  res.json({ ok: true });
});

function serializeWebhook(row) {
  return {
    id: String(row.id),
    type: 1,
    guild_id: row.guild_id ? String(row.guild_id) : null,
    channel_id: String(row.channel_id),
    name: row.name,
    avatar: row.avatar,
    token: row.token,
    creator_id: row.creator_id ? String(row.creator_id) : null,
    created_at: row.created_at,
    channel_name: row.channel_name || null,
    url: `/api/webhooks/${row.id}/${row.token}`,
  };
}

/* ------------------------------------------------------------------ *
 * Invites
 * ------------------------------------------------------------------ */

router.get('/:guildId/invites', guildContext(), (req, res) => {
  const rows = db.all(
    `SELECT i.*, u.username, u.display_name FROM invites i
     LEFT JOIN users u ON u.id = i.inviter_id WHERE i.guild_id = ? ORDER BY i.created_at DESC`, [req.guild.id]);
  res.json({
    invites: rows.map((row) => ({
      code: row.code,
      channel_id: row.channel_id ? String(row.channel_id) : null,
      guild_id: String(row.guild_id),
      inviter: row.inviter_id ? serialize.userBrief({ id: row.inviter_id, username: row.username, display_name: row.display_name }) : null,
      uses: row.uses,
      max_uses: row.max_uses,
      max_age: row.max_age,
      temporary: !!row.temporary,
      created_at: row.created_at,
      expires_at: row.expires_at,
    })),
  });
});

router.post('/:guildId/invites', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.CREATE_INSTANT_INVITE, 'You need Create Invite to do that.');
  const body = req.body || {};
  let channelId = body.channel_id ? Number(body.channel_id) : req.guild.system_channel_id || null;
  if (!channelId) {
    const first = db.get('SELECT id FROM channels WHERE guild_id = ? AND type IN (0, 2, 5) ORDER BY position LIMIT 1', [req.guild.id]);
    channelId = first ? first.id : null;
  }
  if (channelId) {
    const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [channelId, req.guild.id]);
    if (!channel) return res.status(400).json({ error: 'Unknown channel.', code: 'UNKNOWN_CHANNEL' });
    channelId = channel.id;
  }
  const maxAge = Math.max(0, intOr(body.max_age, 0));
  const code = auth.makeInviteCode();
  db.insert('invites', {
    code, guild_id: req.guild.id, channel_id: channelId, inviter_id: req.user.id,
    max_uses: Math.max(0, intOr(body.max_uses, 0)), max_age: maxAge,
    temporary: flag(body.temporary) ? 1 : 0, created_at: now(),
    expires_at: maxAge > 0 ? now() + maxAge * 1000 : null,
  });
  guilds.audit(req.guild.id, req.user.id, 'INVITE_CREATE', { targetId: null, targetType: 'invite', changes: [{ key: 'code', before: null, after: code }] });
  res.status(201).json({ code, max_uses: Math.max(0, intOr(body.max_uses, 0)), max_age: maxAge });
});

router.delete('/:guildId/invites/:code', guildContext(), (req, res) => {
  perms.assertPermission(req.guildPerms, P.MANAGE_GUILD, 'You need Manage Server to revoke invites.');
  db.run('DELETE FROM invites WHERE code = ? AND guild_id = ?', [String(req.params.code), req.guild.id]);
  guilds.audit(req.guild.id, req.user.id, 'INVITE_DELETE', { targetType: 'invite', changes: [{ key: 'code', before: String(req.params.code), after: null }] });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Public preview (for the invite landing page)
 * ------------------------------------------------------------------ */

router.get('/:guildId/widget.json', guildContext({ requireMembership: false }), (req, res) => {
  const members = state.membersPayload(req.guild.id, { limit: 25 });
  res.json({
    id: String(req.guild.id),
    name: req.guild.name,
    instant_invite: req.guild.vanity_url ? `/invite/${req.guild.vanity_url}` : null,
    presence_count: members.length,
    members: members.map((m) => ({ id: m.user_id, username: m.user.username, avatar: m.user.avatar, status: 'online' })),
    description: req.guild.description,
    icon: req.guild.icon,
    banner: req.guild.banner,
  });
});

module.exports = router;
module.exports.serializeWebhook = serializeWebhook;
module.exports.ALL_PERMISSIONS = ALL;
