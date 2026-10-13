'use strict';
const db = require('./db');
const config = require('./config');
const { now, slugify } = require('./util');
const { EVERYONE_DEFAULT, MODERATOR_DEFAULT } = require('./permissions');

/**
 * Server (guild) domain logic. Everything Discord puts behind boosts or
 * subscriptions is created here by default, for free, for every server:
 *  - 384 kbps voice, unlimited emoji/stickers/roles/channels
 *  - banner, animated icon, vanity URL, invite splash
 *  - soundboard, server tag, audit log
 */

const DEFAULT_EVERYONE_PERMS = EVERYONE_DEFAULT;
const MODERATOR_PERMS = MODERATOR_DEFAULT;

function uniqueVanity(base, guildId = null) {
  let slug = slugify(base, 'server').slice(0, 30);
  const candidate = (s) => db.get('SELECT id FROM guilds WHERE vanity_url = ? AND id IS NOT ?', [s, guildId]);
  if (!candidate(slug)) return slug;
  for (let i = 2; i < 500; i += 1) {
    const next = `${slug.slice(0, 25)}-${i}`;
    if (!candidate(next)) return next;
  }
  return `${slug.slice(0, 20)}-${Date.now().toString(36)}`;
}

function createGuild({ name, ownerId, icon = null, description = '', template = 'default' }) {
  const guildName = String(name || '').trim().slice(0, 100);
  if (guildName.length < 2) {
    const err = new Error('Server names must be at least 2 characters.');
    err.status = 400;
    err.code = 'INVALID_GUILD_NAME';
    throw err;
  }
  const owned = db.get('SELECT COUNT(*) AS c FROM guilds WHERE owner_id = ?', [ownerId]).c;
  if (owned >= config.maxGuildsPerUser) {
    const err = new Error(`You can own up to ${config.maxGuildsPerUser} servers on this instance. Delete one to make room.`);
    err.status = 403;
    err.code = 'GUILD_LIMIT';
    throw err;
  }

  const ts = now();
  return db.tx(() => {
    const guildId = db.insert('guilds', {
      name: guildName,
      icon,
      description: String(description || '').slice(0, 300),
      owner_id: ownerId,
      created_at: ts,
      boost_level: 3,
      vanity_url: uniqueVanity(guildName),
      afk_timeout: 300,
      discovery: 1,
      tags: '[]',
    });

    const everyoneRole = db.createEveryoneRole(guildId);

    // The owner gets everything by virtue of owning the server, plus an
    // explicit admin role so the role list looks familiar.
    const adminRole = db.insert('roles', {
      guild_id: guildId, name: 'Owner', color: 0xfee75c, position: 100,
      permissions: MODERATOR_PERMS.toString(), hoist: 0, mentionable: 1,
    });
    db.insert('roles', {
      guild_id: guildId, name: 'Moderator', color: 0x5865f2, position: 50,
      permissions: MODERATOR_PERMS.toString(), hoist: 1, mentionable: 1,
    });

    db.insert('guild_members', {
      guild_id: guildId, user_id: ownerId, joined_at: ts,
      role_ids: JSON.stringify([adminRole, everyoneRole]), nickname: null,
    });

    const layout = template === 'empty' ? [] : defaultLayout();
    const ids = {};
    for (const entry of layout) {
      const id = db.insert('channels', {
        guild_id: guildId,
        parent_id: entry.parent ? ids[entry.parent] : null,
        name: entry.name,
        topic: entry.topic || '',
        type: entry.type,
        position: entry.position,
        user_limit: entry.user_limit || 0,
        bitrate: config.voiceBitrate,
        created_at: ts,
      });
      ids[entry.key] = id;
    }

    db.run('UPDATE guilds SET system_channel_id = ?, rules_channel_id = ? WHERE id = ?',
      [ids.general || null, ids.rules || null, guildId]);

    db.insert('audit_logs', {
      guild_id: guildId, user_id: ownerId, action: 'GUILD_CREATE', target_id: guildId,
      target_type: 'guild', reason: null, changes: '[]', created_at: ts,
    });

    if (ids.general) {
      insertMessage({
        channelId: ids.general, guildId, authorId: ownerId, system: true,
        content: `Welcome to **${guildName}**! This server runs on Bla, so every boost perk is already unlocked for free.`,
      });
    }

    return guildId;
  });
}

