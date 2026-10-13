'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { P } = require('../permissions');
const perms = require('../perms');

const router = express.Router();
router.use(auth.requireUser);

/** ICE servers for the browser's RTCPeerConnection. */
router.get('/ice', (req, res) => {
  res.json({
    ice_servers: [{ urls: config.stunServers }],
    mode: 'mesh-p2p',
    bitrate: config.voiceBitrate,
    enabled: config.voiceEnabled,
    note: 'Bla relays SDP/ICE between members over the gateway. Add a TURN server via BLA_STUN_URLS to cover strict NATs.',
  });
});

/** Who is currently in voice, across every server and DM this user can see. */
router.get('/states', (req, res) => {
  const rows = db.all(
    `SELECT v.* FROM voice_states v
     WHERE v.guild_id IN (SELECT guild_id FROM guild_members WHERE user_id = ?)
        OR v.channel_id IN (SELECT channel_id FROM dm_recipients WHERE user_id = ?)`,
    [req.user.id, req.user.id]);
  res.json({
    voice_states: rows.map((v) => ({
      user_id: String(v.user_id),
      guild_id: v.guild_id ? String(v.guild_id) : null,
      channel_id: String(v.channel_id),
      session_id: v.session_id,
      self_mute: !!v.self_mute,
      self_deaf: !!v.self_deaf,
      self_video: !!v.self_video,
      self_stream: !!v.self_stream,
      server_mute: !!v.server_mute,
      server_deaf: !!v.server_deaf,
      joined_at: v.joined_at,
    })),
  });
});

/** Fetch one channel's occupancy (used by the voice panel before connecting). */
router.get('/channels/:channelId', (req, res) => {
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [Number(req.params.channelId)]);
  if (!channel) return res.status(404).json({ error: 'Unknown channel.', code: 'UNKNOWN_CHANNEL' });
  if (channel.guild_id) {
    const member = perms.getMember(channel.guild_id, req.user.id);
    if (!member && !req.user.is_admin) return res.status(403).json({ error: 'Not a member.', code: 'NOT_A_MEMBER' });
    const guildPerms = perms.guildPermissions(channel.guild_id, req.user.id, { isAdmin: req.user.is_admin });
    const channelPerms = perms.channelPermissions(channel, req.user.id, member, guildPerms);
    if (!(channelPerms & P.VIEW_CHANNEL)) {
      return res.status(403).json({ error: 'You cannot see that channel.', code: 'NO_CHANNEL_ACCESS' });
    }
  } else {
    const recipient = db.get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [channel.id, req.user.id]);
    if (!recipient) return res.status(403).json({ error: 'Not your conversation.', code: 'NOT_A_RECIPIENT' });
  }
  const occupants = db.all(
    `SELECT v.user_id, v.session_id, v.self_mute, v.self_deaf, v.self_video, v.self_stream, v.joined_at,
            u.username, u.display_name, u.avatar
     FROM voice_states v JOIN users u ON u.id = v.user_id WHERE v.channel_id = ? ORDER BY v.joined_at`, [channel.id]);
  res.json({
    channel_id: String(channel.id),
    user_limit: channel.user_limit,
    bitrate: channel.bitrate || config.voiceBitrate,
    members: occupants.map((o) => ({
      user_id: String(o.user_id),
      session_id: o.session_id,
      self_mute: !!o.self_mute,
      self_deaf: !!o.self_deaf,
      self_video: !!o.self_video,
      self_stream: !!o.self_stream,
      joined_at: o.joined_at,
      display_name: o.display_name || o.username,
      avatar: o.avatar,
    })),
  });
});

/** Server-side mute/deafen/move (moderators). */
router.patch('/users/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const guildId = Number((req.body || {}).guild_id);
  const guild = db.get('SELECT * FROM guilds WHERE id = ?', [guildId]);
  if (!guild) return res.status(404).json({ error: 'Unknown server.', code: 'UNKNOWN_GUILD' });
  const actor = perms.getMember(guildId, req.user.id);
  if (!actor && !req.user.is_admin) return res.status(403).json({ error: 'Not a member.', code: 'NOT_A_MEMBER' });
  const actorPerms = perms.guildPermissions(guildId, req.user.id, {
    isOwner: String(guild.owner_id) === String(req.user.id), isAdmin: req.user.is_admin,
  });
  const body = req.body || {};
  const updates = {};
  if (body.server_mute !== undefined) {
    perms.assertPermission(actorPerms, P.MUTE_MEMBERS, 'You need Mute Members to do that.');
    updates.server_mute = body.server_mute ? 1 : 0;
    db.run('UPDATE guild_members SET muted = ? WHERE guild_id = ? AND user_id = ?', [updates.server_mute, guildId, userId]);
  }
  if (body.server_deaf !== undefined) {
    perms.assertPermission(actorPerms, P.DEAFEN_MEMBERS, 'You need Deafen Members to do that.');
    updates.server_deaf = body.server_deaf ? 1 : 0;
    db.run('UPDATE guild_members SET deafened = ? WHERE guild_id = ? AND user_id = ?', [updates.server_deaf, guildId, userId]);
  }
  if (body.channel_id !== undefined) {
    perms.assertPermission(actorPerms, P.MOVE_MEMBERS, 'You need Move Members to do that.');
    const channel = db.get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', [Number(body.channel_id), guildId]);
    if (!channel || channel.type !== 2) return res.status(400).json({ error: 'Pick a voice channel in this server.', code: 'UNKNOWN_CHANNEL' });
    updates.channel_id = channel.id;
  }
  const state = db.get('SELECT * FROM voice_states WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
  if (!state) return res.status(404).json({ error: 'That person is not in voice.', code: 'NOT_IN_VOICE' });
  if (Object.keys(updates).length) {
    const keys = Object.keys(updates);
    db.run(`UPDATE voice_states SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`,
      [...keys.map((k) => updates[k]), userId]);
  }
  const fresh = db.get('SELECT * FROM voice_states WHERE user_id = ?', [userId]);
  require('../bus').toGuild(guildId, {
    type: 'VOICE_STATE_UPDATE',
    data: {
      user_id: String(fresh.user_id),
      guild_id: String(guildId),
      channel_id: String(fresh.channel_id),
      session_id: fresh.session_id,
      self_mute: !!fresh.self_mute,
      self_deaf: !!fresh.self_deaf,
      self_video: !!fresh.self_video,
      self_stream: !!fresh.self_stream,
      server_mute: !!fresh.server_mute,
      server_deaf: !!fresh.server_deaf,
      joined_at: fresh.joined_at,
    },
  });
  res.json({ ok: true });
});

module.exports = router;
