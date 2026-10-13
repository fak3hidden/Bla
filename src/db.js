'use strict';
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { P, EVERYONE_DEFAULT } = require('./permissions');

const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL,
  username_lc       TEXT NOT NULL UNIQUE,
  discriminator     TEXT NOT NULL DEFAULT '0000',
  display_name      TEXT,
  password_hash     TEXT NOT NULL,
  avatar            TEXT,
  banner            TEXT,
  bio               TEXT DEFAULT '',
  accent_color      TEXT,
  pronouns          TEXT DEFAULT '',
  created_at        INTEGER NOT NULL,
  token_version     INTEGER NOT NULL DEFAULT 0,
  is_bot            INTEGER NOT NULL DEFAULT 0,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  is_system         INTEGER NOT NULL DEFAULT 0,
  disabled          INTEGER NOT NULL DEFAULT 0,
  ban_reason        TEXT,
  settings          TEXT NOT NULL DEFAULT '{}',
  last_seen         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_disc ON users(username, discriminator);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS guilds (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT NOT NULL,
  icon                   TEXT,
  banner                 TEXT,
  splash                 TEXT,
  description            TEXT NOT NULL DEFAULT '',
  owner_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at             INTEGER NOT NULL,
  boost_level            INTEGER NOT NULL DEFAULT 3,   -- free perks: everyone is maxed out
  vanity_url             TEXT UNIQUE,
  system_channel_id      INTEGER,
  rules_channel_id       INTEGER,
  afk_channel_id         INTEGER,
  afk_timeout            INTEGER NOT NULL DEFAULT 300,
  verification_level     INTEGER NOT NULL DEFAULT 0,
  explicit_content_filter INTEGER NOT NULL DEFAULT 0,
  default_notifications  INTEGER NOT NULL DEFAULT 0,
  discovery              INTEGER NOT NULL DEFAULT 1,   -- listed in the server directory by default
  tags                   TEXT NOT NULL DEFAULT '[]',
  locale                 TEXT NOT NULL DEFAULT 'en-US'
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id     INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname     TEXT,
  joined_at    INTEGER NOT NULL,
  role_ids     TEXT NOT NULL DEFAULT '[]',
  timeout_until INTEGER,
  muted        INTEGER NOT NULL DEFAULT 0,
  deafened     INTEGER NOT NULL DEFAULT 0,
  pending      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON guild_members(user_id);

CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       INTEGER NOT NULL DEFAULT 0,
  icon        TEXT,
  unicode_emoji TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '0',
  hoist       INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  managed     INTEGER NOT NULL DEFAULT 0,
  is_everyone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_roles_guild ON roles(guild_id);

CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  name        TEXT,
  topic       TEXT DEFAULT '',
  type        INTEGER NOT NULL DEFAULT 0,  -- 0 text, 1 dm, 2 voice, 3 group dm, 4 category, 13 stage, 15 forum
  position    INTEGER NOT NULL DEFAULT 0,
  nsfw        INTEGER NOT NULL DEFAULT 0,
  slowmode    INTEGER NOT NULL DEFAULT 0,
  user_limit  INTEGER NOT NULL DEFAULT 0,
  bitrate     INTEGER NOT NULL DEFAULT 384000,
  last_message_id INTEGER,
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  icon        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(owner_id);

CREATE TABLE IF NOT EXISTS dm_recipients (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dmrec_user ON dm_recipients(user_id);

CREATE TABLE IF NOT EXISTS permission_overwrites (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','member')),
  allow       TEXT NOT NULL DEFAULT '0',
  deny        TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (channel_id, target_id, target_type)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id      INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  webhook_id    INTEGER,
  content       TEXT NOT NULL DEFAULT '',
  type          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  edited_at     INTEGER,
  deleted_at    INTEGER,
  reference_id  INTEGER,
  pinned        INTEGER NOT NULL DEFAULT 0,
  tts           INTEGER NOT NULL DEFAULT 0,
  system        INTEGER NOT NULL DEFAULT 0,
  mentions      TEXT NOT NULL DEFAULT '[]',
  mention_roles TEXT NOT NULL DEFAULT '[]',
  mention_everyone INTEGER NOT NULL DEFAULT 0,
  embeds        TEXT NOT NULL DEFAULT '[]',
  interaction   TEXT,
  thread_id     INTEGER,
  nonce         TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename      TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  description   TEXT,
  voice_message INTEGER NOT NULL DEFAULT 0,
  duration      REAL,
  waveform      TEXT,
  created_at    INTEGER NOT NULL,
  orphaned      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  emoji_id   INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  guild_id    INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id  INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  inviter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  max_uses    INTEGER NOT NULL DEFAULT 0,
  max_age     INTEGER NOT NULL DEFAULT 0,
  temporary   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER
);

CREATE TABLE IF NOT EXISTS bans (
  guild_id     INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason       TEXT DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS relationships (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       INTEGER NOT NULL,  -- 1 friend, 2 incoming request, 3 outgoing request, 4 blocked
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);

CREATE TABLE IF NOT EXISTS read_states (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  mention_count   INTEGER NOT NULL DEFAULT 0,
  last_pin_seen   INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS guild_read_states (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  last_viewed INTEGER NOT NULL DEFAULT 0,
  muted       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, guild_id)
);

CREATE TABLE IF NOT EXISTS members_read_states (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  last_viewed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, guild_id)
);

CREATE TABLE IF NOT EXISTS voice_states (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guild_id   INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  self_mute  INTEGER NOT NULL DEFAULT 0,
  self_deaf  INTEGER NOT NULL DEFAULT 0,
  self_video INTEGER NOT NULL DEFAULT 0,
  self_stream INTEGER NOT NULL DEFAULT 0,
  server_mute INTEGER NOT NULL DEFAULT 0,
  server_deaf INTEGER NOT NULL DEFAULT 0,
  suppress   INTEGER NOT NULL DEFAULT 0,
  joined_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_channel ON voice_states(channel_id);

CREATE TABLE IF NOT EXISTS emojis (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  image        TEXT NOT NULL,
  animated     INTEGER NOT NULL DEFAULT 0,
  creator_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  available    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emoji_guild ON emojis(guild_id);

CREATE TABLE IF NOT EXISTS stickers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  tags        TEXT DEFAULT '',
  image       TEXT NOT NULL,
  format      INTEGER NOT NULL DEFAULT 1,
  creator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS soundboard_sounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  file       TEXT NOT NULL,
  volume     REAL NOT NULL DEFAULT 1,
  emoji      TEXT,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  avatar     TEXT,
  token     TEXT NOT NULL UNIQUE,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS polls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id   INTEGER,
  creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  answers    TEXT NOT NULL DEFAULT '[]',
  multi      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  ended      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer_id INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, answer_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_id   INTEGER,
  target_type TEXT,
  reason      TEXT,
  changes     TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_guild ON audit_logs(guild_id, id DESC);

CREATE TABLE IF NOT EXISTS boosts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

db.exec(SCHEMA);

/* ------------------------------------------------------------------ *
 * Tiny query helpers (node:sqlite has no built-in promise/ORM layer)  *
 * ------------------------------------------------------------------ */

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/**
 * Transactions are re-entrant: nested calls join the outer transaction instead
 * of opening a second one (SQLite has no nested BEGIN).
 */
let txDepth = 0;

function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth += 1;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

function insert(table, values) {
  const keys = Object.keys(values);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const res = db.prepare(sql).run(...keys.map((k) => normalize(values[k])));
  return Number(res.lastInsertRowid);
}

function update(table, id, values) {
  const keys = Object.keys(values);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => normalize(values[k])), id);
}

/** node:sqlite only accepts null/number/string/bigint/buffer. */
function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function getMeta(key, fallback = null) {
  const row = get('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]);
}

function isFirstRun() {
  return getMeta('installed_at') === null;
}

function markInstalled() {
  if (isFirstRun()) {
    setMeta('installed_at', Date.now());
    setMeta('schema_version', SCHEMA_VERSION);
  }
}

const SCHEMA_VERSION = 1;

/** Create the @everyone role row for a guild. */
function createEveryoneRole(guildId) {
  const id = insert('roles', {
    guild_id: guildId,
    name: '@everyone',
    color: 0,
    position: 0,
    permissions: EVERYONE_DEFAULT.toString(),
    hoist: 0,
    mentionable: 0,
    is_everyone: 1,
  });
  return id;
}

module.exports = {
  db, all, get, run, tx, insert, update, getMeta, setMeta, isFirstRun, markInstalled,
  createEveryoneRole, SCHEMA_VERSION, DEFAULT_PERMISSIONS: EVERYONE_DEFAULT, P,
};
