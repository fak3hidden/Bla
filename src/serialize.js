'use strict';
const db = require('./db');
const { publicUser } = require('./auth');
const { toNumberString, toBigInt, EVERYONE_DEFAULT } = require('./permissions');

const CHANNEL_TYPES = {
  TEXT: 0, DM: 1, VOICE: 2, GROUP_DM: 3, CATEGORY: 4, ANNOUNCEMENT: 5, STAGE: 13, FORUM: 15,
};

function userBrief(row) {
  if (!row) {
    return { id: '0', username: 'Deleted User', discriminator: '0000', display_name: 'Deleted User', avatar: null, bot: false, deleted: true };
  }
  return {
    id: String(row.id),
    username: row.username,
    discriminator: row.discriminator,
    display_name: row.display_name || row.username,
    avatar: row.avatar ?? null,
    banner: row.banner ?? null,
    accent_color: row.accent_color ? Number(row.accent_color) : null,
    bot: !!row.is_bot,
    system: !!row.is_system,
    bio: row.bio || '',
    pronouns: row.pronouns || '',
  };
}

function serializeUser(row, extra = {}) {
  return { ...publicUser(row), ...extra };
}

function serializeRole(row, memberCount = null) {
  return {
    id: String(row.id),
    name: row.name,
    color: Number(row.color) || 0,
    icon: row.icon || null,
    unicode_emoji: row.unicode_emoji || null,
    position: row.position,
    permissions: toNumberString(row.permissions),
    hoist: !!row.hoist,
    mentionable: !!row.mentionable,
    managed: !!row.managed,
    is_everyone: !!row.is_everyone,
    ...(memberCount === null ? {} : { member_count: memberCount }),
  };
}

function serializeChannel(row, extra = {}) {
  return {
    id: String(row.id),
    type: row.type,
    guild_id: row.guild_id ? String(row.guild_id) : null,
    name: row.name,
    topic: row.topic || '',
    position: row.position,
    parent_id: row.parent_id ? String(row.parent_id) : null,
    nsfw: !!row.nsfw,
    rate_limit_per_user: row.slowmode || 0,
    user_limit: row.user_limit || 0,
    bitrate: row.bitrate || 384000,
    last_message_id: row.last_message_id ? String(row.last_message_id) : null,
    owner_id: row.owner_id ? String(row.owner_id) : null,
    icon: row.icon || null,
    created_at: row.created_at,
    ...extra,
  };
}

function serializeAttachment(row) {
  return {
    id: String(row.id),
    filename: row.filename,
    content_type: row.content_type,
    size: row.size,
    width: row.width,
    height: row.height,
    description: row.description || null,
    url: `/api/attachments/${row.id}/${encodeURIComponent(row.filename)}`,
    proxy_url: `/api/attachments/${row.id}/${encodeURIComponent(row.filename)}`,
    voice_message: !!row.voice_message,
    duration: row.duration,
    waveform: row.waveform ? safeJson(row.waveform, null) : null,
  };
}

function serializeEmoji(row) {
  return {
    id: String(row.id),
    name: row.name,
    animated: !!row.animated,
    guild_id: String(row.guild_id),
    url: row.image,
    available: !!row.available,
  };
}

function serializeSticker(row) {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description || '',
    tags: row.tags || '',
    format_type: row.format,
    guild_id: String(row.guild_id),
    url: row.image,
  };
}

function serializeSound(row) {
  return {
    id: String(row.id),
    name: row.name,
    volume: row.volume,
    emoji: row.emoji || null,
    guild_id: String(row.guild_id),
    url: row.file,
  };
}

function reactionsFor(messageIds) {
  if (!messageIds.length) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db.all(
    `SELECT r.message_id, r.emoji, r.user_id, u.username, u.display_name, u.avatar
     FROM reactions r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.message_id IN (${placeholders})
     ORDER BY r.created_at ASC`, messageIds);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.message_id)) map.set(row.message_id, new Map());
    const byEmoji = map.get(row.message_id);
    if (!byEmoji.has(row.emoji)) byEmoji.set(row.emoji, { emoji: row.emoji, count: 0, users: [], me: false });
    const entry = byEmoji.get(row.emoji);
    entry.count += 1;
    entry.users.push({
      id: String(row.user_id), username: row.username,
      display_name: row.display_name || row.username, avatar: row.avatar,
    });
  }
  return map;
}

function attachmentsFor(messageIds) {
  if (!messageIds.length) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db.all(`SELECT * FROM attachments WHERE message_id IN (${placeholders}) AND orphaned = 0 ORDER BY id ASC`, messageIds);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.message_id)) map.set(row.message_id, []);
    map.get(row.message_id).push(serializeAttachment(row));
  }
  return map;
}

