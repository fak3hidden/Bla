'use strict';
const config = require('./config');
const db = require('./db');

/**
 * Runtime-editable instance settings. Environment variables provide the
 * defaults; whatever an admin changes in the UI is stored in the database so
 * it survives restarts.
 */
const OVERRIDABLE = {
  server_name: { type: 'string', default: () => config.serverName, label: 'Instance name' },
  registration_open: { type: 'boolean', default: () => config.registrationOpen, label: 'Open sign-ups' },
  invite_only: { type: 'boolean', default: () => config.inviteOnly, label: 'Require an invite to sign up' },
  max_upload_mb: { type: 'number', default: () => Math.round(config.maxUploadBytes / 1048576), label: 'Max upload size (MB)' },
  max_guilds_per_user: { type: 'number', default: () => config.maxGuildsPerUser, label: 'Max servers per account' },
  welcome_message: { type: 'string', default: () => '', label: 'Message shown on the login screen' },
  motd: { type: 'string', default: () => '', label: 'Message of the day' },
};

function get(key) {
  const spec = OVERRIDABLE[key];
  if (!spec) return undefined;
  const stored = db.getMeta(`setting.${key}`);
  if (stored === null) return spec.default();
  if (spec.type === 'boolean') return stored === 'true' || stored === '1';
  if (spec.type === 'number') {
    const n = Number(stored);
    return Number.isFinite(n) ? n : spec.default();
  }
  return stored;
}

function set(key, value) {
  const spec = OVERRIDABLE[key];
  if (!spec) {
    const err = new Error(`Unknown setting "${key}".`);
    err.status = 400;
    err.code = 'UNKNOWN_SETTING';
    throw err;
  }
  let normalized = value;
  if (spec.type === 'boolean') normalized = value ? 'true' : 'false';
  if (spec.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error(`"${key}" must be a positive number.`);
      err.status = 400;
      err.code = 'INVALID_SETTING';
      throw err;
    }
    normalized = String(Math.trunc(n));
  }
  if (spec.type === 'string') normalized = String(value ?? '').slice(0, 500);
  db.setMeta(`setting.${key}`, normalized);
  return get(key);
}

function all() {
  const out = {};
  for (const key of Object.keys(OVERRIDABLE)) out[key] = get(key);
  return out;
}

module.exports = { get, set, all, OVERRIDABLE };
