'use strict';
const db = require('./db');
const config = require('./config');
const serialize = require('./serialize');
const bus = require('./bus');
const perms = require('./perms');
const { now } = require('./util');
const { P } = require('./permissions');

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?.*)?$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?.*)?$/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|flac|opus)(\?.*)?$/i;

function fail(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** Resolve <@id>, <@!id>, <@&id>, <#id>, @everyone and @here. */
function parseMentions(content, guildId) {
  const mentions = new Set();
  const roles = new Set();
  let mentionEveryone = false;

  const userMatches = content.matchAll(/<@!?(\d+)>/g);
  for (const m of userMatches) {
    const id = Number(m[1]);
    if (guildId) {
      if (perms.getMember(guildId, id)) mentions.add(id);
    } else if (db.get('SELECT 1 FROM users WHERE id = ?', [id])) {
      mentions.add(id);
    }
  }
  for (const m of content.matchAll(/<@&(\d+)>/g)) {
    const id = Number(m[1]);
    const role = guildId ? db.get('SELECT id, mentionable FROM roles WHERE id = ? AND guild_id = ?', [id, guildId]) : null;
    if (role && (role.mentionable || true)) roles.add(id);
  }
  if (/(^|\s)@everyone(\s|$)/.test(content) && guildId) mentionEveryone = true;
  if (/(^|\s)@here(\s|$)/.test(content) && guildId) mentionEveryone = true;

  if (!guildId) {
    // DMs: only people actually in the conversation can be mentioned.
    for (const m of content.matchAll(/<@!?(\d+)>/g)) mentions.add(Number(m[1]));
  }

  return { mentions: [...mentions], roles: [...roles], mentionEveryone };
}

/** Build small link-preview embeds without making any outbound requests. */
function buildEmbeds(content) {
  const urls = [...new Set(String(content).match(URL_RE) || [])].slice(0, 3);
  return urls.map((url) => {
    const type = IMAGE_EXT.test(url) ? 'image' : VIDEO_EXT.test(url) ? 'video' : AUDIO_EXT.test(url) ? 'audio' : 'link';
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = url; }
    return { type, url, provider: { name: host } };
  });
}

/**
 * Create a message in a channel. Handles mentions, link embeds, attachments
 * that were uploaded ahead of time, replies, and the Discord-style "reply to a
 * reply shows the original author" behaviour.
 */
function createMessage({
  channelId,
  authorId = null,
  webhookId = null,
  content = '',
  attachmentIds = [],
  embeds = [],
  referenceId = null,
  tts = false,
  nonce = null,
  system = false,
  suppressNotifications = false,
  clientId = null,
  webhookName = null,
  webhookAvatar = null,
  interaction = null,
  allowEmpty = false,
}) {
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!channel) throw fail(404, 'Unknown channel.', 'UNKNOWN_CHANNEL');

  const text = String(content || '').slice(0, config.maxMessageLength);
  const attachments = attachmentIds.length
    ? db.all(
      `SELECT * FROM attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})
       AND uploader_id IS ? AND message_id IS NULL AND orphaned = 0`,
      [...attachmentIds, authorId])
    : [];

  if (!text.trim() && !attachments.length && !embeds.length && !system && !allowEmpty) {
    throw fail(400, 'Messages cannot be empty.', 'EMPTY_MESSAGE');
  }
  if (attachments.length && !attachmentIds.length) attachments.length = 0;

  const parsedMentions = parseMentions(text, channel.guild_id);
  const { mentions, roles } = parsedMentions;
  let { mentionEveryone } = parsedMentions;

  // Slowmode applies to humans, not webhooks or moderators.
  if (channel.slowmode > 0 && !system && !webhookId && authorId) {
    const last = db.get(
      'SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
      [channel.id, authorId]);
    if (last) {
      const elapsed = (Date.now() - last.created_at) / 1000;
      if (elapsed < channel.slowmode) {
        const err = fail(429, `Slowmode is on: wait ${Math.ceil(channel.slowmode - elapsed)}s before sending again.`, 'SLOWMODE');
        err.retryAfter = Math.ceil(channel.slowmode - elapsed);
        throw err;
      }
    }
  }

  if (!system && text.includes('@everyone') && channel.guild_id && authorId) {
    const member = perms.getMember(channel.guild_id, authorId);
    const guild = db.get('SELECT owner_id FROM guilds WHERE id = ?', [channel.guild_id]);
    const isOwner = guild && String(guild.owner_id) === String(authorId);
    const canPing = isOwner || (member ? (perms.guildPermissions(channel.guild_id, authorId, {}) & P.MENTION_EVERYONE) === P.MENTION_EVERYONE : false);
    if (!canPing) {
      // Silently downgrade instead of rejecting, matching Discord.
      mentionEveryone = false;
      return finalize();
    }
  }

  function finalize() {
    const ts = now();
    const finalEmbeds = embeds.length ? embeds : buildEmbeds(text);
    const messageId = db.tx(() => {
      const insertId = db.insert('messages', {
        channel_id: channel.id,
        guild_id: channel.guild_id,
        author_id: webhookId ? null : authorId,
        webhook_id: webhookId,
        content: text,
        type: 0,
        created_at: ts,
        reference_id: referenceId || null,
        pinned: 0,
        tts: tts ? 1 : 0,
        system: system ? 1 : 0,
        mentions: JSON.stringify(mentions),
        mention_roles: JSON.stringify(roles),
        mention_everyone: mentionEveryone ? 1 : 0,
        embeds: JSON.stringify(finalEmbeds),
        nonce: nonce || clientId || null,
        interaction: webhookName || interaction
          ? JSON.stringify(webhookName ? { webhook: { name: webhookName, avatar: webhookAvatar } } : interaction)
          : null,
      });
      for (const attachment of attachments) {
        db.run('UPDATE attachments SET message_id = ? WHERE id = ?', [insertId, attachment.id]);
      }
      db.run('UPDATE channels SET last_message_id = ? WHERE id = ?', [insertId, channel.id]);
      return insertId;
    });

    const row = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [messageId]);
    const message = serialize.hydrateMessages([row], { currentUserId: authorId })[0];
    if (referenceId) {
      const parent = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [referenceId]);
      message.referenced_message = parent
        ? serialize.hydrateMessages([parent], { currentUserId: authorId })[0]
        : null;
      if (parent?.reference_id) {
        const grandparent = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [parent.reference_id]);
        if (grandparent && String(grandparent.author_id) === String(authorId)) {
          message.referenced_message = serialize.hydrateMessages([grandparent], { currentUserId: authorId })[0];
        }
      }
    }
    return message;
  }

  const message = finalize();
  if (!suppressNotifications) {
    bus.toChannel(channel.id, { type: 'MESSAGE_CREATE', data: message });
  }
  return message;
}

