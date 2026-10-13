'use strict';

/**
 * Discord-compatible permission bits, so the numbers feel familiar to anyone
 * coming from a Discord bot/role setup. Every bit here is available to every
 * server owner for free — there is no premium gate anywhere in Bla.
 */
const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_EXPRESSIONS: 1n << 30n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MODERATE_MEMBERS: 1n << 40n,
  CREATE_EVENTS: 1n << 44n,
  MANAGE_EVENTS: 1n << 45n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  USE_SOUNDBOARD: 1n << 42n,
  USE_EXTERNAL_SOUNDS: 1n << 45n,
  SEND_POLLS: 1n << 49n,
  USE_EXTERNAL_APPS: 1n << 50n,
};

/** What a plain member can do in a fresh server (@everyone). */
const EVERYONE_DEFAULT =
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS | P.EMBED_LINKS | P.ATTACH_FILES |
  P.READ_MESSAGE_HISTORY | P.USE_EXTERNAL_EMOJIS | P.CONNECT | P.SPEAK | P.USE_VAD |
  P.STREAM | P.CHANGE_NICKNAME | P.CREATE_INSTANT_INVITE | P.SEND_VOICE_MESSAGES | P.USE_SOUNDBOARD;

/** Granted to the "Moderator" starter role. */
const MODERATOR_DEFAULT =
  P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_MESSAGES | P.MODERATE_MEMBERS |
  P.MUTE_MEMBERS | P.DEAFEN_MEMBERS | P.MOVE_MEMBERS | P.VIEW_AUDIT_LOG | P.PRIORITY_SPEAKER;

const ALL = Object.values(P).reduce((acc, bit) => acc | bit, 0n);
const BIG = P.ADMINISTRATOR;

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  try {
    if (typeof value === 'string') return BigInt(value.trim());
    return BigInt(Math.trunc(Number(value)) || 0);
  } catch {
    return 0n;
  }
}

/**
 * Accept permissions from clients in any of the shapes they naturally send:
 * a bitfield (number/bigint/decimal string), an array of bit values, or an
 * array of permission names such as ['VIEW_CHANNEL', 'SEND_MESSAGES'].
 */
function parsePermissionInput(value) {
  if (value === null || value === undefined || value === '') return 0n;
  if (Array.isArray(value)) {
    let bits = 0n;
    for (const entry of value) {
      if (typeof entry === 'string' && !/^\d+$/.test(entry.trim())) {
        const key = entry.trim().toUpperCase();
        if (Object.prototype.hasOwnProperty.call(P, key)) bits |= P[key];
        continue;
      }
      bits |= toBigInt(entry);
    }
    return bits;
  }
  if (typeof value === 'string' && /[A-Za-z]/.test(value)) {
    let bits = 0n;
    for (const entry of value.split(/[\s,|]+/)) {
      const key = entry.trim().toUpperCase();
      if (Object.prototype.hasOwnProperty.call(P, key)) bits |= P[key];
    }
    return bits;
  }
  return toBigInt(value);
}

function toNumberString(value) {
  return toBigInt(value).toString();
}

function has(bits, permission) {
  const b = toBigInt(bits);
  const p = toBigInt(permission);
  if ((b & BIG) === BIG) return true;
  return (b & p) === p;
}

function hasAny(bits, permission) {
  const b = toBigInt(bits);
  if ((b & BIG) === BIG) return true;
  return (b & toBigInt(permission)) !== 0n;
}

/**
 * Compute the effective channel permissions for a member.
 * Mirrors Discord's algorithm: base everyone role -> member roles -> channel
 * overwrites (@everyone, then roles, then the member specifically).
 * ADMINISTRATOR short-circuits to "everything".
 */
function computeChannelPermissions({ everyonePermissions, rolePermissions = [], memberOverwrite, roleOverwrites = [], everyoneOverwrite }) {
  let base = toBigInt(everyonePermissions);
  for (const rp of rolePermissions) base |= toBigInt(rp);

  if ((base & BIG) === BIG) return ALL;

  const applyOverwrite = (perms, overwrite) => {
    if (!overwrite) return perms;
    const deny = toBigInt(overwrite.deny);
    const allow = toBigInt(overwrite.allow);
    return (perms & ~deny) | allow;
  };

  let perms = base;
  if (everyoneOverwrite) perms = applyOverwrite(perms, everyoneOverwrite);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const ow of roleOverwrites) {
    roleAllow |= toBigInt(ow.allow);
    roleDeny |= toBigInt(ow.deny);
  }
  perms = (perms & ~roleDeny) | roleAllow;

  if (memberOverwrite) perms = applyOverwrite(perms, memberOverwrite);

  return perms;
}

