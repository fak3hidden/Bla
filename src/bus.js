'use strict';

/**
 * Realtime fan-out. The gateway registers itself here so REST routes can push
 * events without knowing anything about WebSocket internals.
 */
let gateway = null;

function setGateway(gw) {
  gateway = gw;
}

function toGuild(guildId, payload) {
  if (gateway) gateway.dispatchGuild(String(guildId), payload);
}

function toUser(userId, payload) {
  if (gateway) gateway.dispatchUser(String(userId), payload);
}

function toUsers(userIds, payload) {
  if (!gateway) return;
  const seen = new Set();
  for (const id of userIds) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    gateway.dispatchUser(key, payload);
  }
}

/** Everyone who can see a channel (guild members with access, or DM recipients). */
function toChannel(channelId, payload, { exceptUserId = null } = {}) {
  if (gateway) gateway.dispatchChannel(String(channelId), payload, { exceptUserId });
}

function toAll(payload) {
  if (gateway) gateway.dispatchAll(payload);
}

/** Everyone whose client considers `userId` a friend (presence updates). */
function presence(userId, payload) {
  if (!gateway) return;
  const db = require('./db');
  const rows = db.all(
    `SELECT user_id FROM relationships WHERE target_id = ? AND type = 1
     UNION SELECT target_id FROM relationships WHERE user_id = ? AND type = 1`,
    [userId, userId]);
  toUsers([...rows.map((r) => r.user_id), userId], payload);
}

module.exports = { setGateway, toGuild, toUser, toUsers, toChannel, toAll, presence };
