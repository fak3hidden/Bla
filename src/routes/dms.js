'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const serialize = require('../serialize');
const sync = require('../syncHelpers');
const bus = require('../bus');
const config = require('../config');
const { now, randomId } = require('../util');
const { channelContext } = require('../context');

const router = express.Router();
router.use(auth.requireUser);

/** All DM + group DM channels this user is part of. */
router.get('/', (req, res) => {
  res.json({ channels: sync.dmChannelsForUser(req.user.id) });
});

/** Open (or reuse) a DM or group DM. */
router.post('/', (req, res) => {
  const body = req.body || {};
  const ids = (Array.isArray(body.recipients) ? body.recipients : [body.recipient_id])
    .map(Number).filter((id) => Number.isFinite(id) && id > 0 && id !== req.user.id);
  const unique = [...new Set(ids)];
  if (!unique.length) return res.status(400).json({ error: 'Pick at least one person to message.', code: 'NO_RECIPIENTS' });
  if (unique.length > 9) return res.status(400).json({ error: 'Group DMs support up to 10 people, including you.', code: 'TOO_MANY_RECIPIENTS' });

  for (const id of unique) {
    const user = db.get('SELECT id, disabled FROM users WHERE id = ?', [id]);
    if (!user) return res.status(404).json({ error: 'One of those people does not exist.', code: 'UNKNOWN_USER' });
    const blocked = db.get('SELECT 1 FROM relationships WHERE user_id = ? AND target_id = ? AND type = 4', [id, req.user.id]);
    if (blocked && unique.length === 1) {
      return res.status(403).json({ error: 'You cannot message that person.', code: 'BLOCKED' });
    }
  }

  const isGroup = unique.length > 1;
  if (!isGroup) {
    // Reuse an existing 1:1 conversation if there is one.
    const existing = db.get(
      `SELECT c.id FROM channels c
       JOIN dm_recipients r1 ON r1.channel_id = c.id AND r1.user_id = ?
       JOIN dm_recipients r2 ON r2.channel_id = c.id AND r2.user_id = ?
       WHERE c.type = 1 AND (SELECT COUNT(*) FROM dm_recipients WHERE channel_id = c.id) = 2
       LIMIT 1`, [req.user.id, unique[0]]);
    if (existing) {
      const channel = db.get('SELECT * FROM channels WHERE id = ?', [existing.id]);
      return res.json({ channel: dmPayload(channel, req.user.id), existed: true });
    }
  }

  const ts = now();
  const channelId = db.tx(() => {
    const id = db.insert('channels', {
      guild_id: null,
      type: isGroup ? 3 : 1,
      name: isGroup ? (body.name ? String(body.name).slice(0, 100) : null) : null,
      owner_id: isGroup ? req.user.id : null,
      created_at: ts,
      bitrate: config.voiceBitrate,
    });
    db.insert('dm_recipients', { channel_id: id, user_id: req.user.id });
    for (const userId of unique) db.insert('dm_recipients', { channel_id: id, user_id: userId });
    return id;
  });

  const channel = db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
  const payload = dmPayload(channel, req.user.id);
  const others = unique;
  bus.toUsers(others, { type: 'CHANNEL_CREATE', data: dmPayload(channel, others[0]) });
  for (const userId of others) bus.toUser(userId, { type: 'DM_CHANNEL_CREATE', data: { channel_id: String(channelId) } });
  res.status(201).json({ channel: payload });
});

function dmPayload(channel, viewerId) {
  const recipients = db.all(
    `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.accent_color, u.is_bot
     FROM dm_recipients r JOIN users u ON u.id = r.user_id
     WHERE r.channel_id = ? AND r.user_id != ?`, [channel.id, viewerId]);
  return serialize.serializeChannel(channel, {
    recipients: recipients.map((r) => serialize.userBrief(r)),
    is_group_dm: db.get('SELECT COUNT(*) AS c FROM dm_recipients WHERE channel_id = ?', [channel.id]).c > 2,
  });
}