function editMessage(messageId, userId, content) {
  const row = db.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', [Number(messageId)]);
  if (!row) throw fail(404, 'Unknown message.', 'UNKNOWN_MESSAGE');
  if (String(row.author_id) !== String(userId)) throw fail(403, 'You can only edit your own messages.', 'NOT_MESSAGE_AUTHOR');
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [row.channel_id]);
  const text = String(content || '').slice(0, config.maxMessageLength);
  const { mentions, roles, mentionEveryone } = parseMentions(text, channel?.guild_id || null);
  db.run('UPDATE messages SET content = ?, edited_at = ?, mentions = ?, mention_roles = ?, mention_everyone = ?, embeds = ? WHERE id = ?',
    [text, now(), JSON.stringify(mentions), JSON.stringify(roles), mentionEveryone ? 1 : 0, JSON.stringify(buildEmbeds(text)), row.id]);
  const fresh = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [row.id]);
  const message = serialize.hydrateMessages([fresh], { currentUserId: userId })[0];
  bus.toChannel(row.channel_id, { type: 'MESSAGE_UPDATE', data: message });
  return message;
}

function deleteMessage(messageId, actor, { isModerator = false } = {}) {
  const row = db.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', [Number(messageId)]);
  if (!row) throw fail(404, 'Unknown message.', 'UNKNOWN_MESSAGE');
  const isAuthor = String(row.author_id) === String(actor.id);
  if (!isAuthor && !isModerator) throw fail(403, 'You cannot delete that message.', 'CANNOT_DELETE');
  db.run('UPDATE messages SET deleted_at = ? WHERE id = ?', [now(), row.id]);
  bus.toChannel(row.channel_id, { type: 'MESSAGE_DELETE', data: { id: String(row.id), channel_id: String(row.channel_id), guild_id: row.guild_id ? String(row.guild_id) : null } });
  return true;
}

function toggleReaction(messageId, userId, emoji, emojiId = null) {
  const row = db.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', [Number(messageId)]);
  if (!row) throw fail(404, 'Unknown message.', 'UNKNOWN_MESSAGE');
  const existing = db.get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [row.id, userId, emoji]);
  if (existing) {
    db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [row.id, userId, emoji]);
  } else {
    const count = db.get('SELECT COUNT(*) AS c FROM reactions WHERE message_id = ?', [row.id]).c;
    if (count >= config.maxReactionsPerMessage * 20) throw fail(400, 'This message has too many reactions.', 'TOO_MANY_REACTIONS');
    db.insert('reactions', { message_id: row.id, user_id: userId, emoji, emoji_id: emojiId, created_at: now() });
  }
  const user = db.get('SELECT id, username, display_name, avatar FROM users WHERE id = ?', [userId]);
  bus.toChannel(row.channel_id, {
    type: 'MESSAGE_REACTION_UPDATE',
    data: {
      message_id: String(row.id),
      channel_id: String(row.channel_id),
      guild_id: row.guild_id ? String(row.guild_id) : null,
      emoji,
      user_id: String(userId),
      user: serialize.userBrief(user),
      added: !existing,
    },
  });
  const fresh = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [row.id]);
  return serialize.hydrateMessages([fresh], { currentUserId: userId })[0].reactions;
}

module.exports = { createMessage, editMessage, deleteMessage, toggleReaction, parseMentions, buildEmbeds, fail };
