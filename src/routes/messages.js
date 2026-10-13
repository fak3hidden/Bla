'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const perms = require('../perms');
const serialize = require('../serialize');
const messages = require('../messages');
const bus = require('../bus');
const { P } = require('../permissions');
const { channelContext } = require('../context');
const { now } = require('../util');

const router = express.Router();
router.use(auth.requireUser);

function loadMessage(req, res) {
  const row = db.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', [Number(req.params.messageId)]);
  if (!row) {
    res.status(404).json({ error: 'Unknown message.', code: 'UNKNOWN_MESSAGE' });
    return null;
  }
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [row.channel_id]);
  if (!channel) {
    res.status(404).json({ error: 'That channel no longer exists.', code: 'UNKNOWN_CHANNEL' });
    return null;
  }
  req.message = row;
  req.messageChannel = channel;
  if (channel.guild_id) {
    const member = perms.getMember(channel.guild_id, req.user.id);
    if (!member && !req.user.is_admin) {
      res.status(403).json({ error: 'You are not a member of that server.', code: 'NOT_A_MEMBER' });
      return null;
    }
    req.guildPerms = perms.guildPermissions(channel.guild_id, req.user.id, {
      isOwner: false, isAdmin: req.user.is_admin,
    });
    req.channelPerms = perms.channelPermissions(channel, req.user.id, member, req.guildPerms);
  } else {
    const recipient = db.get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [channel.id, req.user.id]);
    if (!recipient) {
      res.status(403).json({ error: 'You are not part of this conversation.', code: 'NOT_A_RECIPIENT' });
      return null;
    }
    req.channelPerms = require('../permissions').ALL;
  }
  return row;
}

router.get('/:messageId', (req, res, next) => {
  if (!loadMessage(req, res)) return;
  const row = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [req.message.id]);
  const message = serialize.hydrateMessages([row], { currentUserId: req.user.id })[0];
  if (message.reference) {
    const parent = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [Number(message.reference.message_id)]);
    message.referenced_message = parent ? serialize.hydrateMessages([parent], { currentUserId: req.user.id })[0] : null;
  }
  res.json({ message });
});

router.patch('/:messageId', (req, res) => {
  if (!loadMessage(req, res)) return;
  const body = req.body || {};
  if (String(req.message.author_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'You can only edit your own messages.', code: 'NOT_MESSAGE_AUTHOR' });
  }
  if (req.messageChannel.guild_id) {
    perms.assertPermission(req.channelPerms, P.SEND_MESSAGES, 'You cannot send messages in this channel.');
  }
  const message = messages.editMessage(req.message.id, req.user.id, body.content ?? req.message.content);
  res.json({ message });
});

router.delete('/:messageId', (req, res) => {
  if (!loadMessage(req, res)) return;
  const isAuthor = String(req.message.author_id) === String(req.user.id);
  const isModerator = req.messageChannel.guild_id
    ? (req.channelPerms & P.MANAGE_MESSAGES) === P.MANAGE_MESSAGES
    : false;
  messages.deleteMessage(req.message.id, req.user, { isModerator });
  res.json({ ok: true });
});

/** Reactions */
router.put('/:messageId/reactions/:emoji/@me', (req, res) => {
  if (!loadMessage(req, res)) return;
  const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
  if (req.messageChannel.guild_id) {
    perms.assertPermission(req.channelPerms, P.ADD_REACTIONS, 'You cannot add reactions in this channel.');
  }
  const reactions = messages.toggleReaction(req.message.id, req.user.id, emoji);
  res.json({ reactions });
});

router.delete('/:messageId/reactions/:emoji/@me', (req, res) => {
  if (!loadMessage(req, res)) return;
  const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
  const reactions = messages.toggleReaction(req.message.id, req.user.id, emoji);
  res.json({ reactions });
});

router.delete('/:messageId/reactions/:emoji/:userId', (req, res) => {
  if (!loadMessage(req, res)) return;
  const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
  const targetId = Number(req.params.userId);
  if (String(targetId) !== String(req.user.id)) {
    if (!req.messageChannel.guild_id) {
      return res.status(403).json({ error: 'You cannot remove someone else\u2019s reaction here.', code: 'MISSING_PERMISSIONS' });
    }
    perms.assertPermission(req.channelPerms, P.MANAGE_MESSAGES, 'You need Manage Messages to remove other people\u2019s reactions.');
  }
  const reactions = messages.toggleReaction(req.message.id, targetId, emoji);
  res.json({ reactions });
});