/** Start (or rejoin) a DM voice/video call. Creates a hidden voice channel. */
router.post('/:channelId/call', channelContext(), (req, res) => {
  if (!config.voiceEnabled) return res.status(403).json({ error: 'Voice is disabled on this instance.', code: 'VOICE_DISABLED' });
  const channel = req.channel;
  if (channel.guild_id) return res.status(400).json({ error: 'Use the server voice channel instead.', code: 'WRONG_CHANNEL_TYPE' });
  if (channel.type === 2) return res.json({ channel: dmPayload(channel, req.user.id), existed: true });

  const existing = db.get(
    `SELECT c.* FROM channels c JOIN dm_recipients r ON r.channel_id = c.id
     WHERE c.type = 2 AND r.user_id = ?
       AND (SELECT GROUP_CONCAT(user_id) FROM dm_recipients WHERE channel_id = c.id ORDER BY user_id)
         = (SELECT GROUP_CONCAT(user_id) FROM dm_recipients WHERE channel_id = ? ORDER BY user_id)
     LIMIT 1`, [req.user.id, channel.id]);
  if (existing) return res.json({ channel: dmPayload(existing, req.user.id), existed: true });

  const recipients = db.all('SELECT user_id FROM dm_recipients WHERE channel_id = ?', [channel.id]).map((r) => r.user_id);
  const voiceId = db.tx(() => {
    const id = db.insert('channels', {
      guild_id: null, type: 2, name: channel.name || null, owner_id: req.user.id,
      created_at: now(), bitrate: config.voiceBitrate, parent_id: channel.id,
    });
    for (const userId of recipients) db.insert('dm_recipients', { channel_id: id, user_id: userId });
    return id;
  });
  const voiceChannel = db.get('SELECT * FROM channels WHERE id = ?', [voiceId]);
  const payload = dmPayload(voiceChannel, req.user.id);
  for (const userId of recipients) {
    if (String(userId) === String(req.user.id)) continue;
    bus.toUser(userId, { type: 'CALL_RING', data: { channel_id: String(voiceId), parent_channel_id: String(channel.id), caller: serialize.userBrief(req.user) } });
  }
  res.status(201).json({ channel: payload });
});

/** Group DM membership management. */
router.put('/:channelId/recipients/:userId', channelContext(), (req, res) => {
  if (req.channel.type !== 3) return res.status(400).json({ error: 'Only group DMs have members to add.', code: 'NOT_GROUP_DM' });
  const count = db.get('SELECT COUNT(*) AS c FROM dm_recipients WHERE channel_id = ?', [req.channel.id]).c;
  if (count >= 10) return res.status(400).json({ error: 'Group DMs are capped at 10 people.', code: 'GROUP_FULL' });
  const userId = Number(req.params.userId);
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'Unknown user.', code: 'UNKNOWN_USER' });
  db.run('INSERT OR IGNORE INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', [req.channel.id, userId]);
  db.insert('messages', {
    channel_id: req.channel.id, guild_id: null, author_id: null, content: '',
    type: 1, system: 1, created_at: now(), mentions: '[]', mention_roles: '[]', embeds: '[]',
    interaction: JSON.stringify({ system: 'RECIPIENT_ADD', user: serialize.userBrief(req.user), target: serialize.userBrief(user) }),
  });
  bus.toUser(userId, { type: 'CHANNEL_CREATE', data: dmPayload(req.channel, userId) });
  bus.toChannel(req.channel.id, { type: 'CHANNEL_RECIPIENT_ADD', data: { channel_id: String(req.channel.id), user: serialize.userBrief(user) } });
  res.json({ channel: dmPayload(req.channel, req.user.id) });
});

router.delete('/:channelId/recipients/:userId', channelContext(), (req, res) => {
  const userId = Number(req.params.userId);
  if (req.channel.type === 1) {
    // Leaving a 1:1 DM just hides it for you.
    db.run('DELETE FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [req.channel.id, req.user.id]);
    bus.toUser(req.user.id, { type: 'CHANNEL_DELETE', data: { id: String(req.channel.id) } });
    return res.json({ ok: true });
  }
  if (userId !== req.user.id && String(req.channel.owner_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'Only the group owner can remove other people.', code: 'NOT_GROUP_OWNER' });
  }
  db.run('DELETE FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [req.channel.id, userId]);
  bus.toUser(userId, { type: 'CHANNEL_DELETE', data: { id: String(req.channel.id) } });
  bus.toChannel(req.channel.id, { type: 'CHANNEL_RECIPIENT_REMOVE', data: { channel_id: String(req.channel.id), user_id: String(userId) } });
  res.json({ ok: true });
});

/** Close (hide) a DM for yourself. */
router.delete('/:channelId', channelContext(), (req, res) => {
  db.run('DELETE FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [req.channel.id, req.user.id]);
  if (!db.get('SELECT COUNT(*) AS c FROM dm_recipients WHERE channel_id = ?', [req.channel.id]).c || req.channel.type === 2) {
    // Nobody left (or it was only ever a temporary call channel) — tidy up.
    if (req.channel.type === 2 && req.channel.parent_id) {
      // keep the underlying conversation
    } else if (!db.get('SELECT COUNT(*) AS c FROM dm_recipients WHERE channel_id = ?', [req.channel.id]).c) {
      db.run('DELETE FROM channels WHERE id = ?', [req.channel.id]);
    }
  }
  bus.toUser(req.user.id, { type: 'CHANNEL_DELETE', data: { id: String(req.channel.id) } });
  res.json({ ok: true });
});

module.exports = router;
module.exports.dmPayload = dmPayload;
