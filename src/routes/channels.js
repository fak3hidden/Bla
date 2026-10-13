'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const perms = require('../perms');
const serialize = require('../serialize');
const state = require('../guildState');
const sync = require('../syncHelpers');
const messages = require('../messages');
const bus = require('../bus');
const { channelContext } = require('../context');
const { P } = require('../permissions');
const { messageLimiter } = require('../ratelimit');
const { intOr, flag } = require('../gate');
const { now } = require('../util');

const router = express.Router();
router.use(auth.requireUser);

const TEXT_TYPES = [0, 1, 3, 5, 15];

/** Fetch one channel (with overwrites + DM recipients). */
router.get('/:channelId', channelContext(), (req, res) => {
  const payload = state.channelEditorPayload(req.channel);
  if (!req.channel.guild_id) {
    payload.recipients = db.all(
      `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.accent_color, u.is_bot
       FROM dm_recipients r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ?`, [req.channel.id])
      .map((r) => serialize.userBrief(r));
    payload.is_group_dm = payload.recipients.length > 1;
  }
  payload.my_permissions = req.channelPerms.toString();
  res.json({ channel: payload });
});

/** Message history with Discord-style pagination. */
router.get('/:channelId/messages', channelContext(), (req, res) => {
  if (!TEXT_TYPES.includes(req.channel.type)) {
    return res.status(400).json({ error: 'That channel has no message history.', code: 'WRONG_CHANNEL_TYPE' });
  }
  if (req.channel.guild_id && !(req.channelPerms & P.READ_MESSAGE_HISTORY) && !(req.channelPerms & P.ADMINISTRATOR)) {
    return res.json({ messages: [] });
  }
  const limit = Math.max(1, Math.min(100, intOr(req.query.limit, 50)));
  const before = intOr(req.query.before, null);
  const after = intOr(req.query.after, null);
  const around = intOr(req.query.around, null);

  let rows;
  if (around) {
    const half = Math.floor(limit / 2);
    const older = db.all(`${serialize.MESSAGE_SELECT} AND m.channel_id = ? AND m.id <= ? ORDER BY m.id DESC LIMIT ?`,
      [req.channel.id, around, half + 1]);
    const newer = db.all(`${serialize.MESSAGE_SELECT} AND m.channel_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`,
      [req.channel.id, around, half]);
    rows = [...newer.reverse(), ...older].sort((a, b) => a.id - b.id);
  } else if (after) {
    rows = db.all(`${serialize.MESSAGE_SELECT} AND m.channel_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`,
      [req.channel.id, after, limit]);
  } else {
    rows = db.all(`${serialize.MESSAGE_SELECT} AND m.channel_id = ? AND (? IS NULL OR m.id < ?) ORDER BY m.id DESC LIMIT ?`,
      [req.channel.id, before, before, limit]).reverse();
  }

  const hydrated = serialize.hydrateMessages(rows, { currentUserId: req.user.id });
  // Reply targets are cheap to inline for the page we just fetched.
  const byId = new Map(hydrated.map((m) => [m.id, m]));
  for (const msg of hydrated) {
    if (msg.reference && !byId.has(msg.reference.message_id)) {
      const parentRow = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [Number(msg.reference.message_id)]);
      msg.referenced_message = parentRow ? serialize.hydrateMessages([parentRow], { currentUserId: req.user.id })[0] : null;
    } else if (msg.reference) {
      msg.referenced_message = byId.get(msg.reference.message_id);
    }
  }
  res.json({ messages: hydrated, has_more: rows.length === limit });
});

