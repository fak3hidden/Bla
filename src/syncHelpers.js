'use strict';
const db = require('./db');
const perms = require('./perms');
const serialize = require('./serialize');

/**
 * Read-state + unread bookkeeping. Every channel stores the last message the
 * user has seen; mention counts are recomputed from mentions arrays.
 */
function guildReadStates(userId, guildId) {
  const channels = db.all('SELECT id, last_message_id FROM channels WHERE guild_id = ?', [guildId]);
  const states = [];
  const guildState = db.get('SELECT * FROM guild_read_states WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
  const memberState = db.get('SELECT * FROM members_read_states WHERE user_id = ? AND guild_id = ?', [userId, guildId]);

  for (const channel of channels) {
    const read = db.get('SELECT * FROM read_states WHERE user_id = ? AND channel_id = ?', [userId, channel.id]);
    const lastMessageId = channel.last_message_id || 0;
    const lastRead = read ? read.last_message_id : 0;
    const mentionCount = countMentions(userId, channel.id, lastRead);
    states.push({
      channel_id: String(channel.id),
      last_message_id: lastMessageId ? String(lastMessageId) : null,
      last_read_message_id: lastRead ? String(lastRead) : null,
      mention_count: mentionCount,
      muted: !!(read && read.muted),
      unread: lastMessageId > lastRead,
      last_pin_seen: read?.last_pin_seen ? String(read.last_pin_seen) : null,
    });
  }

  return {
    guild_id: String(guildId),
    guild: guildState ? {
      last_viewed: guildState.last_viewed,
      muted: !!guildState.muted,
      unread: states.some((s) => s.unread),
      mention_count: states.reduce((sum, s) => sum + s.mention_count, 0),
    } : { last_viewed: 0, muted: false, unread: states.some((s) => s.unread), mention_count: 0 },
    members_last_viewed: memberState ? memberState.last_viewed : 0,
    channels: states,
  };
}

function countMentions(userId, channelId, afterMessageId) {
  const rows = db.all(
    `SELECT mentions, mention_everyone, mention_roles, author_id FROM messages
     WHERE channel_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 500`,
    [channelId, afterMessageId]);
  let count = 0;
  for (const row of rows) {
    if (String(row.author_id) === String(userId)) continue;
    if (row.mention_everyone) { count += 1; continue; }
    let mentions = [];
    try { mentions = JSON.parse(row.mentions || '[]'); } catch { mentions = []; }
    if (mentions.some((id) => String(id) === String(userId))) { count += 1; continue; }
    let roleIds = [];
    try { roleIds = JSON.parse(row.mention_roles || '[]'); } catch { roleIds = []; }
    if (roleIds.length) {
      const member = db.get('SELECT role_ids FROM guild_members WHERE guild_id = (SELECT guild_id FROM channels WHERE id = ?) AND user_id = ?', [channelId, userId]);
      if (member) {
        let mine = [];
        try { mine = JSON.parse(member.role_ids || '[]'); } catch { mine = []; }
        if (roleIds.some((r) => mine.map(String).includes(String(r)))) count += 1;
      }
    }
  }
  return count;
}

/** DM / group-DM sidebar payload. */
function dmChannelsForUser(userId) {
  const rows = db.all(
    `SELECT c.* FROM channels c JOIN dm_recipients r ON r.channel_id = c.id
     WHERE r.user_id = ? ORDER BY c.last_message_id DESC`, [userId]);
  return rows.map((channel) => {
    const recipients = db.all(
      `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.accent_color, u.is_bot
       FROM dm_recipients r JOIN users u ON u.id = r.user_id
       WHERE r.channel_id = ? AND r.user_id != ?`, [channel.id, userId]);
    const read = db.get('SELECT * FROM read_states WHERE user_id = ? AND channel_id = ?', [userId, channel.id]);
    const last = channel.last_message_id
      ? db.get(`${serialize.MESSAGE_SELECT} AND m.channel_id = ? ORDER BY m.id DESC LIMIT 1`, [channel.id])
      : null;
    const hydrated = last ? serialize.hydrateMessages([last], { currentUserId: userId })[0] : null;
    return {
      ...serialize.serializeChannel(channel, { type: channel.type === 1 && recipients.length > 1 ? 3 : channel.type }),
      recipients: recipients.map((r) => serialize.userBrief(r)),
      last_message: hydrated,
      unread: (channel.last_message_id || 0) > (read?.last_message_id || 0),
      mention_count: countMentions(userId, channel.id, read?.last_message_id || 0),
      muted: !!(read && read.muted),
    };
  });
}

function readState(userId, channelId) {
  const row = db.get('SELECT * FROM read_states WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
  return row || { user_id: userId, channel_id: channelId, last_message_id: 0, mention_count: 0, muted: 0, last_pin_seen: 0 };
}

module.exports = { guildReadStates, countMentions, dmChannelsForUser, readState };
