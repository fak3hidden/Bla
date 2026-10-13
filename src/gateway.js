'use strict';
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const perms = require('./perms');
const bus = require('./bus');
const serialize = require('./serialize');
const state = require('./guildState');
const sync = require('./syncHelpers');
const guilds = require('./guilds');
const { P } = require('./permissions');
const { now, randomId } = require('./util');

const OP = {
  HELLO: 'HELLO',
  IDENTIFY: 'IDENTIFY',
  READY: 'READY',
  HEARTBEAT_ACK: 'HEARTBEAT_ACK',
  PING: 'PING',
  PONG: 'PONG',
  SUBSCRIBE: 'SUBSCRIBE',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  TYPING: 'TYPING',
  PRESENCE_UPDATE: 'PRESENCE_UPDATE',
  VOICE_JOIN: 'VOICE_JOIN',
  VOICE_LEAVE: 'VOICE_LEAVE',
  VOICE_STATE: 'VOICE_STATE',
  VOICE_SIGNAL: 'VOICE_SIGNAL',
  VOICE_SPEAKING: 'VOICE_SPEAKING',
  REQUEST_MEMBERS: 'REQUEST_MEMBERS',
  REQUEST_GUILD_SYNC: 'REQUEST_GUILD_SYNC',
  ERROR: 'ERROR',
};

/** In-memory presence: uid -> { status, custom_status, connections:Set } */
const presence = new Map();
/** channelId -> { ids:Set<string>, expires:number } */
const audienceCache = new Map();

class Session {
  constructor(socket) {
    this.socket = socket;
    this.id = randomId(10);
    this.userId = null;
    this.user = null;
    this.guildIds = new Set();
    this.channelIds = new Set();
    this.alive = true;
    this.lastTyping = new Map();
    this.lastSpeaking = null;
  }

  get userIdString() {
    return this.userId === null ? null : String(this.userId);
  }

  send(payload) {
    if (this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch { /* socket died mid-send */ }
  }
}

class Gateway {
  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/gateway', maxPayload: 512 * 1024 });
    this.sessions = new Set();
    this.byUser = new Map();
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
    this.heartbeat = setInterval(() => this.checkAlive(), 30000);
    this.heartbeat.unref?.();
  }