router.post('/:channelId/messages', channelContext(), messageLimiter(), (req, res) => {
  if (!TEXT_TYPES.includes(req.channel.type)) {
    return res.status(400).json({ error: 'You cannot send messages there.', code: 'WRONG_CHANNEL_TYPE' });
  }
  const body = req.body || {};

  if (req.channel.guild_id) {
    perms.assertPermission(req.channelPerms, P.SEND_MESSAGES, 'You cannot send messages in this channel.');
    if (req.channel.is_locked) {
      return res.status(403).json({ error: 'This channel is locked.', code: 'CHANNEL_LOCKED' });
    }
  }

  let referenceId = null;
  if (body.message_reference && body.message_reference.message_id) {
    const parent = db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL',
      [Number(body.message_reference.message_id), req.channel.id]);
    if (parent) referenceId = parent.id;
  }

  const attachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.map(Number).filter(Boolean).slice(0, config.maxAttachmentCount)
    : [];
  if (attachmentIds.length && req.channel.guild_id) {
    perms.assertPermission(req.channelPerms, P.ATTACH_FILES, 'You cannot attach files in this channel.');
  }
  if (body.tts && req.channel.guild_id) {
    perms.assertPermission(req.channelPerms, P.SEND_TTS_MESSAGES, 'You cannot send text-to-speech messages here.');
  }

  // Polls: create the poll row keyed by the message id it belongs to.
  let poll = null;
  if (body.poll && typeof body.poll === 'object') {
    if (req.channel.guild_id) {
      perms.assertPermission(req.channelPerms, P.SEND_POLLS || P.SEND_MESSAGES, 'You cannot create polls in this channel.');
    }
    const question = String(body.poll.question || '').trim().slice(0, 300);
    const answers = (Array.isArray(body.poll.answers) ? body.poll.answers : [])
      .map((a) => ({ text: String(a?.text ?? a ?? '').trim().slice(0, 55) }))
      .filter((a) => a.text)
      .slice(0, 10)
      .map((a, index) => ({ id: index + 1, text: a.text }));
    if (question && answers.length >= 2) {
      poll = {
        question,
        answers,
        multi: flag(body.poll.allow_multiselect || body.poll.multi),
        duration: Math.max(0, Math.min(7 * 24 * 3600, intOr(body.poll.duration, 24 * 3600))),
      };
    }
  }

  const message = messages.createMessage({
    channelId: req.channel.id,
    authorId: req.user.id,
    content: body.content,
    attachmentIds,
    embeds: [],
    referenceId,
    tts: flag(body.tts),
    nonce: body.nonce || null,
    suppressNotifications: !!poll,
    allowEmpty: !!poll,
  });

  if (poll) {
    db.insert('polls', {
      id: message.id,
      channel_id: req.channel.id,
      guild_id: req.channel.guild_id || null,
      creator_id: req.user.id,
      question: poll.question,
      answers: JSON.stringify(poll.answers),
      multi: poll.multi ? 1 : 0,
      created_at: now(),
      expires_at: poll.duration ? now() + poll.duration * 1000 : null,
      ended: 0,
    });
    message.poll = serialize.serializePoll(db.get('SELECT * FROM polls WHERE id = ?', [message.id]), req.user.id);
    bus.toChannel(req.channel.id, { type: 'MESSAGE_CREATE', data: message });
  }

  if (req.channel.guild_id) {
    db.run(
      `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0`,
      [req.user.id, req.channel.id, message.id]);
  }
  res.status(201).json({ message });
});

router.get('/:channelId/messages/:messageId', channelContext(), (req, res) => {
  const row = db.get(`${serialize.MESSAGE_SELECT} AND m.channel_id = ? AND m.id = ?`,
    [req.channel.id, Number(req.params.messageId)]);
  if (!row) return res.status(404).json({ error: 'Unknown message.', code: 'UNKNOWN_MESSAGE' });
  res.json({ message: serialize.hydrateMessages([row], { currentUserId: req.user.id })[0] });
});

/** Pins */
router.get('/:channelId/pins', channelContext(), (req, res) => {
  const rows = db.all(`${serialize.MESSAGE_SELECT} AND m.channel_id = ? AND m.pinned = 1 ORDER BY m.id DESC LIMIT 50`,
    [req.channel.id]);
  res.json({ pins: serialize.hydrateMessages(rows, { currentUserId: req.user.id }) });
});

router.put('/:channelId/pins/:messageId', channelContext(), (req, res) => {
  if (req.channel.guild_id) perms.assertPermission(req.channelPerms, P.MANAGE_MESSAGES, 'You need Manage Messages to pin.');
  const row = db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL',
    [Number(req.params.messageId), req.channel.id]);
  if (!row) return res.status(404).json({ error: 'Unknown message.', code: 'UNKNOWN_MESSAGE' });
  if (row.pinned) return res.json({ ok: true });
  const pinCount = db.get('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ? AND pinned = 1', [req.channel.id]).c;
  if (pinCount >= 50) return res.status(400).json({ error: 'This channel already has 50 pinned messages.', code: 'PIN_LIMIT' });
  db.run('UPDATE messages SET pinned = 1 WHERE id = ?', [row.id]);
  const payload = { type: 'CHANNEL_PINS_UPDATE', data: { channel_id: String(req.channel.id), guild_id: row.guild_id ? String(row.guild_id) : null, message_id: String(row.id), pinned: true } };
  bus.toChannel(req.channel.id, payload);
  res.json({ ok: true });
});

router.delete('/:channelId/pins/:messageId', channelContext(), (req, res) => {
  if (req.channel.guild_id) perms.assertPermission(req.channelPerms, P.MANAGE_MESSAGES, 'You need Manage Messages to unpin.');
  const row = db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', [Number(req.params.messageId), req.channel.id]);
  if (!row) return res.status(404).json({ error: 'Unknown message.', code: 'UNKNOWN_MESSAGE' });
  db.run('UPDATE messages SET pinned = 0 WHERE id = ?', [row.id]);
  bus.toChannel(req.channel.id, { type: 'CHANNEL_PINS_UPDATE', data: { channel_id: String(req.channel.id), message_id: String(row.id), pinned: false } });
  res.json({ ok: true });
});

