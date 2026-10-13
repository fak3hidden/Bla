'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// Packaged binaries (npm run build): data lives next to the executable, since
// that is the "installation folder" the user chose. A source checkout uses the
// repository root. BLA_ROOT overrides both.
function baseRoot() {
  try {
    // node:sea exists in every Node 20+ runtime; isSea() is only true when
    // this code was launched from a single-executable binary.
    if (require('node:sea').isSea()) return path.dirname(process.execPath);
  } catch { /* source checkout */ }
  return path.resolve(__dirname, '..');
}
const ROOT = path.resolve(env('BLA_ROOT', baseRoot()));

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

const dataDir = path.resolve(env('BLA_DATA_DIR', path.join(ROOT, 'data')));

/** Version string: env override, the packaged value, or package.json. */
function readVersion() {
  if (process.env.BLA_VERSION) return String(process.env.BLA_VERSION);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.version) return String(pkg.version);
  } catch { /* thrown away builds have no package.json */ }
  return '1.0.0';
}

const config = {
  root: ROOT,
  version: readVersion(),
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  uploadDir: path.join(dataDir, 'uploads'),
  dbFile: path.resolve(env('BLA_DB', path.join(dataDir, 'bla.db'))),

  host: env('BLA_HOST', '0.0.0.0'),
  port: num('BLA_PORT', 3000),
  trustProxy: bool('BLA_TRUST_PROXY', false),

  // Public origin used for absolute URLs (invites, webhooks). Empty = infer from request.
  publicUrl: env('BLA_PUBLIC_URL', '').replace(/\/+$/, ''),

  registrationOpen: bool('BLA_REGISTRATION_OPEN', true),
  inviteOnly: bool('BLA_INVITE_ONLY', false),
  serverName: env('BLA_SERVER_NAME', 'Bla'),

  // Free-perks: everything Discord locks behind Nitro/boosts is simply on for everyone.
  maxUploadBytes: num('BLA_MAX_UPLOAD_MB', 100) * 1024 * 1024,
  maxAvatarBytes: num('BLA_MAX_AVATAR_MB', 8) * 1024 * 1024,
  maxEmojiBytes: 512 * 1024,
  voiceBitrate: num('BLA_VOICE_BITRATE', 384000),
  maxEmojiPerGuild: num('BLA_MAX_EMOJI', 500),
  maxStickerPerGuild: num('BLA_MAX_STICKERS', 120),
  maxRolesPerGuild: 500,
  maxChannelsPerGuild: 1000,
  maxGuildsPerUser: num('BLA_MAX_GUILDS_PER_USER', 200),
  maxUsers: num('BLA_MAX_USERS', 0), // 0 = unlimited
  maxAttachmentCount: 10,
  maxMessageLength: 4000,
  messageRateLimit: { count: num('BLA_MSG_RATE_COUNT', 8), windowMs: 5000, burst: 3 },
  maxReactionsPerMessage: 40,

  stunServers: env('BLA_STUN_URLS', 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean),
  voiceEnabled: bool('BLA_VOICE', true),

  sessionDays: num('BLA_SESSION_DAYS', 30),
  adminUsers: env('BLA_ADMINS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  logLevel: env('BLA_LOG_LEVEL', 'info'),
};

for (const dir of [config.dataDir, config.mediaDir, config.uploadDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

config.listenUrl = `http://${config.host === '0.0.0.0' ? localAddress() : config.host}:${config.port}`;

function localAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

module.exports = config;
