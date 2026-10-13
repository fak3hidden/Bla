'use strict';
/**
 * Bla browser-level test.
 *
 *   npm run test:ui
 *
 * Boots a throwaway server, seeds a small server with a channel, a message and a
 * poll, then renders the real client in jsdom against it: login form, guild rail,
 * channel list, message list, composer, polls, settings modals, discovery, friends.
 *
 * The point is to catch integration bugs the REST smoke test cannot see — bad
 * script order, wrong API paths, selectors that no longer exist.
 *
 * Requires the optional dev dependency `jsdom`. If it is not installed the test
 * prints a note and exits successfully, so `npm test` never depends on it.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

let JSDOM = null;
let VirtualConsole = null;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.log('\njsdom is not installed — skipping the UI test.');
  console.log('Install it with:  npm install   (it is listed in devDependencies)\n');
  process.exit(0);
}

const PORT = 3800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bla-ui-'));

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── seeding helpers (plain HTTP, separate from the browser session) ── */

function makeClient() {
  const jar = new Map();
  return {
    async request(method, url, body) {
      const headers = {};
      if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body) headers['content-type'] = 'application/json';
      const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      for (const cookie of res.headers.getSetCookie?.() || []) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        if (pair.slice(index + 1) === '') jar.delete(pair.slice(0, index));
        else jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      const type = res.headers.get('content-type') || '';
      return { status: res.status, data: type.includes('json') ? await res.json().catch(() => null) : await res.text() };
    },
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body); },
    put(url, body) { return this.request('PUT', url, body); },
    patch(url, body) { return this.request('PATCH', url, body); },
  };
}

async function seed() {
  const alice = makeClient();
  await alice.post('/api/auth/register', { username: 'alice', password: 'hunter2hunter2', display_name: 'Alice' });
  const guild = (await alice.post('/api/guilds', { name: 'Game Night' })).data.guild;
  const general = (await alice.post(`/api/guilds/${guild.id}/channels`, { name: 'general', type: 0 })).data.channel;
  await alice.post(`/api/guilds/${guild.id}/channels`, { name: 'Lounge', type: 2 });
  await alice.post(`/api/channels/${general.id}/messages`, { content: 'welcome to **Bla** — have a look around' });
  await alice.post(`/api/channels/${general.id}/messages`, {
    content: '',
    poll: { question: 'Ship it?', answers: [{ text: 'Yes' }, { text: 'Obviously' }], duration: 3600 },
  });
  const invite = (await alice.post(`/api/guilds/${guild.id}/invites`, { channel_id: general.id, max_age: 0 })).data.code;
  return { guild, general, invite };
}

/* ── the browser session ─────────────────────────────────────────────── */

function installBrowserApis(window) {
  window.fetch = (url, opts = {}) => fetch(url.startsWith('http') ? url : `${BASE}${url}`, opts);

  // Browser-shaped WebSocket over `ws`, so public/js/gateway.js runs unchanged.
  window.WebSocket = class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      const WS = require('ws');
      this.inner = new WS(url);
      this.readyState = 0;
      this.listeners = {};
      this.inner.on('open', () => { this.readyState = 1; this.emit('open', {}); });
      this.inner.on('message', (raw) => this.emit('message', { data: raw.toString() }));
      this.inner.on('close', () => { this.readyState = 3; this.emit('close', {}); });
      this.inner.on('error', (err) => this.emit('error', err));
    }
    emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    send(data) { if (this.readyState === 1) this.inner.send(data); }
    close() { try { this.inner.close(); } catch { /* ignore */ } this.readyState = 3; }
  };

  window.Notification = class { static permission = 'denied'; static requestPermission = async () => 'denied'; };
  window.navigator.mediaDevices = {
    enumerateDevices: async () => [],
    getUserMedia: async () => { throw new Error('no microphone in the test environment'); },
  };
  window.RTCPeerConnection = class {
    constructor() { this.signalingState = 'stable'; }
    addTrack() {} close() {} getSenders() { return []; }
  };
  window.HTMLMediaElement.prototype.play = async () => {};
  window.Element.prototype.scrollIntoView = () => {};
}