/** Named list for the role editor UI, in the order Discord shows them. */
const PERMISSION_LIST = [
  ['ADMINISTRATOR', 'Administrator', 'Members with this have every permission and bypass all channel locks.'],
  ['VIEW_CHANNEL', 'View Channels', 'See channels in the server.'],
  ['MANAGE_CHANNELS', 'Manage Channels', 'Create, edit and delete channels.'],
  ['MANAGE_GUILD', 'Manage Server', 'Change the server name, icon, description and settings.'],
  ['CREATE_INSTANT_INVITE', 'Create Invite', 'Invite new people to the server.'],
  ['CHANGE_NICKNAME', 'Change Nickname', 'Change your own nickname.'],
  ['MANAGE_NICKNAMES', 'Manage Nicknames', 'Change other members\u2019 nicknames.'],
  ['KICK_MEMBERS', 'Kick Members', 'Remove members from the server.'],
  ['BAN_MEMBERS', 'Ban Members', 'Permanently ban members.'],
  ['MODERATE_MEMBERS', 'Timeout Members', 'Temporarily mute members in text and voice.'],
  ['MANAGE_ROLES', 'Manage Roles', 'Create and assign roles below your own.'],
  ['MANAGE_EXPRESSIONS', 'Manage Emoji & Stickers', 'Add, edit and remove custom emoji and stickers.'],
  ['MANAGE_WEBHOOKS', 'Manage Webhooks', 'Create and edit webhooks.'],
  ['VIEW_AUDIT_LOG', 'View Audit Log', 'See who did what in the server.'],
  ['SEND_MESSAGES', 'Send Messages', 'Post in text channels.'],
  ['SEND_TTS_MESSAGES', 'Send Text-to-Speech Messages', 'Use /tts.'],
  ['MANAGE_MESSAGES', 'Manage Messages', 'Delete and pin anyone\u2019s messages.'],
  ['EMBED_LINKS', 'Embed Links', 'Link previews show up in messages.'],
  ['ATTACH_FILES', 'Attach Files', 'Upload files and images.'],
  ['READ_MESSAGE_HISTORY', 'Read Message History', 'See messages sent before joining.'],
  ['MENTION_EVERYONE', 'Mention @everyone', 'Ping everyone in a channel.'],
  ['ADD_REACTIONS', 'Add Reactions', 'React to messages.'],
  ['USE_EXTERNAL_EMOJIS', 'Use External Emoji', 'Use emoji from other servers.'],
  ['SEND_POLLS', 'Create Polls', 'Post polls.'],
  ['CONNECT', 'Connect', 'Join voice channels.'],
  ['SPEAK', 'Speak', 'Talk in voice channels.'],
  ['STREAM', 'Video & Screen Share', 'Share your camera or screen.'],
  ['USE_VAD', 'Use Voice Activity', 'Talk without push-to-talk.'],
  ['PRIORITY_SPEAKER', 'Priority Speaker', 'Lower everyone else\u2019s volume while you talk.'],
  ['MUTE_MEMBERS', 'Mute Members', 'Server-mute people in voice.'],
  ['DEAFEN_MEMBERS', 'Deafen Members', 'Server-deafen people.'],
  ['MOVE_MEMBERS', 'Move Members', 'Drag people between voice channels.'],
  ['SEND_VOICE_MESSAGES', 'Send Voice Messages', 'Send voice notes.'],
  ['USE_SOUNDBOARD', 'Use Soundboard', 'Play soundboard sounds in voice.'],
];

module.exports = {
  parsePermissionInput,
  P, ALL, EVERYONE_DEFAULT, MODERATOR_DEFAULT, PERMISSION_LIST,
  toBigInt, toNumberString, has, hasAny, computeChannelPermissions,
};
