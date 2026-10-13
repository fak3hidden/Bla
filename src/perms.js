'use strict';
const db = require('./db');
const { P, toBigInt, computeChannelPermissions } = require('./permissions');

function getMember(guildId, userId) {
  return db.get('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
}

function getRoles(guildId) {
  return db.all('SELECT * FROM roles WHERE guild_id = ? ORDER BY position DESC, id ASC', [guildId]);
}

function roleIdsOf(member) {
  try {
    const parsed = JSON.parse(member?.role_ids || '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Base guild permissions for a member: @everyone + their roles.
 * The guild owner and server admins always get everything.
 */
function guildPermissions(guildId, userId, { isOwner = false, isAdmin = false } = {}) {
  if (isOwner || isAdmin) return require('./permissions').ALL;
  const member = getMember(guildId, userId);
  if (!member) return 0n;

  const roles = getRoles(guildId);
  const everyone = roles.find((r) => r.is_everyone);
  const memberRoleIds = new Set(roleIdsOf(member));

  let perms = toBigInt(everyone?.permissions || 0);
  for (const role of roles) {
    if (role.is_everyone) continue;
    if (memberRoleIds.has(role.id)) perms |= toBigInt(role.permissions);
  }

  if (member.timeout_until && member.timeout_until > Date.now()) {
    // Timed-out members can still read, but cannot write/join voice.
    perms &= ~(P.SEND_MESSAGES | P.ADD_REACTIONS | P.SPEAK | P.STREAM | P.USE_SOUNDBOARD |
      P.SEND_VOICE_MESSAGES | P.CREATE_INSTANT_INVITE | P.SEND_POLLS);
  }
  return perms;
}

function overwritesFor(channelId) {
  const rows = db.all('SELECT * FROM permission_overwrites WHERE channel_id = ?', [channelId]);
  return {
    everyone: rows.find((r) => r.target_type === 'role' && String(r.target_id) === String(everyoneRoleIdOfChannel(channelId))),
    roles: rows.filter((r) => r.target_type === 'role'),
    members: rows.filter((r) => r.target_type === 'member'),
  };
}

const everyoneRoleCache = new Map();
function everyoneRoleIdOfChannel(channelId) {
  const channel = db.get('SELECT guild_id FROM channels WHERE id = ?', [channelId]);
  if (!channel || !channel.guild_id) return -1;
  let roleId = everyoneRoleCache.get(channel.guild_id);
  if (roleId === undefined) {
    const row = db.get('SELECT id FROM roles WHERE guild_id = ? AND is_everyone = 1', [channel.guild_id]);
    roleId = row ? row.id : -1;
    everyoneRoleCache.set(channel.guild_id, roleId);
  }
  return roleId;
}

function invalidateEveryoneCache(guildId) {
  everyoneRoleCache.delete(guildId);
}

/** Effective permissions in one channel, including overwrites. */
function channelPermissions(channel, userId, member, basePerms) {
  if (!channel) return 0n;
  if (!channel.guild_id) return toBigInt(require('./permissions').ALL); // DM: access is decided by recipient list

  const rows = db.all('SELECT * FROM permission_overwrites WHERE channel_id = ?', [channel.id]);
  const everyoneId = everyoneRoleIdOfChannel(channel.id);
  const memberRoleIds = new Set(roleIdsOf(member));

  const everyoneOverwrite = rows.find((r) => r.target_type === 'role' && r.target_id === everyoneId) || null;
  const roleOverwrites = rows.filter((r) => r.target_type === 'role' && r.target_id !== everyoneId && memberRoleIds.has(r.target_id));
  const memberOverwrite = rows.find((r) => r.target_type === 'member' && Number(r.target_id) === Number(userId)) || null;

  return computeChannelPermissions({
    everyonePermissions: basePerms,
    rolePermissions: [],
    everyoneOverwrite,
    roleOverwrites,
    memberOverwrite,
  });
}

function canViewChannel(channel, userId, member, basePerms) {
  if (!channel) return false;
  if (!channel.guild_id) {
    return !!db.get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [channel.id, userId]);
  }
  const perms = channelPermissions(channel, userId, member, basePerms);
  return (toBigInt(perms) & P.VIEW_CHANNEL) === P.VIEW_CHANNEL;
}

function assertPermission(perms, permission, message = 'You do not have permission to do that.') {
  const bits = toBigInt(perms);
  const need = toBigInt(permission);
  if ((bits & P.ADMINISTRATOR) === P.ADMINISTRATOR) return;
  if ((bits & need) !== need) {
    const err = new Error(message);
    err.status = 403;
    err.code = 'MISSING_PERMISSIONS';
    throw err;
  }
}

/** Highest role position of a member (used to stop role/permission escalation). */
function highestRolePosition(guildId, member) {
  const roles = getRoles(guildId);
  const ids = new Set(roleIdsOf(member));
  let top = 0;
  for (const role of roles) {
    if (role.is_everyone) continue;
    if (ids.has(role.id)) top = Math.max(top, role.position);
  }
  return top;
}

module.exports = {
  getMember, getRoles, roleIdsOf, guildPermissions, channelPermissions, canViewChannel,
  assertPermission, highestRolePosition, invalidateEveryoneCache,
};