function defaultLayout() {
  return [
    { key: 'text_cat', name: 'Text Channels', type: 4, position: 0 },
    { key: 'general', name: 'general', type: 0, position: 0, parent: 'text_cat', topic: 'General chatter' },
    { key: 'rules', name: 'rules', type: 0, position: 1, parent: 'text_cat', topic: 'Read before posting' },
    { key: 'voice_cat', name: 'Voice Channels', type: 4, position: 1 },
    { key: 'lounge', name: 'Lounge', type: 2, position: 0, parent: 'voice_cat' },
    { key: 'stage', name: 'Stage', type: 2, position: 1, parent: 'voice_cat' },
  ];
}

/** Minimal insert used by guilds.js to avoid importing the message router. */
function insertMessage({ channelId, guildId, authorId = null, content = '', system = false, type = 0 }) {
  const ts = now();
  const id = db.insert('messages', {
    channel_id: channelId,
    guild_id: guildId,
    author_id: authorId,
    content,
    type,
    system: system ? 1 : 0,
    created_at: ts,
    mentions: '[]',
    mention_roles: '[]',
    embeds: '[]',
  });
  db.run('UPDATE channels SET last_message_id = ? WHERE id = ?', [id, channelId]);
  return id;
}

function addMember(guildId, userId, { invitedBy = null, roles = [] } = {}) {
  const existing = db.get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  if (existing) {
    const err = new Error('You are already a member of this server.');
    err.status = 409;
    err.code = 'ALREADY_MEMBER';
    throw err;
  }
  const ban = db.get('SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  if (ban) {
    const err = new Error('You are banned from this server.');
    err.status = 403;
    err.code = 'BANNED';
    throw err;
  }
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [guildId]);
  if (!guild) {
    const err = new Error('That server no longer exists.');
    err.status = 404;
    err.code = 'UNKNOWN_GUILD';
    throw err;
  }
  const ts = now();
  db.tx(() => {
    db.insert('guild_members', {
      guild_id: guildId, user_id: userId, joined_at: ts,
      role_ids: JSON.stringify(roles), nickname: null,
    });
    db.insert('audit_logs', {
      guild_id: guildId, user_id: invitedBy || userId, action: 'MEMBER_JOIN', target_id: userId,
      target_type: 'user', reason: null, changes: '[]', created_at: ts,
    });
    if (guild.system_channel_id) {
      const user = db.get('SELECT username, display_name FROM users WHERE id = ?', [userId]);
      insertMessage({
        channelId: guild.system_channel_id, guildId, authorId: userId, system: true,
        content: `**${user?.display_name || user?.username || 'Someone'}** joined the server.`,
      });
    }
  });
  return true;
}

function removeMember(guildId, userId, { kicker = null, reason = '' } = {}) {
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [guildId]);
  if (!guild) return;
  if (guild.owner_id === userId) {
    const err = new Error('The server owner cannot leave or be removed. Transfer ownership first.');
    err.status = 400;
    err.code = 'OWNER_CANNOT_LEAVE';
    throw err;
  }
  db.tx(() => {
    db.run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    db.run('DELETE FROM voice_states WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    db.run('DELETE FROM guild_read_states WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    db.run('DELETE FROM members_read_states WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    if (kicker) {
      db.insert('audit_logs', {
        guild_id: guildId, user_id: kicker, action: 'MEMBER_REMOVE', target_id: userId,
        target_type: 'user', reason: reason || null, changes: '[]', created_at: now(),
      });
    }
  });
}

function deleteGuild(guildId) {
  db.tx(() => {
    db.run('DELETE FROM guilds WHERE id = ?', [guildId]);
  });
}

function postSystemMessage(guildId, content) {
  const guild = db.get('SELECT system_channel_id FROM guilds WHERE id = ?', [guildId]);
  if (!guild?.system_channel_id) return null;
  return insertMessage({ channelId: guild.system_channel_id, guildId, system: true, content });
}

function audit(guildId, userId, action, { targetId = null, targetType = null, reason = null, changes = [] } = {}) {
  db.insert('audit_logs', {
    guild_id: guildId, user_id: userId, action, target_id: targetId, target_type: targetType,
    reason: reason || null, changes: JSON.stringify(changes), created_at: now(),
  });
}

/** Which guilds does this user belong to? */
function guildsForUser(userId) {
  return db.all(
    `SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id = g.id
     WHERE m.user_id = ? ORDER BY g.id ASC`, [userId]);
}

function memberRoleIds(member) {
  try { return JSON.parse(member?.role_ids || '[]').map(Number); } catch { return []; }
}

module.exports = {
  createGuild, addMember, removeMember, deleteGuild, postSystemMessage, audit,
  guildsForUser, insertMessage, memberRoleIds, uniqueVanity, defaultLayout,
  DEFAULT_EVERYONE_PERMS, MODERATOR_PERMS,
};