router.delete('/:messageId/reactions', (req, res) => {
  if (!loadMessage(req, res)) return;
  if (!req.messageChannel.guild_id) {
    return res.status(403).json({ error: 'Not available in DMs.', code: 'MISSING_PERMISSIONS' });
  }
  perms.assertPermission(req.channelPerms, P.MANAGE_MESSAGES, 'You need Manage Messages to clear reactions.');
  db.run('DELETE FROM reactions WHERE message_id = ?', [req.message.id]);
  const row = db.get(`${serialize.MESSAGE_SELECT} AND m.id = ?`, [req.message.id]);
  const message = serialize.hydrateMessages([row], { currentUserId: req.user.id })[0];
  bus.toChannel(req.messageChannel.id, { type: 'MESSAGE_REACTIONS_CLEAR', data: { message_id: String(req.message.id), channel_id: String(req.messageChannel.id) } });
  res.json({ message });
});

/** Polls (free for everyone — no Nitro gate here). */
router.get('/:messageId/poll', (req, res) => {
  if (!loadMessage(req, res)) return;
  const poll = db.get('SELECT * FROM polls WHERE id = ?', [req.message.id]);
  if (!poll) return res.status(404).json({ error: 'That message has no poll.', code: 'NO_POLL' });
  res.json({ poll: serialize.serializePoll(poll, req.user.id) });
});

router.post('/:messageId/poll/vote', (req, res) => {
  if (!loadMessage(req, res)) return;
  const poll = db.get('SELECT * FROM polls WHERE id = ?', [req.message.id]);
  if (!poll) return res.status(404).json({ error: 'That message has no poll.', code: 'NO_POLL' });
  if (poll.ended || (poll.expires_at && poll.expires_at < now())) {
    return res.status(400).json({ error: 'That poll has ended.', code: 'POLL_ENDED' });
  }
  const answers = serialize.safeJson(poll.answers, []);
  const requested = Array.isArray((req.body || {}).answer_ids)
    ? (req.body || {}).answer_ids.map(Number)
    : [(req.body || {}).answer_id].map(Number).filter(Boolean);
  if (!requested.length) return res.status(400).json({ error: 'Pick at least one answer.', code: 'NO_ANSWER' });
  if (!poll.multi && requested.length > 1) {
    return res.status(400).json({ error: 'This poll only allows one answer.', code: 'SINGLE_ANSWER_ONLY' });
  }
  for (const answerId of requested) {
    if (!answers.some((a) => Number(a.id) === Number(answerId))) {
      return res.status(400).json({ error: 'Unknown answer.', code: 'UNKNOWN_ANSWER' });
    }
  }
  db.tx(() => {
    const existing = db.all('SELECT answer_id FROM poll_votes WHERE poll_id = ? AND user_id = ?', [poll.id, req.user.id]).map((r) => r.answer_id);
    if (existing.length && existing.every((id) => requested.includes(Number(id))) && existing.length === requested.length) {
      // Clicking your own vote again removes it.
      db.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', [poll.id, req.user.id]);
      return;
    }
    if (!poll.multi) db.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', [poll.id, req.user.id]);
    for (const answerId of requested) {
      db.run('INSERT OR IGNORE INTO poll_votes (poll_id, user_id, answer_id) VALUES (?, ?, ?)', [poll.id, req.user.id, answerId]);
    }
  });
  const fresh = db.get('SELECT * FROM polls WHERE id = ?', [poll.id]);
  const payload = serialize.serializePoll(fresh, req.user.id);
  bus.toChannel(req.messageChannel.id, { type: 'MESSAGE_POLL_VOTE_ADD', data: { message_id: String(poll.id), channel_id: String(req.messageChannel.id), poll: payload } });
  res.json({ poll: payload });
});

router.post('/:messageId/poll/end', (req, res) => {
  if (!loadMessage(req, res)) return;
  const poll = db.get('SELECT * FROM polls WHERE id = ?', [req.message.id]);
  if (!poll) return res.status(404).json({ error: 'That message has no poll.', code: 'NO_POLL' });
  const isAuthor = String(poll.creator_id) === String(req.user.id);
  const canEnd = isAuthor || (req.messageChannel.guild_id && (req.channelPerms & P.MANAGE_MESSAGES) === P.MANAGE_MESSAGES);
  if (!canEnd) return res.status(403).json({ error: 'Only the poll author or a moderator can end it.', code: 'CANNOT_END_POLL' });
  db.run('UPDATE polls SET ended = 1 WHERE id = ?', [poll.id]);
  const fresh = db.get('SELECT * FROM polls WHERE id = ?', [poll.id]);
  const payload = serialize.serializePoll(fresh, req.user.id);
  bus.toChannel(req.messageChannel.id, { type: 'MESSAGE_POLL_VOTE_ADD', data: { message_id: String(poll.id), channel_id: String(req.messageChannel.id), poll: payload } });
  res.json({ poll: payload });
});

module.exports = router;
