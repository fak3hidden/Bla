/* Bla — REST client. Cookie-based sessions, so nothing sensitive in localStorage. */
(function () {
  'use strict';
  const { toast } = window.Bla;

  let token = null;
  function setToken(value) {
    token = value;
  }

  class ApiError extends Error {
    constructor(message, status, code, payload) {
      super(message);
      this.status = status;
      this.code = code;
      this.payload = payload;
    }
  }

  async function request(method, path, body, options = {}) {
    const headers = {};
    if (body !== undefined && !(body instanceof FormData) && !options.raw) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.headers) Object.assign(headers, options.headers);

    // Every API path is relative to /api — callers pass "/guilds/1", not the prefix.
    const url = /^https?:/.test(path) ? path : (path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : (options.raw ? body : JSON.stringify(body)),
      });
    } catch (err) {
      throw new ApiError('Cannot reach the Bla server. Is it still running?', 0, 'NETWORK', null);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 200) }; }
    }
    if (!response.ok) {
      const error = new ApiError(payload?.error || `Request failed (${response.status})`, response.status, payload?.code, payload);
      if (response.status === 401 && !options.silent401) {
        window.dispatchEvent(new CustomEvent('bla:unauthorized'));
      }
      if (!options.silent) {
        const rateLimited = response.status === 429;
        toast(error.message, rateLimited && payload?.retry_after ? `Try again in ${payload.retry_after}s.` : '', 'error');
      }
      throw error;
    }
    return payload;
  }

  const get = (path, options) => request('GET', path, undefined, options);
  const post = (path, body, options) => request('POST', path, body ?? {}, options);
  const patch = (path, body, options) => request('PATCH', path, body ?? {}, options);
  const put = (path, body, options) => request('PUT', path, body ?? {}, options);
  const del = (path, body, options) => request('DELETE', path, body, options);

  /** Multipart-free upload: raw bytes with the type sniffed server-side. */
  async function upload(file, kind = 'attachment', extra = {}) {
    const params = new URLSearchParams({ kind, filename: file.name || 'upload' });
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) params.set(key, value);
    }
    const headers = { 'Content-Type': file.type || 'application/octet-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`/api/uploads?${params}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: file,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(payload?.error || 'Upload failed.', response.status, payload?.code, payload);
    return payload;
  }

  window.BlaApi = {
    ApiError, request, get, post, patch, put, del, upload, setToken,
    getToken: () => token,

    /* auth */
    config: () => get('/auth/config', { silent: true }),
    register: (data) => post('/auth/register', data, { silent: true }),
    login: (data) => post('/auth/login', data, { silent: true }),
    logout: () => post('/auth/logout', {}, { silent: true }),
    me: () => get('/auth/me', { silent: true }),
    updateMe: (data) => patch('/auth/me', data),
    changePassword: (data) => patch('/auth/me', data),
    sessions: () => get('/auth/sessions'),
    revokeSession: (id) => del(`/auth/sessions/${id}`),
    deleteAccount: (data) => del('/auth/me', data),

    /* guilds */
    guilds: () => get('/guilds'),
    guild: (id) => get(`/guilds/${id}`),
    createGuild: (data) => post('/guilds', data),
    updateGuild: (id, data) => patch(`/guilds/${id}`, data),
    deleteGuild: (id) => del(`/guilds/${id}`),
    leaveGuild: (id) => post(`/guilds/${id}/leave`),
    transferOwnership: (id, userId) => post(`/guilds/${id}/transfer-ownership`, { user_id: userId }),

    createChannel: (guildId, data) => post(`/guilds/${guildId}/channels`, data),
    updateChannel: (guildId, channelId, data) => patch(`/guilds/${guildId}/channels/${channelId}`, data),
    deleteChannel: (guildId, channelId) => del(`/guilds/${guildId}/channels/${channelId}`),
    reorderChannels: (guildId, positions) => patch(`/guilds/${guildId}/channels`, { positions }),
    setOverwrite: (guildId, channelId, targetId, data) => put(`/guilds/${guildId}/channels/${channelId}/permissions/${targetId}`, data),
    deleteOverwrite: (guildId, channelId, targetId, type) => del(`/guilds/${guildId}/channels/${channelId}/permissions/${targetId}?type=${type}`),

    roles: (guildId) => get(`/guilds/${guildId}/roles`),
    createRole: (guildId, data) => post(`/guilds/${guildId}/roles`, data),
    updateRole: (guildId, roleId, data) => patch(`/guilds/${guildId}/roles/${roleId}`, data),
    deleteRole: (guildId, roleId) => del(`/guilds/${guildId}/roles/${roleId}`),

    members: (guildId, params = '') => get(`/guilds/${guildId}/members${params}`),
    member: (guildId, userId) => get(`/guilds/${guildId}/members/${userId}`),
    searchMembers: (guildId, q) => get(`/guilds/${guildId}/members/search?q=${encodeURIComponent(q)}`),
    updateMember: (guildId, userId, data) => patch(`/guilds/${guildId}/members/${userId}`, data),
    kickMember: (guildId, userId, reason) => del(`/guilds/${guildId}/members/${userId}`, { reason }),
    addRole: (guildId, userId, roleId) => put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`),
    removeRole: (guildId, userId, roleId) => del(`/guilds/${guildId}/members/${userId}/roles/${roleId}`),

    bans: (guildId) => get(`/guilds/${guildId}/bans`),
    ban: (guildId, userId, reason) => put(`/guilds/${guildId}/bans/${userId}`, { reason }),
    unban: (guildId, userId) => del(`/guilds/${guildId}/bans/${userId}`),

    auditLog: (guildId, params = '') => get(`/guilds/${guildId}/audit-logs${params}`),
    invites: (guildId) => get(`/guilds/${guildId}/invites`),
    createInvite: (guildId, data) => post(`/guilds/${guildId}/invites`, data),
    revokeInvite: (guildId, code) => del(`/guilds/${guildId}/invites/${code}`),

    emojis: (guildId) => get(`/guilds/${guildId}/emojis`),
    createEmoji: (guildId, data) => post(`/guilds/${guildId}/emojis`, data),
    deleteEmoji: (guildId, emojiId) => del(`/guilds/${guildId}/emojis/${emojiId}`),
    createSticker: (guildId, data) => post(`/guilds/${guildId}/stickers`, data),
    deleteSticker: (guildId, stickerId) => del(`/guilds/${guildId}/stickers/${stickerId}`),
    createSound: (guildId, data) => post(`/guilds/${guildId}/soundboard`, data),
    deleteSound: (guildId, soundId) => del(`/guilds/${guildId}/soundboard/${soundId}`),

    webhooks: (guildId) => get(`/guilds/${guildId}/webhooks`),
    createWebhook: (guildId, data) => post(`/guilds/${guildId}/webhooks`, data),
    deleteWebhook: (guildId, webhookId) => del(`/guilds/${guildId}/webhooks/${webhookId}`),

    searchMessages: (guildId, params) => get(`/guilds/${guildId}/messages/search?${new URLSearchParams(params)}`),

    /* channels + messages */
    channel: (id) => get(`/channels/${id}`),
    messages: (id, params = {}) => get(`/channels/${id}/messages?${new URLSearchParams(params)}`),
    sendMessage: (id, data) => post(`/channels/${id}/messages`, data),
    pins: (id) => get(`/channels/${id}/pins`),
    pin: (channelId, messageId) => put(`/channels/${channelId}/pins/${messageId}`),
    unpin: (channelId, messageId) => del(`/channels/${channelId}/pins/${messageId}`),
    bulkDelete: (channelId, ids) => post(`/channels/${channelId}/messages/bulk-delete`, { messages: ids }),
    ack: (channelId, data) => post(`/channels/${channelId}/ack`, data ?? {}),
    muteChannel: (channelId, muted) => put(`/channels/${channelId}/mute`, { muted }),
    editMessage: (id, content) => patch(`/messages/${id}`, { content }),
    deleteMessage: (id) => del(`/messages/${id}`),
    react: (messageId, emoji) => put(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`),
    unreact: (messageId, emoji) => del(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`),
    votePoll: (messageId, answerIds) => post(`/messages/${messageId}/poll/vote`, { answer_ids: answerIds }),
    endPoll: (messageId) => post(`/messages/${messageId}/poll/end`),

    /* dms + friends */
    dms: () => get('/dms'),
    openDm: (recipients, name) => post('/dms', { recipients, name }),
    closeDm: (channelId) => del(`/dms/${channelId}`),
    startCall: (channelId) => post(`/dms/${channelId}/call`),
    addRecipient: (channelId, userId) => put(`/dms/${channelId}/recipients/${userId}`),
    removeRecipient: (channelId, userId) => del(`/dms/${channelId}/recipients/${userId}`),

    relationships: () => get('/relationships'),
    addFriend: (data) => post('/relationships', data),
    acceptFriend: (userId) => put(`/relationships/${userId}`),
    removeFriend: (userId, type = 'friend') => del(`/relationships/${userId}?type=${type}`),
    blockUser: (userId) => del(`/relationships/${userId}?type=block`),
    unblockUser: (userId) => del(`/relationships/${userId}?type=unblock`),

    users: (q, limit = 25) => get(`/users?q=${encodeURIComponent(q || '')}&limit=${limit}`),
    user: (id) => get(`/users/${id}`),
    userProfile: (id) => get(`/users/${id}/profile`),
    userGuilds: (id) => get(`/users/${id}/guilds`),

    /* invites + discovery */
    invitePreview: (code) => get(`/invites/${code}`, { silent: true }),
    acceptInvite: (code) => post(`/invites/${code}`),
    discovery: (params = {}) => get(`/discovery?${new URLSearchParams(params)}`),
    discoveryPreview: (id) => get(`/discovery/${id}`),
    joinDiscovery: (id) => post(`/discovery/${id}/join`),

    /* voice */
    ice: () => get('/voice/ice'),
    voiceStates: () => get('/voice/states'),
    voiceChannel: (id) => get(`/voice/channels/${id}`),
    voiceModerate: (userId, data) => patch(`/voice/users/${userId}`, data),

    /* admin */
    adminStats: () => get('/admin/stats'),
    adminSettings: () => get('/admin/settings'),
    adminUpdateSettings: (data) => patch('/admin/settings', data),
    adminUsers: (q) => get(`/admin/users?q=${encodeURIComponent(q || '')}`),
    adminUpdateUser: (id, data) => patch(`/admin/users/${id}`, data),
    adminDeleteUser: (id) => del(`/admin/users/${id}`),
    adminGuilds: (q) => get(`/admin/guilds?q=${encodeURIComponent(q || '')}`),
    adminDeleteGuild: (id) => del(`/admin/guilds/${id}`),
    adminInstanceInvites: () => get('/admin/instance-invites'),
    adminCreateInstanceInvite: (data) => post('/admin/instance-invites', data),
    adminMaintenance: (kind) => post(`/admin/maintenance/${kind}`),
  };
}());