  onConnection(socket, req) {
    const session = new Session(socket);
    socket.isAlive = true;
    session.send({ op: OP.HELLO, data: { heartbeat_interval: 45000, session_id: session.id, version: 1 } });

    // Identify from ?token=, the session cookie, or an Authorization header so
    // browsers and scripts can both connect without a second round trip.
    const url = new URL(req.url, 'http://localhost');
    const cookies = auth.parseCookies(req.headers.cookie || '');
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = url.searchParams.get('token') || cookies[auth.COOKIE_NAME] || bearer || null;
    if (token) {
      try { this.tryIdentify(session, token); } catch { /* IDENTIFY frame can retry */ }
    }
    session.handshakeToken = token;

    socket.on('message', (raw) => {
      socket.isAlive = true;
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return session.send({ op: OP.ERROR, data: { code: 'BAD_PAYLOAD', message: 'Frames must be JSON.' } });
      }
      try {
        this.handle(session, payload);
      } catch (err) {
        session.send({
          op: OP.ERROR,
          data: { code: err.code || 'ERROR', message: err.message || 'Something went wrong.' },
          nonce: payload?.nonce ?? null,
        });
      }
    });

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('close', () => this.onClose(session));
    socket.on('error', () => {});
    this.sessions.add(session);
  }

  tryIdentify(session, token) {
    const row = auth.userFromToken(token);
    if (!row) throw Object.assign(new Error('Invalid session.'), { code: 'INVALID_SESSION' });
    session.userId = row.id;
    session.user = row;
    if (!this.byUser.has(String(row.id))) this.byUser.set(String(row.id), new Set());
    this.byUser.get(String(row.id)).add(session);

    for (const guild of guilds.guildsForUser(row.id)) session.guildIds.add(String(guild.id));

    db.run('UPDATE users SET last_seen = ? WHERE id = ?', [now(), row.id]);
    session.send({
      op: OP.READY,
      data: {
        session_id: session.id,
        user: auth.publicUser(row),
        guild_ids: [...session.guildIds],
        dm_channels: sync.dmChannelsForUser(row.id),
        read_states: db.all('SELECT guild_id FROM guild_members WHERE user_id = ?', [row.id])
          .map((g) => sync.guildReadStates(row.id, g.guild_id)),
        relationships: relationshipPayload(row.id),
        presences: this.visiblePresences(row.id),
        voice_states: this.voiceStatesForUser(row.id),
        settings: serialize.safeJson(row.settings, {}),
      },
    });
    this.setPresence(row.id, { status: this.currentStatus(row.id) }, { skipSelf: true });
    return true;
  }

  handle(session, payload) {
    const op = payload.op || payload.type;
    const data = payload.data || {};

    if (op === OP.IDENTIFY) {
      if (session.userId) return;
      this.tryIdentify(session, data.token || payload.token || session.handshakeToken);
      return;
    }
    if (op === OP.PING) {
      return session.send({ op: OP.PONG, nonce: payload.nonce ?? null, data: { time: Date.now() } });
    }

    if (!session.userId) {
      throw Object.assign(new Error('Send IDENTIFY first.'), { code: 'NOT_IDENTIFIED' });
    }

    switch (op) {
      case OP.SUBSCRIBE: return this.subscribe(session, data);
      case OP.UNSUBSCRIBE: return this.unsubscribe(session, data);
      case OP.TYPING: return this.typing(session, data);
      case OP.PRESENCE_UPDATE: return this.handlePresence(session, data);
      case OP.REQUEST_MEMBERS: return this.requestMembers(session, data);
      case OP.REQUEST_GUILD_SYNC: return this.requestGuildSync(session, data);
      case OP.VOICE_JOIN: return this.voiceJoin(session, data);
      case OP.VOICE_LEAVE: return this.voiceLeave(session, data);
      case OP.VOICE_STATE: return this.voiceStateUpdate(session, data);
      case OP.VOICE_SIGNAL: return this.voiceSignal(session, data);
      case OP.VOICE_SPEAKING: return this.voiceSpeaking(session, data);
      case 'READ_STATE': return this.updateReadState(session, data);
      default:
        throw Object.assign(new Error(`Unknown op "${op}".`), { code: 'UNKNOWN_OP' });
    }
  }

  /* ----------------------------- subscriptions ----------------------------- */

  subscribe(session, data) {
    const ids = Array.isArray(data.channel_ids) ? data.channel_ids : [data.channel_id].filter(Boolean);
    for (const id of ids) session.channelIds.add(String(id));
    for (const guildId of (data.guild_ids || [])) session.guildIds.add(String(guildId));
    session.send({ op: 'SUBSCRIBED', data: { channel_ids: [...session.channelIds] } });
  }

  unsubscribe(session, data) {
    const ids = Array.isArray(data.channel_ids) ? data.channel_ids : Array.isArray(data) ? data : [];
    for (const id of ids) session.channelIds.delete(String(id));
    session.send({ op: 'UNSUBSCRIBED', data: { channel_ids: [...session.channelIds] } });
  }

  requestMembers(session, data) {
    const guildId = String(data.guild_id || '');
    if (!session.guildIds.has(guildId)) {
      throw Object.assign(new Error('You are not in that server.'), { code: 'NOT_A_MEMBER' });
    }
    session.send({
      op: 'GUILD_MEMBERS',
      data: { guild_id: guildId, members: state.membersPayload(Number(guildId), { limit: 1000 }), presences: this.presencesForGuild(Number(guildId)) },
    });
  }

  requestGuildSync(session, data) {
    const guildId = String(data.guild_id || '');
    if (!session.guildIds.has(guildId)) {
      throw Object.assign(new Error('You are not in that server.'), { code: 'NOT_A_MEMBER' });
    }
    const guild = db.get('SELECT * FROM guilds WHERE id = ?', [Number(guildId)]);
    if (!guild) throw Object.assign(new Error('Unknown server.'), { code: 'UNKNOWN_GUILD' });
    session.send({
      op: 'GUILD_SYNC',
      data: { guild: state.guildPayload(guild, session.userId, { isAdmin: session.user.is_admin }), read_states: sync.guildReadStates(session.userId, guild.id) },
    });
  }

  /* -------------------------------- presence -------------------------------- */

  currentStatus(userId) {
    const entry = presence.get(String(userId));
    if (!entry || !entry.connections || entry.connections.size === 0) return 'offline';
    return entry.status || 'online';
  }

  defaultStatus(userId) {
    const entry = presence.get(String(userId));
    const stored = entry?.status;
    if (stored && stored !== 'offline') return stored;
    const row = db.get('SELECT settings FROM users WHERE id = ?', [userId]);
    const settings = serialize.safeJson(row?.settings, {});
    return ['online', 'idle', 'dnd', 'invisible'].includes(settings.status) ? settings.status : 'online';
  }

  setPresence(userId, { status, custom_status = undefined }, { skipSelf = false } = {}) {
    const key = String(userId);
    let entry = presence.get(key);
    if (!entry) {
      entry = { status: 'offline', custom_status: null, connections: 0 };
      presence.set(key, entry);
    }
    if (status) entry.status = status;
    if (custom_status !== undefined) entry.custom_status = custom_status;
    entry.updated_at = now();

    const payload = {
      type: 'PRESENCE_UPDATE',
      data: this.presencePayload(userId),
    };
    const audience = this.presenceAudience(userId);
    if (skipSelf) audience.delete(key);
    bus.toUsers([...audience], payload);
    bus.toUser(userId, payload);
    return entry;
  }

  presencePayload(userId) {
    const key = String(userId);
    const entry = presence.get(key);
    const status = this.currentStatus(userId);
    return {
      user_id: key,
      status,
      custom_status: entry?.custom_status || null,
      updated_at: entry?.updated_at || null,
      activities: entry?.custom_status ? [{ type: 4, name: entry.custom_status }] : [],
    };
  }

  /** People who should see this user's presence: friends + guild co-members. */
  presenceAudience(userId) {
    const rows = db.all(
      `SELECT DISTINCT other.user_id AS uid FROM (
         SELECT m1.user_id AS user_id FROM guild_members m1
         WHERE m1.guild_id IN (SELECT guild_id FROM guild_members WHERE user_id = ?)
       ) other WHERE other.user_id != ?
       UNION
       SELECT target_id AS uid FROM relationships WHERE user_id = ? AND type IN (1, 4)
       UNION
       SELECT user_id AS uid FROM relationships WHERE target_id = ? AND type = 1`,
      [userId, userId, userId, userId]);
    return new Set(rows.map((r) => String(r.uid)));
  }

  presencesForGuild(guildId) {
    const ids = db.all('SELECT user_id FROM guild_members WHERE guild_id = ?', [guildId]);
    return ids.map((r) => this.presencePayload(r.user_id));
  }

  visiblePresences(userId) {
    const audience = this.presenceAudience(userId);
    audience.add(String(userId));
    return [...audience].map((id) => this.presencePayload(id));
  }

  handlePresence(session, data) {
    const allowed = ['online', 'idle', 'dnd', 'invisible'];
    const status = allowed.includes(data.status) ? data.status : undefined;
    let custom = undefined;
    if (data.custom_status !== undefined) {
      if (data.custom_status === null || data.custom_status === '') custom = null;
      else custom = {
        text: String(data.custom_status.text ?? data.custom_status).slice(0, 128),
        emoji: data.custom_status.emoji ? String(data.custom_status.emoji).slice(0, 64) : null,
        expires_at: data.custom_status.expires_at || null,
      };
    }
    if (status) {
      const row = db.get('SELECT settings FROM users WHERE id = ?', [session.userId]);
      const settings = serialize.safeJson(row?.settings, {});
      settings.status = status;
      db.run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settings), session.userId]);
    }
    const key = session.userIdString;
    const entry = presence.get(key) || { connections: 0 };
    entry.connections = session.byUserCount;
    presence.set(key, entry);
    this.setPresence(session.userId, { status: status || this.defaultStatus(session.userId), custom_status: custom });
  }

  /* --------------------------------- typing --------------------------------- */

  typing(session, data) {
    const channelId = String(data.channel_id || '');
    if (!channelId) return;
    const last = session.lastTyping.get(channelId) || 0;
    if (now() - last < 4000) return;
    session.lastTyping.set(channelId, now());

    const channel = db.get('SELECT * FROM channels WHERE id = ?', [Number(channelId)]);
    if (!channel) return;
    const member = channel.guild_id ? perms.getMember(channel.guild_id, session.userId) : null;
    const guildPerms = channel.guild_id ? perms.guildPermissions(channel.guild_id, session.userId, { isOwner: false, isAdmin: session.user.is_admin }) : 0n;
    if (channel.guild_id && !perms.canViewChannel(channel, session.userId, member, guildPerms)) return;

    const payload = {
      type: 'TYPING_START',
      data: {
        channel_id: channelId,
        guild_id: channel.guild_id ? String(channel.guild_id) : null,
        user_id: session.userIdString,
        member: { nickname: member?.nickname || null },
        user: serialize.userBrief(session.user),
        timestamp: now(),
      },
    };
    this.dispatchChannel(channelId, payload, { exceptUserId: session.userIdString });
  }

  /* ------------------------------- read state ------------------------------- */

  updateReadState(session, data) {
    const channelId = Number(data.channel_id);
    if (!channelId) return;
    const channel = db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
    if (!channel) return;
    const lastMessageId = Number(data.last_message_id || channel.last_message_id || 0);
    db.run(
      `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count, last_pin_seen)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0`,
      [session.userId, channelId, lastMessageId, data.last_pin_seen || 0]);
    if (channel.guild_id && data.ack_guild) {
      db.run(
        `INSERT INTO guild_read_states (user_id, guild_id, last_viewed) VALUES (?, ?, ?)
         ON CONFLICT(user_id, guild_id) DO UPDATE SET last_viewed = excluded.last_viewed`,
        [session.userId, channel.guild_id, now()]);
    }
    this.dispatchUser(session.userIdString, {
      type: 'READ_STATE_UPDATE',
      data: { channel_id: String(channelId), last_message_id: String(lastMessageId), mention_count: 0 },
    });
  }

  /* ---------------------------------- voice --------------------------------- */

  voiceStateFor(userId) {
    return db.get('SELECT * FROM voice_states WHERE user_id = ?', [userId]);
  }

  voiceChannelAudience(channelId) {
    const key = `voice:${channelId}`;
    const cached = audienceCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.ids;
    const ids = this.computeChannelAudience(channelId);
    audienceCache.set(key, { ids, expires: Date.now() + 5000 });
    return ids;
  }

  voiceJoin(session, data) {
    if (!config.voiceEnabled) throw Object.assign(new Error('Voice is disabled on this instance.'), { code: 'VOICE_DISABLED' });
    const channelId = Number(data.channel_id);
    const channel = db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
    if (!channel) throw Object.assign(new Error('Unknown voice channel.'), { code: 'UNKNOWN_CHANNEL' });
    if (![2, 13].includes(channel.type) && !(channel.type === 2)) {
      throw Object.assign(new Error('That is not a voice channel.'), { code: 'NOT_VOICE_CHANNEL' });
    }

    const isDm = !channel.guild_id;
    if (isDm) {
      const recipient = db.get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [channel.id, session.userId]);
      if (!recipient) throw Object.assign(new Error('You are not part of this call.'), { code: 'NOT_A_RECIPIENT' });
    } else {
      const member = perms.getMember(channel.guild_id, session.userId);
      if (!member) throw Object.assign(new Error('You are not a member of that server.'), { code: 'NOT_A_MEMBER' });
      const guildPerms = perms.guildPermissions(channel.guild_id, session.userId, { isAdmin: session.user.is_admin });
      const channelPerms = perms.channelPermissions(channel, session.userId, member, guildPerms);
      if (!(channelPerms & P.VIEW_CHANNEL)) throw Object.assign(new Error('You cannot see that channel.'), { code: 'NO_CHANNEL_ACCESS' });
      if (!(channelPerms & P.CONNECT)) throw Object.assign(new Error('You do not have permission to join that voice channel.'), { code: 'CANNOT_CONNECT' });
      if (member.timeout_until && member.timeout_until > now()) {
        throw Object.assign(new Error('You are timed out and cannot join voice right now.'), { code: 'TIMED_OUT' });
      }
      if (member.deafened) throw Object.assign(new Error('You are server-deafened.'), { code: 'SERVER_DEAFENED' });
      if (channel.user_limit > 0) {
        const occupants = db.get('SELECT COUNT(*) AS c FROM voice_states WHERE channel_id = ? AND user_id != ?', [channel.id, session.userId]).c;
        const myPerm = member ? perms.channelPermissions(channel, session.userId, member, guildPerms) : 0n;
        const canBypass = (myPerm & P.MOVE_MEMBERS) === P.MOVE_MEMBERS;
        if (occupants >= channel.user_limit && !canBypass) {
          throw Object.assign(new Error('That voice channel is full.'), { code: 'CHANNEL_FULL' });
        }
      }
    }

    const existing = this.voiceStateFor(session.userId);
    if (existing && Number(existing.channel_id) === Number(channelId)) {
      return this.sendVoiceSetup(session, channel, existing.session_id);
    }
    if (existing) {
      // Moving between channels: tell the old channel good-bye.
      db.run('DELETE FROM voice_states WHERE user_id = ?', [session.userId]);
      this.dispatchVoiceState(existing, null);
    }

    const sessionId = session.id + ':' + randomId(6);
    db.run('DELETE FROM voice_states WHERE user_id = ?', [session.userId]);
    db.insert('voice_states', {
      user_id: session.userId,
      guild_id: channel.guild_id || null,
      channel_id: channel.id,
      session_id: sessionId,
      self_mute: data.self_mute ? 1 : 0,
      self_deaf: data.self_deaf ? 1 : 0,
      self_video: data.self_video ? 1 : 0,
      self_stream: data.self_stream ? 1 : 0,
      suppress: channel.type === 13 ? 0 : 0,
      joined_at: now(),
    });

    const row = db.get('SELECT * FROM voice_states WHERE user_id = ?', [session.userId]);
    this.dispatchVoiceState(row, null);
    bus.toUser(session.userIdString, { type: 'VOICE_STATE_UPDATE', data: voiceStatePayload(row) });
    return this.sendVoiceSetup(session, channel, sessionId);
  }

  sendVoiceSetup(session, channel, sessionId) {
    const channelId = String(channel.id);
    const peers = db.all('SELECT user_id, session_id FROM voice_states WHERE channel_id = ? AND user_id != ?',
      [channel.id, session.userId]);
    session.send({
      op: 'VOICE_READY',
      data: {
        channel_id: channelId,
        guild_id: channel.guild_id ? String(channel.guild_id) : null,
        session_id: sessionId,
        ice_servers: [{ urls: config.stunServers }],
        peers: peers.map((p) => ({ user_id: String(p.user_id), session_id: p.session_id })),
        bitrate: channel.bitrate || config.voiceBitrate,
        mode: 'mesh-p2p',
        note: 'Peers connect directly to each other with WebRTC. Add a TURN server in BLA_STUN_URLS if your members are behind strict NATs.',
      },
    });
  }

  voiceLeave(session, data) {
    const existing = this.voiceStateFor(session.userId);
    if (!existing) return;
    db.run('DELETE FROM voice_states WHERE user_id = ?', [session.userId]);
    this.dispatchVoiceState(existing, null);
    bus.toUser(session.userIdString, { type: 'VOICE_LEAVE', data: { channel_id: String(existing.channel_id), guild_id: existing.guild_id ? String(existing.guild_id) : null } });
  }

  voiceStateUpdate(session, data) {
    const existing = this.voiceStateFor(session.userId);
    if (!existing) throw Object.assign(new Error('You are not in a voice channel.'), { code: 'NOT_IN_VOICE' });
    const updates = {};
    if (data.self_mute !== undefined) updates.self_mute = data.self_mute ? 1 : 0;
    if (data.self_deaf !== undefined) updates.self_deaf = data.self_deaf ? 1 : 0;
    if (data.self_video !== undefined) updates.self_video = data.self_video ? 1 : 0;
    if (data.self_stream !== undefined) updates.self_stream = data.self_stream ? 1 : 0;
    if (Object.keys(updates).length) {
      const keys = Object.keys(updates);
      db.run(`UPDATE voice_states SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`,
        [...keys.map((k) => updates[k]), session.userId]);
    }
    // Self-deafening implies self-muting (Discord behaviour).
    if (updates.self_deaf === 1) db.run('UPDATE voice_states SET self_mute = 1 WHERE user_id = ?', [session.userId]);
    const row = this.voiceStateFor(session.userId);
    this.dispatchVoiceState(row, null);
    return true;
  }

  /** Relay SDP/ICE between members of the same voice channel. */
  voiceSignal(session, data) {
    const existing = this.voiceStateFor(session.userId);
    if (!existing) throw Object.assign(new Error('You are not in a voice channel.'), { code: 'NOT_IN_VOICE' });
    const channelId = Number(data.channel_id || existing.channel_id);
    if (Number(channelId) !== Number(existing.channel_id)) {
      throw Object.assign(new Error('You are not in that voice channel.'), { code: 'WRONG_VOICE_CHANNEL' });
    }
    const targetUserId = data.user_id ? String(data.user_id) : null;
    const targetSessionId = data.session_id ? String(data.session_id) : null;
    if (!targetUserId && !targetSessionId) {
      throw Object.assign(new Error('VOICE_SIGNAL needs a target user or session.'), { code: 'NO_TARGET' });
    }
    const peer = targetUserId
      ? db.get('SELECT * FROM voice_states WHERE user_id = ? AND channel_id = ?', [Number(targetUserId), channelId])
      : db.get('SELECT * FROM voice_states WHERE session_id = ? AND channel_id = ?', [targetSessionId, channelId]);
    if (!peer) throw Object.assign(new Error('That person is no longer in the voice channel.'), { code: 'PEER_LEFT' });

    bus.toUser(String(peer.user_id), {
      type: 'VOICE_SIGNAL',
      data: {
        channel_id: String(channelId),
        guild_id: peer.guild_id ? String(peer.guild_id) : null,
        from_user_id: session.userIdString,
        from_session_id: existing.session_id,
        to_session_id: peer.session_id,
        signal: data.signal || data.data || null,
      },
    });
    return true;
  }

  voiceSpeaking(session, data) {
    const existing = this.voiceStateFor(session.userId);
    if (!existing) return;
    const speaking = !!data.speaking;
    if (session.lastSpeaking === speaking) return;
    session.lastSpeaking = speaking;
    this.dispatchChannel(String(existing.channel_id), {
      type: 'VOICE_SPEAKING',
      data: { channel_id: String(existing.channel_id), user_id: session.userIdString, speaking },
    }, { exceptUserId: session.userIdString });
  }

  dispatchVoiceState(row, _unused) {
    if (!row) return;
    const payload = { type: 'VOICE_STATE_UPDATE', data: voiceStatePayload(row) };
    if (row.guild_id) this.dispatchGuild(String(row.guild_id), payload);
    else this.dispatchChannel(String(row.channel_id), payload);
  }

  voiceStatesForUser(userId) {
    const rows = db.all(
      `SELECT v.* FROM voice_states v
       WHERE v.guild_id IN (SELECT guild_id FROM guild_members WHERE user_id = ?)
          OR v.channel_id IN (SELECT channel_id FROM dm_recipients WHERE user_id = ?)`,
      [userId, userId]);
    return rows.map(voiceStatePayload);
  }

  /* ------------------------------ fan-out core ------------------------------ */

  computeChannelAudience(channelId) {
    const channel = db.get('SELECT * FROM channels WHERE id = ?', [Number(channelId)]);
    if (!channel) return new Set();
    if (!channel.guild_id) {
      return new Set(db.all('SELECT user_id FROM dm_recipients WHERE channel_id = ?', [channel.id]).map((r) => String(r.user_id)));
    }
    const members = db.all('SELECT * FROM guild_members WHERE guild_id = ?', [channel.guild_id]);
    const guild = db.get('SELECT * FROM guilds WHERE id = ?', [channel.guild_id]);
    const roles = perms.getRoles(channel.guild_id);
    const everyoneRole = roles.find((r) => r.is_everyone);
    const ids = new Set();
    for (const member of members) {
      const isOwner = String(guild.owner_id) === String(member.user_id);
      const guildPerms = perms.guildPermissions(channel.guild_id, member.user_id, { isOwner });
      if (isOwner || perms.canViewChannel(channel, member.user_id, member, guildPerms)) {
        ids.add(String(member.user_id));
      }
    }
    return ids;
  }

  channelAudience(channelId) {
    const key = String(channelId);
    const cached = audienceCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.ids;
    const ids = this.computeChannelAudience(channelId);
    audienceCache.set(key, { ids, expires: Date.now() + 5000 });
    return ids;
  }

  invalidateChannel(channelId) {
    audienceCache.delete(String(channelId));
  }

  invalidateGuild(guildId) {
    const channels = db.all('SELECT id FROM channels WHERE guild_id = ?', [guildId]);
    for (const channel of channels) audienceCache.delete(String(channel.id));
  }

  dispatchChannel(channelId, payload, { exceptUserId = null } = {}) {
    const audience = this.channelAudience(channelId);
    const channel = db.get('SELECT guild_id FROM channels WHERE id = ?', [Number(channelId)]);
    for (const userId of audience) {
      if (exceptUserId && userId === exceptUserId) continue;
      for (const session of this.byUser.get(userId) || []) {
        // Only send to sessions that actually want this channel open.
        if (session.channelIds.has(String(channelId)) || payload.type === 'VOICE_STATE_UPDATE' ||
            payload.type === 'VOICE_READY' || payload.type === 'CHANNEL_UPDATE' || payload.type === 'CHANNEL_DELETE') {
          session.send(payload);
        }
      }
    }
    if (channel?.guild_id) { /* guild-wide events handled separately */ }
  }

  dispatchGuild(guildId, payload) {
    const members = db.all('SELECT user_id FROM guild_members WHERE guild_id = ?', [guildId]);
    const seen = new Set();
    for (const { user_id: userId } of members) {
      const key = String(userId);
      if (seen.has(key)) continue;
      seen.add(key);
      this.dispatchUser(key, payload);
    }
  }

  dispatchUser(userId, payload) {
    for (const session of this.byUser.get(String(userId)) || []) session.send(payload);
  }

  dispatchAll(payload) {
    for (const session of this.sessions) session.send(payload);
  }

  /** Push a guild payload into a user's session(s) (used after membership changes). */
  sendGuildToUser(userId, guildId) {
    const guild = db.get('SELECT * FROM guilds WHERE id = ?', [Number(guildId)]);
    if (!guild) return;
    const user = db.get('SELECT * FROM users WHERE id = ?', [Number(userId)]);
    if (!user) return;
    const sessions = [...(this.byUser.get(String(userId)) || [])];
    for (const session of sessions) {
      session.guildIds.add(String(guildId));
      session.send({ type: 'GUILD_CREATE', data: state.guildPayload(guild, user.id, { isAdmin: user.is_admin }) });
    }
  }

  onClose(session) {
    this.sessions.delete(session);
    if (!session.userId) return;
    const key = session.userIdString;
    const set = this.byUser.get(key);
    if (set) {
      set.delete(session);
      if (!set.size) {
        this.byUser.delete(key);
        const entry = presence.get(key) || { connections: 0 };
        entry.connections = 0;
        presence.set(key, entry);
        this.setPresence(session.userId, { status: 'offline' }, { skipSelf: true });
        db.run('UPDATE users SET last_seen = ? WHERE id = ?', [now(), session.userId]);
      }
    }
    const voice = this.voiceStateFor(session.userId);
    if (voice && !this.byUser.has(key)) {
      db.run('DELETE FROM voice_states WHERE user_id = ?', [session.userId]);
      // Relay the departure to the old channel audience.
      const payload = { type: 'VOICE_STATE_UPDATE', data: { ...voiceStatePayload(voice), channel_id: null } };
      if (voice.guild_id) this.dispatchGuild(String(voice.guild_id), payload);
      else this.dispatchChannel(String(voice.channel_id), payload);
    }
  }

  checkAlive() {
    for (const session of this.sessions) {
      if (session.socket.isAlive === false) {
        session.socket.terminate();
        continue;
      }
      session.socket.isAlive = false;
      try { session.socket.ping(); } catch { /* ignore */ }
    }
  }
}

