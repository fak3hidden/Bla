'use strict';
const db = require('./db');
const perms = require('./perms');
const { parseId } = require('./util');

function fail(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function loadGuild(guildId) {
  const id = parseId(guildId);
  if (!id) throw fail(400, 'Invalid server id.', 'INVALID_ID');
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [id]);
  if (!guild) throw fail(404, 'Unknown server.', 'UNKNOWN_GUILD');
  return guild;
}

/**
 * Attach req.guild / req.member / req.guildPerms for /api/guilds/:guildId routes.
 * Users must be a member unless the route is marked as public.
 */
function guildContext({ requireMembership = true } = {}) {
  return (req, res, next) => {
    try {
      const guild = loadGuild(req.params.guildId);
      req.guild = guild;
      req.member = perms.getMember(guild.id, req.user.id);
      req.isOwner = String(guild.owner_id) === String(req.user.id);
      if (requireMembership && !req.member) {
        throw fail(403, 'You are not a member of that server.', 'NOT_A_MEMBER');
      }
      req.guildPerms = req.member || req.isOwner
        ? perms.guildPermissions(guild.id, req.user.id, { isOwner: req.isOwner, isAdmin: req.user.is_admin })
        : 0n;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Attach req.channel plus guild/permission context for /api/channels/:channelId. */
function channelContext({ requireAccess = true, types = null } = {}) {
  return (req, res, next) => {
    try {
      const channelId = parseId(req.params.channelId);
      if (!channelId) throw fail(400, 'Invalid channel id.', 'INVALID_ID');
      const channel = db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
      if (!channel) throw fail(404, 'Unknown channel.', 'UNKNOWN_CHANNEL');
      if (types && !types.includes(channel.type)) {
        throw fail(400, 'That action does not work in this channel type.', 'WRONG_CHANNEL_TYPE');
      }
      req.channel = channel;

      if (!channel.guild_id) {
        const recipient = db.get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [channel.id, req.user.id]);
        if (!recipient) throw fail(403, 'You are not part of this conversation.', 'NOT_A_RECIPIENT');
        req.guild = null;
        req.guildPerms = require('./permissions').ALL;
        req.channelPerms = require('./permissions').ALL;
        req.member = null;
        return next();
      }

      const guild = loadGuild(channel.guild_id);
      req.guild = guild;
      req.member = perms.getMember(guild.id, req.user.id);
      req.isOwner = String(guild.owner_id) === String(req.user.id);
      if (!req.member && !req.user.is_admin) {
        throw fail(403, 'You are not a member of that server.', 'NOT_A_MEMBER');
      }
      req.guildPerms = perms.guildPermissions(guild.id, req.user.id, { isOwner: req.isOwner, isAdmin: req.user.is_admin });
      req.channelPerms = perms.channelPermissions(channel, req.user.id, req.member, req.guildPerms);
      if (requireAccess && !perms.canViewChannel(channel, req.user.id, req.member, req.guildPerms)) {
        throw fail(403, 'You do not have access to that channel.', 'NO_CHANNEL_ACCESS');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { guildContext, channelContext, loadGuild, fail };
