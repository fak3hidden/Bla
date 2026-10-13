'use strict';
/**
 * Bla — a self-hosted, Discord-style chat platform.
 *
 * One process serves:
 *   - the REST API            (/api/*)
 *   - the WebSocket gateway   (/gateway)
 *   - the web client          (/)
 *   - uploaded files          (data/uploads)
 *   - the SQLite database     (data/bla.db)
 *
 * No external services, no accounts to sign up for, nothing to pay for.
 */
const http = require('http');
const os = require('os');
const config = require('../src/config');
const { createApp } = require('../src/app');
const gateway = require('../src/gateway');
const db = require('../src/db');
const settings = require('../src/settings');

const app = createApp();
const server = http.createServer(app);

// Attach the realtime gateway and let REST routes push events through it.
const gw = gateway.attach(server);

// Keep the gateway's channel audience caches honest when permissions change.
const bus = require('../src/bus');
bus.invalidateGuild = (guildId) => gw.invalidateGuild(guildId);
bus.invalidateChannel = (channelId) => gw.invalidateChannel(channelId);
bus.sendGuildToUser = (userId, guildId) => gw.sendGuildToUser(userId, guildId);

server.listen(config.port, config.host, () => {
  const addresses = localAddresses();
  const users = db.get('SELECT COUNT(*) AS c FROM users').c;
  const guilds = db.get('SELECT COUNT(*) AS c FROM guilds').c;

  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  Bla is running — your own chat platform');
  console.log(line);
  for (const address of addresses) console.log(`  Local:    http://${address}:${config.port}`);
  console.log(`  Data:     ${config.dataDir}`);
  console.log(`  Database: ${config.dbFile}`);
  console.log(`  Voice:    ${config.voiceEnabled ? 'enabled (WebRTC mesh)' : 'disabled'}`);
  console.log(`  Sign-ups: ${settings.get('registration_open') ? 'open (no email required)' : 'closed'}${settings.get('invite_only') ? ' — invite only' : ''}`);
  console.log(`  Accounts: ${users}    Servers: ${guilds}`);
  if (users === 0) {
    console.log(line);
    console.log('  First run: open the URL above and claim your username.');
    console.log('  The first account created becomes the instance admin.');
  }
  console.log(`${line}\n`);
});

function localAddresses() {
  const out = new Set(['localhost']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.add(info.address);
    }
  }
  return [...out];
}

function shutdown(signal) {
  console.log(`\n[bla] ${signal} received — shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[bla] unhandled rejection', err));
process.on('uncaughtException', (err) => console.error('[bla] uncaught exception', err));

module.exports = { server, app };
