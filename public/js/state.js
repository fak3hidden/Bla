/* Bla — client state. One store, one event emitter, no dependencies. */
(function () {
  'use strict';

  const listeners = new Map();

  const state = {
    config: null,
    me: null,
    token: null,

    guilds: new Map(),        // id -> guild payload
    guildOrder: [],
    channels: new Map(),      // channel id -> channel
    messages: new Map(),      // channel id -> array of messages
    users: new Map(),         // user id -> user
    presences: new Map(),     // user id -> { status, custom_status }
    emojis: new Map(),        // emoji id -> emoji
    relationships: { friends: [], incoming_requests: [], outgoing_requests: [], blocked: [] },
    dmChannels: [],
    readStates: new Map(),    // channel id -> { last_message_id, mention_count, muted, unread }
    guildReadStates: new Map(),

    typing: new Map(),        // channel id -> Map(userId -> { name, until })
    voiceStates: new Map(),   // user id -> voice state
    voiceChannel: null,       // channel id we are connected to (gateway state)
    connected: false,

    view: { kind: 'guild', guildId: null, channelId: null, homeTab: 'friends' },
    drafts: new Map(),
    activeThread: null,
    collapsedCategories: new Set(JSON.parse(localStorage.getItem('bla:collapsed') || '[]')),
    settings: { compact: false, showMembers: true, desktopNotifications: false, sounds: true, theme: 'midnight' },
    loadingOlder: new Set(),
    hasMore: new Map(),
  };

  try { Object.assign(state.settings, JSON.parse(localStorage.getItem('bla:settings') || '{}')); } catch { /* ignore */ }

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event).delete(handler);
  }

  function emit(event, payload) {
    for (const handler of listeners.get(event) || []) {
      try { handler(payload); } catch (err) { console.error('listener failed', event, err); }
    }
  }

  /* ── getters ───────────────────────────────────────────────────── */

  const currentGuild = () => (state.view.guildId ? state.guilds.get(String(state.view.guildId)) : null);
  const currentChannel = () => (state.view.channelId ? state.channels.get(String(state.view.channelId)) : null);

  function channelMessages(channelId) {
    return state.messages.get(String(channelId)) || [];
  }

  function user(id) {
    const found = state.users.get(String(id));
    if (found) return found;
    return { id: String(id), username: 'unknown', display_name: 'Unknown', discriminator: '0000', avatar: null };
  }

  function rememberUser(u) {
    if (!u || !u.id) return u;
    state.users.set(String(u.id), { ...(state.users.get(String(u.id)) || {}), ...u });
    return u;
  }

  function presence(id) {
    return state.presences.get(String(id)) || { user_id: String(id), status: 'offline', custom_status: null };
  }

  function memberOf(guildId, userId) {
    const guild = state.guilds.get(String(guildId));
    if (!guild) return null;
    return guild.members.find((m) => String(m.user_id) === String(userId)) || null;
  }

  function displayName(userOrId, guildId = null) {
    const u = typeof userOrId === 'object' ? userOrId : user(userOrId);
    if (guildId) {
      const member = memberOf(guildId, u.id);
      if (member?.nickname) return member.nickname;
    }
    return u.display_name || u.username;
  }

  function rolesOf(guildId, userId) {
    const guild = state.guilds.get(String(guildId));
    const member = memberOf(guildId, userId);
    if (!guild || !member) return [];
    const ids = new Set((member.roles || []).map(String));
    return guild.roles.filter((r) => ids.has(String(r.id)) && !r.is_everyone)
      .sort((a, b) => b.position - a.position);
  }

  function topRoleColor(guildId, userId) {
    const roles = rolesOf(guildId, userId);
    const colored = roles.find((r) => r.color);
    return colored ? colored.color : null;
  }

  function myPermissions(guildId) {
    const guild = state.guilds.get(String(guildId));
    return guild ? BigInt(guild.my_permissions || '0') : 0n;
  }

  const PERM = {
    ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n, MANAGE_GUILD: 1n << 5n,
    VIEW_AUDIT_LOG: 1n << 7n, MANAGE_MESSAGES: 1n << 13n, MANAGE_ROLES: 1n << 28n,
    MANAGE_WEBHOOKS: 1n << 29n, MANAGE_EXPRESSIONS: 1n << 30n, KICK_MEMBERS: 1n << 1n,
    BAN_MEMBERS: 1n << 2n, MODERATE_MEMBERS: 1n << 40n, MUTE_MEMBERS: 1n << 22n,
    DEAFEN_MEMBERS: 1n << 23n, MOVE_MEMBERS: 1n << 24n, SEND_MESSAGES: 1n << 11n,
    CREATE_INSTANT_INVITE: 1n << 0n, ADD_REACTIONS: 1n << 6n, ATTACH_FILES: 1n << 15n,
    CONNECT: 1n << 20n, SPEAK: 1n << 21n, VIEW_CHANNEL: 1n << 10n, PRIORITY_SPEAKER: 1n << 8n,
    STREAM: 1n << 9n, USE_SOUNDBOARD: 1n << 42n, SEND_POLLS: 1n << 49n,
  };

  function can(permission, guildId = null) {
    const guild = guildId ? state.guilds.get(String(guildId)) : currentGuild();
    if (!guild) return false;
    if (guild.is_owner) return true;
    const perms = BigInt(guild.my_permissions || '0');
    if ((perms & PERM.ADMINISTRATOR) === PERM.ADMINISTRATOR) return true;
    return (perms & permission) === permission;
  }

  /** Channel-level permission check (uses the per-channel mask the API sends). */
  function canInChannel(channelId, permission) {
    const channel = state.channels.get(String(channelId));
    if (!channel) return false;
    if (!channel.guild_id) return true;
    const guild = state.guilds.get(String(channel.guild_id));
    if (!guild) return false;
    if (guild.is_owner) return true;
    const perms = BigInt(channel.permissions || guild.my_permissions || '0');
    if ((perms & PERM.ADMINISTRATOR) === PERM.ADMINISTRATOR) return true;
    return (perms & permission) === permission;
  }

  /* ── mutators ──────────────────────────────────────────────────── */

  function setGuild(guild) {
    state.guilds.set(String(guild.id), guild);
    if (!state.guildOrder.includes(String(guild.id))) state.guildOrder.push(String(guild.id));
    for (const channel of guild.channels || []) {
      state.channels.set(String(channel.id), channel);
    }
    for (const member of guild.members || []) rememberUser(member.user);
    for (const emoji of guild.emojis || []) state.emojis.set(String(emoji.id), emoji);
    emit('guild:update', guild);
  }

  function removeGuild(guildId) {
    const guild = state.guilds.get(String(guildId));
    state.guilds.delete(String(guildId));
    state.guildOrder = state.guildOrder.filter((id) => id !== String(guildId));
    for (const channel of guild?.channels || []) {
      state.channels.delete(String(channel.id));
      state.messages.delete(String(channel.id));
    }
    if (String(state.view.guildId) === String(guildId)) {
      state.view.guildId = null;
      state.view.channelId = null;
    }
    emit('guild:remove', guildId);
  }

  function setChannel(channel) {
    state.channels.set(String(channel.id), channel);
    if (channel.guild_id) {
      const guild = state.guilds.get(String(channel.guild_id));
      if (guild) {
        const index = guild.channels.findIndex((c) => String(c.id) === String(channel.id));
        if (index >= 0) guild.channels[index] = { ...guild.channels[index], ...channel };
        else guild.channels.push(channel);
      }
    }
    emit('channel:update', channel);
  }

  function removeChannel(channelId) {
    const channel = state.channels.get(String(channelId));
    state.channels.delete(String(channelId));
    state.messages.delete(String(channelId));
    if (channel?.guild_id) {
      const guild = state.guilds.get(String(channel.guild_id));
      if (guild) guild.channels = guild.channels.filter((c) => String(c.id) !== String(channelId));
    }
    state.dmChannels = state.dmChannels.filter((c) => String(c.id) !== String(channelId));
    if (String(state.view.channelId) === String(channelId)) state.view.channelId = null;
    emit('channel:remove', channelId);
  }

  function setMessages(channelId, list, { prepend = false, append = true } = {}) {
    const key = String(channelId);
    const existing = prepend ? state.messages.get(key) || [] : [];
    const seen = new Set();
    const merged = [];
    for (const message of [...list, ...existing]) {
      if (seen.has(String(message.id))) continue;
      seen.add(String(message.id));
      merged.push(message);
    }
    merged.sort((a, b) => Number(a.id) - Number(b.id));
    state.messages.set(key, merged);
    emit('messages:update', { channelId: key, messages: merged });
    return merged;
  }

  function addMessage(message) {
    const key = String(message.channel_id);
    const list = state.messages.get(key) || [];
    if (list.some((m) => String(m.id) === String(message.id))) return;
    list.push(message);
    list.sort((a, b) => Number(a.id) - Number(b.id));
    state.messages.set(key, list);
    for (const user_ of [message.author, ...(message.mentions || [])]) rememberUser(user_);
    emit('message:new', message);
  }

  function updateMessage(message) {
    const key = String(message.channel_id);
    const list = state.messages.get(key) || [];
    const index = list.findIndex((m) => String(m.id) === String(message.id));
    if (index >= 0) list[index] = { ...list[index], ...message };
    else list.push(message);
    emit('message:update', message);
  }

  function removeMessage(channelId, messageId) {
    const key = String(channelId);
    const list = (state.messages.get(key) || []).filter((m) => String(m.id) !== String(messageId));
    state.messages.set(key, list);
    emit('message:remove', { channelId: key, messageId: String(messageId) });
  }

  function removeMessages(channelId, ids) {
    const set = new Set(ids.map(String));
    const key = String(channelId);
    state.messages.set(key, (state.messages.get(key) || []).filter((m) => !set.has(String(m.id))));
    emit('messages:update', { channelId: key, messages: state.messages.get(key) });
  }

  function setPresence(payload) {
    const key = String(payload.user_id);
    const previous = state.presences.get(key);
    state.presences.set(key, { ...(previous || {}), ...payload });
    emit('presence:update', { ...payload, previous });
  }

  function setReadState(channelId, patch) {
    const key = String(channelId);
    const current = state.readStates.get(key) || {};
    state.readStates.set(key, { ...current, ...patch });
    emit('read:update', { channelId: key, ...patch });
  }

  function setTyping(channelId, userId, name) {
    const key = String(channelId);
    if (!state.typing.has(key)) state.typing.set(key, new Map());
    state.typing.get(key).set(String(userId), { name, until: Date.now() + 8000 });
    emit('typing:update', key);
    setTimeout(() => {
      const map = state.typing.get(key);
      if (!map) return;
      const entry = map.get(String(userId));
      if (entry && entry.until <= Date.now()) {
        map.delete(String(userId));
        emit('typing:update', key);
      }
    }, 8100);
  }

  function typingNames(channelId) {
    const map = state.typing.get(String(channelId));
    if (!map) return [];
    return [...map.entries()].filter(([, v]) => v.until > Date.now()).map(([id, v]) => ({ id, name: v.name }));
  }

  function unreadCount(guildId) {
    const guild = state.guilds.get(String(guildId));
    if (!guild) return 0;
    let count = 0;
    for (const channel of guild.channels) {
      const read = state.readStates.get(String(channel.id));
      if (read?.mention_count) count += read.mention_count;
    }
    return count;
  }

  function channelUnread(channelId) {
    const read = state.readStates.get(String(channelId));
    if (!read) return { unread: false, mentions: 0 };
    const channel = state.channels.get(String(channelId));
    const last = channel?.last_message_id ? String(channel.last_message_id) : null;
    const seen = read.last_message_id ? String(read.last_message_id) : null;
    const unread = !!(last && (!seen || BigInt(last) > BigInt(seen)));
    return { unread, mentions: read.mention_count || 0, muted: !!read.muted };
  }

  function saveSettings() {
    localStorage.setItem('bla:settings', JSON.stringify(state.settings));
    emit('settings:update', state.settings);
  }

  function toggleCategory(id) {
    if (state.collapsedCategories.has(String(id))) state.collapsedCategories.delete(String(id));
    else state.collapsedCategories.add(String(id));
    localStorage.setItem('bla:collapsed', JSON.stringify([...state.collapsedCategories]));
    emit('channels:render');
  }

  function setDraft(channelId, text) {
    const key = String(channelId);
    if (text) state.drafts.set(key, text);
    else state.drafts.delete(key);
  }

  function sortedFriends() {
    const statusRank = { online: 0, streaming: 0, idle: 1, dnd: 2, invisible: 3, offline: 4 };
    return [...state.relationships.friends].sort((a, b) => {
      const sa = statusRank[presence(a.id).status] ?? 5;
      const sb = statusRank[presence(b.id).status] ?? 5;
      if (sa !== sb) return sa - sb;
      return displayName(a).localeCompare(displayName(b));
    });
  }

  window.BlaState = {
    state, on, emit, currentGuild, currentChannel, channelMessages, user, rememberUser, presence,
    displayName, rolesOf, topRoleColor, memberOf, myPermissions, can, canInChannel, PERM,
    setGuild, removeGuild, setChannel, removeChannel, setMessages, addMessage, updateMessage,
    removeMessage, removeMessages, setPresence, setReadState, setTyping, typingNames,
    unreadCount, channelUnread, saveSettings, toggleCategory, setDraft, sortedFriends,
  };
}());
