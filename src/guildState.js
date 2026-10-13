'use strict';
const db = require('./db');
const perms = require('./perms');
const serialize = require('./serialize');

/** Everything the client needs to render one server, in one payload. */
function guildPayload(guild, userId, { withMembers = true, isAdmin = false } = {}) {
  const member = perms.getMember(guild.id, userId);
  const isOwner = String(guild.owner_id) === String(userId);
  const guildPerms = perms.guildPermissions(guild.id, userId, { isOwner, isAdmin });

  const channels = sortChannels(db.all('SELECT * FROM channels WHERE guild_id = ? ORDER BY position ASC, id ASC', [guild.id])
    .filter((channel) => {
      if (isOwner || isAdmin) return true;
      return perms.canViewChannel(channel, userId, member, guildPerms);
    }))
    .map((channel) => {
      const channelPerms = perms.channelPermissions(channel, userId, member, guildPerms);
      return serialize.serializeChannel(channel, { permissions: channelPerms.toString() });
    });

  const roles = perms.getRoles(guild.id).map((r) => serialize.serializeRole(r));
  const memberPayload = withMembers ? membersPayload(guild.id) : [];

  return {
    id: String(guild.id),
    name: guild.name,
    icon: guild.icon,
    banner: guild.banner,
    splash: guild.splash,
    description: guild.description || '',
    owner_id: String(guild.owner_id),
    created_at: guild.created_at,
    vanity_url: guild.vanity_url,
    boost_level: 3,
    boost_tier_label: 'All boost perks unlocked — free, forever',
    tags: serialize.safeJson(guild.tags, []),
    locale: guild.locale,
    discovery: !!guild.discovery,
    afk_channel_id: guild.afk_channel_id ? String(guild.afk_channel_id) : null,
    afk_timeout: guild.afk_timeout,
    system_channel_id: guild.system_channel_id ? String(guild.system_channel_id) : null,
    rules_channel_id: guild.rules_channel_id ? String(guild.rules_channel_id) : null,
    verification_level: guild.verification_level,
    explicit_content_filter: guild.explicit_content_filter,
    default_notifications: guild.default_notifications,
    features: ['ALL_BOOST_PERKS_FREE', 'ANIMATED_ICON', 'BANNER', 'COMMUNITY', 'VANITY_URL', 'INVITE_SPLASH', 'SOUNDBOARD', 'MEMBER_LIST'],
    premium_tier: 3,
    channels,
    roles,
    emojis: db.all('SELECT * FROM emojis WHERE guild_id = ? ORDER BY id ASC', [guild.id]).map(serialize.serializeEmoji),
    stickers: db.all('SELECT * FROM stickers WHERE guild_id = ? ORDER BY id ASC', [guild.id]).map(serialize.serializeSticker),
    soundboard: db.all('SELECT * FROM soundboard_sounds WHERE guild_id = ? ORDER BY id ASC', [guild.id]).map(serialize.serializeSound),
    members: memberPayload,
    member_count: memberPayload.length || serialize.memberCount(guild.id),
    my_member: member ? serializeMemberRow(guild.id, member) : null,
    my_permissions: guildPerms.toString(),
    is_owner: isOwner,
    voice_states: voiceStatesPayload(guild.id),
    owner: serialize.userBrief(db.get('SELECT * FROM users WHERE id = ?', [guild.owner_id])),
  };
}

/**
 * Order channels the way a client renders them: uncategorised channels first,
 * then each category followed by its children (both sorted by position).
 */
function sortChannels(channels) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const children = new Map();
  const roots = [];
  for (const channel of channels) {
    if (channel.type === 4 || !channel.parent_id || !byId.has(channel.parent_id)) {
      if (channel.type === 4) {
        if (!children.has(channel.id)) children.set(channel.id, []);
        roots.push(channel);
      } else if (!channel.parent_id || !byId.has(channel.parent_id)) {
        roots.push(channel);
      }
    } else {
      if (!children.has(channel.parent_id)) children.set(channel.parent_id, []);
      children.get(channel.parent_id).push(channel);
    }
  }
  roots.sort((a, b) => (a.type === 4 ? 1 : 0) - (b.type === 4 ? 1 : 0) || a.position - b.position || a.id - b.id);

  const out = [];
  for (const root of roots) {
    out.push(root);
    const kids = (children.get(root.id) || []).sort((a, b) => a.position - b.position || a.id - b.id);
    out.push(...kids);
  }
  return out;
}

function serializeMemberRow(guildId, row) {
  return {
    guild_id: String(guildId),
    user_id: String(row.user_id),
    nickname: row.nickname,
    joined_at: row.joined_at,
    roles: JSON.parse(row.role_ids || '[]').map(String),
    timeout_until: row.timeout_until || null,
    muted: !!row.muted,
    deafened: !!row.deafened,
    pending: !!row.pending,
  };
}

function membersPayload(guildId, { limit = 0 } = {}) {
  const rows = db.all(
    `SELECT m.*, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.bio,
            u.accent_color, u.is_bot, u.created_at AS user_created_at, u.last_seen
     FROM guild_members m JOIN users u ON u.id = m.user_id
     WHERE m.guild_id = ?
     ORDER BY m.joined_at ASC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`, [guildId]);

  const online = new Set(db.all(
    `SELECT user_id FROM voice_states WHERE guild_id = ?`, [guildId]).map((r) => String(r.user_id)));

  return rows.map((row) => {
    const member = serializeMemberRow(guildId, row);
    return {
      ...member,
      roles: JSON.parse(row.role_ids || '[]').map(String),
      user: {
        id: String(row.user_id),
        username: row.username,
        discriminator: row.discriminator,
        display_name: row.display_name || row.username,
        avatar: row.avatar,
        banner: row.banner,
        bio: row.bio || '',
        accent_color: row.accent_color ? Number(row.accent_color) : null,
        bot: !!row.is_bot,
        created_at: row.user_created_at,
      },
      in_voice: online.has(String(row.user_id)),
    };
  });
}

function voiceStatesPayload(guildId) {
  return db.all('SELECT * FROM voice_states WHERE guild_id = ?', [guildId]).map((v) => ({
    user_id: String(v.user_id),
    guild_id: String(v.guild_id),
    channel_id: String(v.channel_id),
    session_id: v.session_id,
    self_mute: !!v.self_mute,
    self_deaf: !!v.self_deaf,
    self_video: !!v.self_video,
    self_stream: !!v.self_stream,
    server_mute: !!v.server_mute,
    server_deaf: !!v.server_deaf,
    suppress: !!v.suppress,
    joined_at: v.joined_at,
  }));
}

/** Channel with its permission overwrites laid out for the channel editor. */
function channelEditorPayload(channel) {
  const rows = db.all('SELECT * FROM permission_overwrites WHERE channel_id = ?', [channel.id]);
  return serialize.serializeChannel(channel, {
    permission_overwrites: rows.map((r) => ({
      id: String(r.target_id),
      type: r.target_type === 'role' ? 0 : 1,
      allow: r.allow,
      deny: r.deny,
    })),
  });
}

module.exports = { guildPayload, membersPayload, voiceStatesPayload, channelEditorPayload, serializeMemberRow, sortChannels };
