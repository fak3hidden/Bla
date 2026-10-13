/* Bla — realtime client. Reconnects with backoff, heartbeats, and funnels every
   gateway event into the store. */
(function () {
  'use strict';
  const { toast } = window.Bla;
  const S = window.BlaState;
  const state = S.state;

  let socket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let attempts = 0;
  let intentionalClose = false;
  let latency = 0;
  const listeners = new Map();

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type).delete(handler);
  }

  function emitLocal(type, payload) {
    for (const handler of listeners.get(type) || []) {
      try { handler(payload); } catch (err) { console.error(err); }
    }
  }

  function url() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/gateway`;
  }

  function connect() {
    if (!state.token && !state.me) return;
    intentionalClose = false;
    socket = new WebSocket(url());

    socket.addEventListener('open', () => {
      attempts = 0;
      send('IDENTIFY', { token: state.token });
      startHeartbeat();
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.op === 'HELLO') return;
      if (payload.op === 'PONG') {
        latency = Date.now() - (payload.nonce || Date.now());
        return;
      }
      if (payload.op === 'ERROR') {
        if (payload.data?.code === 'INVALID_SESSION') {
          window.dispatchEvent(new CustomEvent('bla:unauthorized'));
          return;
        }
        console.warn('[gateway]', payload.data);
        emitLocal('error', payload.data);
        return;
      }
      if (payload.op === 'READY') return handleReady(payload.data);
      if (payload.op === 'VOICE_READY') {
        state.voiceSession = payload.data;
        mergeVoiceSession(payload.data);
        emitLocal('voice:ready', payload.data);
        return;
      }
      if (payload.op === 'GUILD_SYNC') {
        S.setGuild(payload.data.guild);
        return;
      }
      if (payload.op === 'GUILD_MEMBERS') {
        const guild = state.guilds.get(String(payload.data.guild_id));
        if (guild) {
          guild.members = payload.data.members;
          for (const member of payload.data.members) S.rememberUser(member.user);
          S.emit('members:update', guild.id);
        }
        for (const presence of payload.data.presences || []) S.setPresence(presence);
        return;
      }
      if (payload.op === 'SUBSCRIBED' || payload.op === 'UNSUBSCRIBED') return;

      // Everything else is a dispatch event with { type, data }
      if (payload.type) handleDispatch(payload.type, payload.data);
    });

    socket.addEventListener('close', () => {
      stopHeartbeat();
      state.connected = false;
      S.emit('connection', { connected: false });
      if (intentionalClose) return;
      attempts += 1;
      const delay = Math.min(1000 * 2 ** Math.min(attempts, 5), 20000);
      reconnectTimer = setTimeout(connect, delay);
    });

    socket.addEventListener('error', () => {
      try { socket.close(); } catch { /* ignore */ }
    });
  }

  /** VOICE_READY carries the authoritative session id, channel and ICE config. */
  function mergeVoiceSession(data) {
    if (!data || !data.channel_id) return;
    const channel = state.channels.get(String(data.channel_id));
    state.sessionId = data.session_id;
    state.voiceChannel = Object.assign({}, state.voiceChannel, {
      id: String(data.channel_id),
      guildId: channel?.guild_id ? String(channel.guild_id) : (state.voiceChannel?.guildId || null),
      sessionId: data.session_id,
      iceServers: data.ice_servers || [],
      bitrate: data.bitrate ?? null,
      mode: data.mode || 'mesh-p2p',
      channel: channel || state.voiceChannel?.channel || null,
    });
  }

  function handleReady(data) {
    state.connected = true;
    state.me = data.user;
    state.sessionId = data.session_id;
    S.rememberUser(data.user);
    state.dmChannels = data.dm_channels || [];
    for (const read of data.read_states || []) {
      for (const channel of read.channels || []) {
        S.setReadState(channel.channel_id, {
          last_message_id: channel.last_read_message_id,
          mention_count: channel.mention_count,
          muted: channel.muted,
          unread: channel.unread,
        });
      }
      state.guildReadStates.set(String(read.guild_id), read.guild);
    }
    state.relationships = data.relationships || state.relationships;
    for (const presence of data.presences || []) S.setPresence(presence);
    for (const voice of data.voice_states || []) state.voiceStates.set(String(voice.user_id), voice);
    S.emit('ready', data);
    emitLocal('ready', data);
  }

  function handleDispatch(type, data) {
    switch (type) {
      case 'MESSAGE_CREATE': {
        S.addMessage(data);
        S.rememberUser(data.author);
        const channel = state.channels.get(String(data.channel_id));
        if (channel) {
          channel.last_message_id = data.id;
          S.emit('channel:update', channel);
        }
        if (data.poll) S.emit('poll:update', data);
        emitLocal('message', data);
        break;
      }
      case 'MESSAGE_UPDATE':
      case 'MESSAGE_POLL_VOTE_ADD': {
        if (data.poll && !data.content && !data.author) {
          S.emit('poll:update', data);
          break;
        }
        S.updateMessage(data);
        break;
      }
      case 'MESSAGE_DELETE':
        S.removeMessage(data.channel_id, data.id);
        break;
      case 'MESSAGE_DELETE_BULK':
        S.removeMessages(data.channel_id, data.ids);
        break;
      case 'MESSAGE_REACTION_UPDATE': {
        S.emit('reaction:update', data);
        break;
      }
      case 'MESSAGE_REACTIONS_CLEAR':
        S.emit('reaction:clear', data);
        break;
      case 'TYPING_START': {
        S.rememberUser(data.user);
        S.setTyping(data.channel_id, data.user_id, S.displayName(data.user, data.guild_id));
        break;
      }
      case 'PRESENCE_UPDATE':
        S.setPresence(data);
        break;
      case 'READ_STATE_UPDATE':
        S.setReadState(data.channel_id, { last_message_id: data.last_message_id, mention_count: data.mention_count });
        break;
      case 'GUILD_CREATE':
        S.setGuild(data);
        emitLocal('guild:create', data);
        break;
      case 'GUILD_UPDATE':
        S.setGuild(data);
        break;
      case 'GUILD_DELETE':
        S.removeGuild(data.id);
        break;
      case 'GUILD_CHANNELS_RESYNC': {
        const guild = state.guilds.get(String(data.guild_id));
        if (guild) {
          guild.channels = data.channels;
          for (const channel of data.channels) state.channels.set(String(channel.id), channel);
          S.emit('guild:update', guild);
        }
        break;
      }
      case 'CHANNEL_CREATE':
        S.setChannel(data);
        if (data.recipients) state.dmChannels = [...state.dmChannels.filter((c) => String(c.id) !== String(data.id)), data];
        emitLocal('channel:create', data);
        break;
      case 'CHANNEL_UPDATE':
        S.setChannel(data);
        break;
      case 'CHANNEL_DELETE':
      case 'CHANNEL_RECIPIENT_REMOVE':
        S.removeChannel(data.id || data.channel_id);
        break;
      case 'CHANNEL_RECIPIENT_ADD':
        emitLocal('channel:recipient-add', data);
        break;
      case 'CHANNEL_PINS_UPDATE':
        S.emit('pins:update', data);
        break;
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const guild = state.guilds.get(String(data.guild_id));
        if (guild) {
          const index = guild.roles.findIndex((r) => String(r.id) === String(data.role.id));
          if (index >= 0) guild.roles[index] = data.role;
          else guild.roles.push(data.role);
          guild.roles.sort((a, b) => b.position - a.position);
          S.emit('roles:update', guild);
        }
        break;
      }
      case 'GUILD_ROLE_DELETE': {
        const guild = state.guilds.get(String(data.guild_id));
        if (guild) {
          guild.roles = guild.roles.filter((r) => String(r.id) !== String(data.role_id));
          for (const member of guild.members) member.roles = member.roles.filter((id) => String(id) !== String(data.role_id));
          S.emit('roles:update', guild);
        }
        break;
      }
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE': {
        const guild = state.guilds.get(String(data.guild_id));
        if (!guild) break;
        if (data.member) {
          const index = guild.members.findIndex((m) => String(m.user_id) === String(data.member.user_id));
          if (index >= 0) guild.members[index] = { ...guild.members[index], ...data.member };
          else guild.members.push(data.member);
          S.rememberUser(data.member.user);
        } else if (data.user_id && data.roles) {
          const member = guild.members.find((m) => String(m.user_id) === String(data.user_id));
          if (member) member.roles = data.roles;
        }
        S.emit('members:update', guild.id);
        break;
      }
      case 'GUILD_MEMBER_REMOVE': {
        const guild = state.guilds.get(String(data.guild_id));
        if (!guild) break;
        guild.members = guild.members.filter((m) => String(m.user_id) !== String(data.user_id));
        state.voiceStates.delete(String(data.user_id));
        S.emit('members:update', guild.id);
        break;
      }
      case 'GUILD_BAN_ADD': {
        const guild = state.guilds.get(String(data.guild_id));
        if (guild) {
          guild.members = guild.members.filter((m) => String(m.user_id) !== String(data.user_id));
          S.emit('members:update', guild.id);
        }
        break;
      }
      case 'GUILD_EMOJIS_UPDATE': {
        const guild = state.guilds.get(String(data.guild_id));
        if (data.deleted) {
          state.emojis.delete(String(data.emoji_id));
          if (guild) guild.emojis = guild.emojis.filter((e) => String(e.id) !== String(data.emoji_id));
        } else if (data.emoji) {
          state.emojis.set(String(data.emoji.id), data.emoji);
          if (guild) {
            const index = guild.emojis.findIndex((e) => String(e.id) === String(data.emoji.id));
            if (index >= 0) guild.emojis[index] = data.emoji;
            else guild.emojis.push(data.emoji);
          }
        }
        S.emit('emojis:update', data);
        break;
      }
      case 'GUILD_STICKERS_UPDATE': {
        const guild = state.guilds.get(String(data.guild_id));
        if (!guild) break;
        if (data.deleted) guild.stickers = (guild.stickers || []).filter((s) => String(s.id) !== String(data.sticker_id));
        else if (data.sticker) guild.stickers = [...(guild.stickers || []).filter((s) => String(s.id) !== String(data.sticker.id)), data.sticker];
        S.emit('stickers:update', data);
        break;
      }
      case 'GUILD_SOUNDBOARD_UPDATE': {
        const guild = state.guilds.get(String(data.guild_id));
        if (!guild) break;
        if (data.deleted) guild.soundboard = (guild.soundboard || []).filter((s) => String(s.id) !== String(data.sound_id));
        else if (data.sound) guild.soundboard = [...(guild.soundboard || []).filter((s) => String(s.id) !== String(data.sound.id)), data.sound];
        S.emit('soundboard:update', data);
        break;
      }
      case 'VOICE_STATE_UPDATE': {
        if (data.channel_id) state.voiceStates.set(String(data.user_id), data);
        else state.voiceStates.delete(String(data.user_id));
        S.emit('voice:state', data);
        emitLocal('voice:state', data);
        break;
      }
      case 'VOICE_SPEAKING':
        emitLocal('voice:speaking', data);
        break;
      case 'VOICE_SIGNAL':
        emitLocal('voice:signal', data);
        break;
      case 'VOICE_LEAVE':
        emitLocal('voice:leave', data);
        break;
      case 'RELATIONSHIP_ADD':
      case 'RELATIONSHIP_REMOVE': {
        emitLocal('relationship', { type, data });
        break;
      }
      case 'DM_CHANNEL_CREATE':
        emitLocal('dm:create', data);
        break;
      case 'CALL_RING':
        emitLocal('call:ring', data);
        break;
      default:
        break;
    }
  }

  function send(op, data = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ op, data }));
    return true;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) send('PING', {});
    }, 30000);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function subscribe(channelIds) {
    const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
    if (!ids.length) return;
    send('SUBSCRIBE', { channel_ids: ids.map(String) });
  }

  function unsubscribe(channelIds) {
    const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
    if (!ids.length) return;
    send('UNSUBSCRIBE', { channel_ids: ids.map(String) });
  }

  function disconnect() {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    stopHeartbeat();
    try { socket?.close(); } catch { /* ignore */ }
    socket = null;
  }

  function reconnectNow() {
    disconnect();
    setTimeout(connect, 50);
  }

  window.BlaGateway = {
    connect, disconnect, reconnectNow, send, on, subscribe, unsubscribe,
    get latency() { return latency; },
    get isConnected() { return socket?.readyState === WebSocket.OPEN; },
    joinVoice: (data) => send('VOICE_JOIN', data),
    leaveVoice: () => send('VOICE_LEAVE', {}),
    updateVoice: (data) => send('VOICE_STATE', data),
    signal: (data) => send('VOICE_SIGNAL', data),
    speaking: (speaking) => send('VOICE_SPEAKING', { speaking }),
    updatePresence: (data) => send('PRESENCE_UPDATE', data),
    typing: (channelId) => send('TYPING', { channel_id: String(channelId) }),
    requestMembers: (guildId) => send('REQUEST_MEMBERS', { guild_id: String(guildId) }),
    syncGuild: (guildId) => send('REQUEST_GUILD_SYNC', { guild_id: String(guildId) }),
  };
}());