/** Typing indicator (REST fallback; the gateway has a VOICE-free TYPING op too). */
router.post('/:channelId/typing', channelContext(), (req, res) => {
  const payload = {
    type: 'TYPING_START',
    data: {
      channel_id: String(req.channel.id),
      guild_id: req.channel.guild_id ? String(req.channel.guild_id) : null,
      user_id: String(req.user.id),
      user: serialize.userBrief(req.user),
      member: { nickname: req.member?.nickname || null },
      timestamp: now(),
    },
  };
  bus.toChannel(req.channel.id, payload, { exceptUserId: String(req.user.id) });
  res.status(204).end();
});

/** Acknowledge messages (clears the unread badge). */
router.post('/:channelId/ack', channelContext(), (req, res) => {
  const body = req.body || {};
  const lastMessageId = Number(body.message_id || req.channel.last_message_id || 0);
  db.run(
    `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count, last_pin_seen)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0, last_pin_seen = excluded.last_pin_seen`,
    [req.user.id, req.channel.id, lastMessageId, Number(body.last_pin_seen || 0)]);
  if (req.channel.guild_id) {
    db.run(
      `INSERT INTO guild_read_states (user_id, guild_id, last_viewed) VALUES (?, ?, ?)
       ON CONFLICT(user_id, guild_id) DO UPDATE SET last_viewed = excluded.last_viewed`,
      [req.user.id, req.channel.guild_id, now()]);
  }
  res.json({ ok: true, channel_id: String(req.channel.id), last_message_id: String(lastMessageId) });
});

/** Mute / unmute a channel (and the whole server). */
router.put('/:channelId/mute', channelContext(), (req, res) => {
  const muted = flag((req.body || {}).muted, true) ? 1 : 0;
  db.run(
    `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count, muted)
     VALUES (?, ?, 0, 0, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET muted = excluded.muted`,
    [req.user.id, req.channel.id, muted]);
  res.json({ ok: true, muted: !!muted });
});

/** Bulk delete (moderation tool). */
router.post('/:channelId/messages/bulk-delete', channelContext(), (req, res) => {
  if (!req.channel.guild_id) return res.status(400).json({ error: 'Not available in DMs.', code: 'WRONG_CHANNEL_TYPE' });
  perms.assertPermission(req.channelPerms, P.MANAGE_MESSAGES, 'You need Manage Messages to delete messages.');
  const ids = Array.isArray((req.body || {}).messages) ? req.body.messages.map(Number).filter(Boolean).slice(0, 100) : [];
  if (!ids.length) return res.status(400).json({ error: 'Provide a list of message ids to delete.', code: 'NO_MESSAGES' });
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.all(`SELECT id, guild_id FROM messages WHERE channel_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
    [req.channel.id, ...ids]);
  db.run(`UPDATE messages SET deleted_at = ? WHERE channel_id = ? AND id IN (${placeholders})`,
    [now(), req.channel.id, ...ids]);
  bus.toChannel(req.channel.id, {
    type: 'MESSAGE_DELETE_BULK',
    data: { channel_id: String(req.channel.id), guild_id: String(req.channel.guild_id), ids: rows.map((r) => String(r.id)) },
  });
  res.json({ ok: true, deleted: rows.length });
});

/** DM channel management lives in `/api/dms`, but renaming works here too. */
router.patch('/:channelId', channelContext(), (req, res) => {
  const body = req.body || {};
  if (req.channel.guild_id) {
    perms.assertPermission(req.guildPerms, P.MANAGE_CHANNELS, 'You need Manage Channels to edit channels.');
    return res.status(400).json({ error: 'Use PATCH /api/guilds/:id/channels/:channelId for server channels.', code: 'USE_GUILD_ROUTE' });
  }
  const isGroup = db.get('SELECT COUNT(*) AS c FROM dm_recipients WHERE channel_id = ?', [req.channel.id]).c > 1;
  if (!isGroup && body.name !== undefined) {
    return res.status(400).json({ error: 'Direct messages have no name.', code: 'NOT_GROUP_DM' });
  }
  const updates = {};
  if (body.name !== undefined) updates.name = String(body.name || '').trim().slice(0, 100) || req.channel.name;
  if (body.icon !== undefined) updates.icon = body.icon ? String(body.icon).slice(0, 500) : null;
  if (Object.keys(updates).length) db.update('channels', req.channel.id, updates);
  const fresh = db.get('SELECT * FROM channels WHERE id = ?', [req.channel.id]);
  const payload = state.channelEditorPayload(fresh);
  bus.toChannel(req.channel.id, { type: 'CHANNEL_UPDATE', data: payload });
  res.json({ channel: payload });
});

module.exports = router;