Object.defineProperty(Session.prototype, 'byUserCount', {
  get() { return 1; },
});

function voiceStatePayload(row) {
  return {
    user_id: String(row.user_id),
    guild_id: row.guild_id ? String(row.guild_id) : null,
    channel_id: row.channel_id ? String(row.channel_id) : null,
    session_id: row.session_id,
    self_mute: !!row.self_mute,
    self_deaf: !!row.self_deaf,
    self_video: !!row.self_video,
    self_stream: !!row.self_stream,
    server_mute: !!row.server_mute,
    server_deaf: !!row.server_deaf,
    suppress: !!row.suppress,
    joined_at: row.joined_at,
  };
}

function relationshipPayload(userId) {
  const rows = db.all(
    `SELECT r.type, r.target_id, u.id, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.accent_color, u.is_bot
     FROM relationships r JOIN users u ON u.id = r.target_id WHERE r.user_id = ?`, [userId]);
  const incoming = db.all(
    `SELECT r.user_id, u.id, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.accent_color, u.is_bot
     FROM relationships r JOIN users u ON u.id = r.user_id WHERE r.target_id = ? AND r.type = 3`, [userId]);
  const byType = { 1: [], 2: [], 3: [], 4: [] };
  for (const row of rows) {
    if (byType[row.type]) byType[row.type].push(serialize.userBrief(row));
  }
  const incomingRequests = incoming.map((row) => serialize.userBrief(row));
  // Type 2 = incoming request (we are the target of an outgoing request).
  byType[2] = [...byType[2], ...incomingRequests];
  return {
    friends: byType[1],
    incoming_requests: byType[2],
    outgoing_requests: byType[3],
    blocked: byType[4],
  };
}

function attach(server) {
  const gateway = new Gateway(server);
  bus.setGateway(gateway);
  return gateway;
}

module.exports = { attach, Gateway, OP, presence, voiceStatePayload, relationshipPayload };