async function main() {
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BLA_PORT: String(PORT),
      BLA_HOST: '127.0.0.1',
      BLA_DATA_DIR: dataDir,
      BLA_DB: path.join(dataDir, 'ui.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  const shutdown = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
  process.on('exit', shutdown);

  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch { /* not yet */ }
    await sleep(150);
  }
  if (!ready) {
    console.error('server did not start\n', serverLog);
    shutdown();
    process.exit(1);
  }

  const { general, invite } = await seed();
  console.log(`\nseeded a throwaway instance on port ${PORT}`);

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e.message));
  virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`));

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const doc = window.document;
  installBrowserApis(window);

  const scripts = ['util', 'state', 'api', 'gateway', 'render', 'markdown', 'modals', 'voice', 'chat', 'settings', 'app'];
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(e.error?.stack || e.message));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason?.stack || e.reason)));

  try {
    console.log('\n\x1b[1mClient boot\x1b[0m');
    for (const name of scripts) {
      try {
        window.eval(fs.readFileSync(path.join(ROOT, 'public', 'js', `${name}.js`), 'utf8'));
      } catch (err) {
        errors.push(`script ${name} failed to evaluate: ${err.message}`);
      }
    }
    ok('every client script evaluates', errors.length === 0, errors.slice(0, 3).join('\n      '));
    for (const global of ['Bla', 'BlaState', 'BlaApi', 'BlaGateway', 'BlaRender', 'BlaMarkdown', 'BlaModals', 'BlaChat', 'BlaVoice', 'BlaSettings', 'BlaApp']) {
      ok(`${global} is exported`, typeof window[global] === 'object' || typeof window[global] === 'function');
    }

    window.eval('BlaApp.boot()');
    await sleep(1200);

    console.log('\n\x1b[1mAuth screen\x1b[0m');
    ok('login screen is visible to strangers', !doc.getElementById('auth-screen').hidden);
    ok('server name is shown', (doc.getElementById('auth-server-name')?.textContent || '').trim().length > 0);

    // Register a brand-new account through the form itself (no email field anywhere).
    doc.getElementById('auth-switch').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(150);
    ok('signup mode reveals the password confirmation', !doc.getElementById('auth-confirm-row').hidden);
    doc.getElementById('auth-username').value = 'carol';
    doc.getElementById('auth-password').value = 'hunter2hunter2';
    doc.getElementById('auth-confirm').value = 'hunter2hunter2';
    doc.getElementById('auth-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(2500);

    // Join the seeded server by pasting the invite link into the address bar equivalent.
    window.eval(`location.hash = '#/invite/${invite}'`);
    window.dispatchEvent(new window.Event('hashchange'));
    await sleep(1200);
    ok('invite link renders a preview', !!doc.querySelector('.guild-card .btn-primary'));
    doc.querySelector('.guild-card .btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(1500);

    console.log('\n\x1b[1mShell\x1b[0m');
    ok('app shell becomes visible after login', !doc.getElementById('app').hidden);
    ok('guild rail lists the server', doc.querySelectorAll('#guild-rail .rail-item').length >= 2);
    ok('sidebar header shows the server name', (doc.getElementById('sidebar-header')?.textContent || '').includes('Game Night'));
    ok('the invite joined a brand-new account to the server', window.eval('BlaState.state.guilds.size') === 1);
    ok('channel list renders channels', doc.querySelectorAll('.channel-item').length >= 2);
    ok('user panel renders the account', doc.querySelectorAll('#user-panel, .user-panel').length >= 1);

    const guildId = window.eval('[...BlaState.state.guilds.keys()][0]');
    window.eval(`BlaApp.openGuild("${guildId}"); BlaApp.openChannel("${general.id}", "${guildId}");`);
    await sleep(1500);

    console.log('\n\x1b[1mMessages\x1b[0m');
    const rendered = doc.querySelectorAll('.msg').length;
    ok('messages render in the channel', rendered >= 2, `rendered=${rendered}`);
    ok('markdown is turned into elements', !!doc.querySelector('.msg-text strong, .msg-text b, .msg-text em'));
    ok('polls render with their answers', !!doc.querySelector('[data-poll-id]'), 'no [data-poll-id] found');
    ok('composer is present', !!doc.querySelector('.composer textarea'));
    ok('composer has a send button', !!doc.querySelector('.composer .btn-primary'));

    const textarea = doc.querySelector('.composer textarea');
    textarea.value = 'sent from the ui test';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.querySelector('.composer .btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(1500);
    const texts = [...doc.querySelectorAll('.msg-text')].map((n) => n.textContent);
    ok('sending a message echoes it over the gateway', texts.some((t) => t.includes('sent from the ui test')));

    console.log('\n\x1b[1mRealtime & navigation\x1b[0m');
    ok('gateway reports a live socket', window.eval('BlaGateway.isConnected') === true);

    window.eval(`BlaApp.openHome('friends')`);
    await sleep(700);
    ok('friends view renders its tabs', doc.querySelectorAll('.discovery-wrap .tab-row button').length >= 4);

    window.eval('BlaApp.openDiscovery()');
    await sleep(900);
    ok('discovery view renders', doc.querySelectorAll('.discovery-wrap').length >= 1);

    window.eval(`BlaApp.openChannel("${general.id}", "${guildId}")`);
    await sleep(600);

    console.log('\n\x1b[1mModals & menus\x1b[0m');
    window.eval('BlaSettings.openUser("profile")');
    await sleep(400);
    ok('user settings modal opens', !!doc.querySelector('.settings-layout'));
    ok('user settings has tabs', doc.querySelectorAll('.settings-nav button').length >= 5);
    window.eval('BlaModals.openModal("x")');
    window.eval('document.getElementById("modal-root").innerHTML=""; document.getElementById("modal-root").classList.remove("open")');

    window.eval(`BlaSettings.openGuild("${guildId}")`);
    await sleep(700);
    ok('server settings modal opens with every tab', doc.querySelectorAll('.settings-nav button').length >= 10);
    window.eval('document.getElementById("modal-root").innerHTML=""; document.getElementById("modal-root").classList.remove("open")');

    window.eval('Bla.showMenu({clientX: 20, clientY: 20, preventDefault(){}, stopPropagation(){}}, [{label:"Item", icon:"copy", action(){}}])');
    await sleep(200);
    ok('context menus open', !!doc.querySelector('.menu .menu-item'));
    window.eval('Bla.closeMenu()');

    window.eval('BlaModals.emojiPicker({clientX: 20, clientY: 20, preventDefault(){}, stopPropagation(){}})');
    await sleep(400);
    ok('emoji picker renders categories and tiles',
      doc.querySelectorAll('.emoji-picker .cat-label').length >= 5 && doc.querySelectorAll('.emoji-picker .cats button').length > 100);
    window.eval('Bla.closeMenu()');

    console.log('\n\x1b[1mVoice\x1b[0m');
    window.eval(`BlaVoice.join("${general.id}")`);
    await sleep(500);
    ok('a blocked microphone fails gracefully (no crash, toast shown)', doc.querySelectorAll('.toast').length >= 1);

    window.eval(`Bla.closeMenu(); document.getElementById("modal-root").innerHTML="";`);
    ok('no uncaught client errors along the way', window.__errors.length === 0, window.__errors.slice(0, 4).join('\n      '));
  } catch (err) {
    failed += 1;
    failures.push(err.message);
    console.error(`\n\x1b[31mUI run crashed:\x1b[0m ${err.stack}`);
  }

  shutdown();
  await sleep(250);

  console.log(`\n${'─'.repeat(56)}`);
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1mAll ${passed} UI checks passed.\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed} of ${passed + failed} UI checks failed:\x1b[0m`);
    for (const name of failures) console.log(`  · ${name}`);
    console.log('\nServer log tail:\n' + serverLog.split('\n').slice(-20).join('\n'));
  }
  console.log(`${'─'.repeat(56)}\n`);

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