function serializeMessage(row, { currentUserId = null, reactions = null, attachments = null, guildId = null } = {}) {
  const interaction = safeJson(row.interaction, null);
  const webhookOverride = interaction && interaction.webhook ? interaction.webhook : null;
  const msg = {
    id: String(row.id),
    channel_id: String(row.channel_id),
    guild_id: row.guild_id ? String(row.guild_id) : null,
    author: row.webhook_id
      ? {
        id: `webhook-${row.webhook_id}`,
        username: webhookOverride?.name || row.webhook_name || 'Webhook',
        display_name: webhookOverride?.name || row.webhook_name || 'Webhook',
        discriminator: '0000',
        avatar: webhookOverride?.avatar ?? row.webhook_avatar ?? null,
        bot: true,
        webhook: true,
      }
      : (row.author_id ? userBrief({
        id: row.author_id,
        username: row.author_username,
        discriminator: row.author_discriminator,
        display_name: row.author_display_name,
        avatar: row.author_avatar,
        is_bot: row.author_is_bot,
      }) : userBrief(null)),
    content: row.content || '',
    timestamp: row.created_at,
    edited_timestamp: row.edited_at || null,
    type: row.type,
    system: !!row.system,
    pinned: !!row.pinned,
    tts: !!row.tts,
    mention_everyone: !!row.mention_everyone,
    mentions: safeJson(row.mentions, []),
    mention_roles: safeJson(row.mention_roles, []).map(String),
    embeds: safeJson(row.embeds, []),
    attachments: attachments ?? [],
    reactions: (reactions ?? []).map((r) => ({ ...r, me: currentUserId ? r.users.some((u) => String(u.id) === String(currentUserId)) : false })),
    reference: row.reference_id ? { message_id: String(row.reference_id) } : null,
    nonce: row.nonce || null,
    webhook_id: row.webhook_id ? String(row.webhook_id) : null,
    interaction,
    poll: null,
  };
  return msg;
}

const MESSAGE_SELECT = `
  SELECT m.*, u.username AS author_username, u.discriminator AS author_discriminator,
         u.display_name AS author_display_name, u.avatar AS author_avatar, u.is_bot AS author_is_bot,
         w.name AS webhook_name, w.avatar AS webhook_avatar
  FROM messages m
  LEFT JOIN users u ON u.id = m.author_id
  LEFT JOIN webhooks w ON w.id = m.webhook_id
  WHERE m.deleted_at IS NULL`;

/** Fetch messages by id list, hydrated with reactions/attachments/polls. */
function hydrateMessages(rows, { currentUserId = null } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const reactionMap = reactionsFor(ids);
  const attachmentMap = attachmentsFor(ids);
  const pollMap = pollsFor(ids);
  return rows.map((row) => {
    const byEmoji = reactionMap.get(row.id);
    const msg = serializeMessage(row, {
      currentUserId,
      reactions: byEmoji ? [...byEmoji.values()] : [],
      attachments: attachmentMap.get(row.id) || [],
    });
    msg.poll = pollMap.get(row.id) || null;
    return msg;
  });
}

/** Polls are keyed by the id of the message that carries them. */
function pollsFor(messageIds) {
  const map = new Map();
  if (!messageIds.length) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const polls = db.all(`SELECT * FROM polls WHERE id IN (${placeholders})`, messageIds);
  for (const poll of polls) {
    map.set(poll.id, serializePoll(poll));
  }
  return map;
}

function serializePoll(poll, currentUserId = null) {
  const answers = safeJson(poll.answers, []);
  const votes = db.all('SELECT answer_id, user_id FROM poll_votes WHERE poll_id = ?', [poll.id]);
  const counts = new Map();
  for (const v of votes) counts.set(v.answer_id, (counts.get(v.answer_id) || 0) + 1);
  const totalVotes = votes.length;
  return {
    id: String(poll.id),
    question: poll.question,
    allow_multiselect: !!poll.multi,
    expires_at: poll.expires_at,
    ended: !!poll.ended || (poll.expires_at ? poll.expires_at < Date.now() : false),
    total_votes: totalVotes,
    answers: answers.map((a) => ({
      id: a.id,
      text: a.text,
      emoji: a.emoji || null,
      votes: counts.get(a.id) || 0,
      me_voted: currentUserId ? votes.some((v) => v.answer_id === a.id && String(v.user_id) === String(currentUserId)) : false,
    })),
  };
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function memberCount(guildId) {
  const row = db.get('SELECT COUNT(*) AS c FROM guild_members WHERE guild_id = ?', [guildId]);
  return row ? row.c : 0;
}

function serializeGuild(row, extra = {}) {
  return {
    id: String(row.id),
    name: row.name,
    icon: row.icon || null,
    banner: row.banner || null,
    splash: row.splash || null,
    description: row.description || '',
    owner_id: String(row.owner_id),
    created_at: row.created_at,
    boost_level: 3,
    boost_tier_name: 'Perks unlocked for everyone',
    vanity_url: row.vanity_url || null,
    tags: safeJson(row.tags, []),
    locale: row.locale || 'en-US',
    approximate_member_count: memberCount(row.id),
    verification_level: row.verification_level,
    explicit_content_filter: row.explicit_content_filter,
    default_notifications: row.default_notifications,
    afk_timeout: row.afk_timeout,
    discovery: !!row.discovery,
    features: ['ALL_BOOST_PERKS_FREE', 'ANIMATED_ICON', 'BANNER', 'COMMUNITY', 'VANITY_URL', 'INVITE_SPLASH'],
    ...extra,
  };
}

module.exports = {
  CHANNEL_TYPES, userBrief, serializeUser, serializeRole, serializeChannel, serializeGuild,
  serializeMessage, serializeAttachment, serializeEmoji, serializeSticker, serializeSound,
  serializePoll, hydrateMessages, reactionsFor, attachmentsFor, safeJson, memberCount, MESSAGE_SELECT,
  toBigInt, EVERYONE_DEFAULT,
};
