'use strict';
/**
 * Bla end-to-end smoke test.
 *
 *   npm test
 *
 * Boots a throwaway instance of the server (its own data directory and port),
 * then drives it through the REST API and the realtime gateway the same way a
 * browser would. Nothing in here touches your real data.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bla-test-'));

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

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── tiny HTTP client with its own cookie jar ─────────────────────────── */

function makeClient(label) {
  const jar = new Map();
  return {
    label,
    jar,
    async request(method, url, body, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload;
      if (body instanceof Buffer || typeof body === 'string') {
        payload = body;
        if (!headers['content-type'] && typeof body === 'string') headers['content-type'] = 'application/json';
      } else if (body !== undefined && body !== null) {
        payload = JSON.stringify(body);
        headers['content-type'] = 'application/json';
      }
      const res = await fetch(`${BASE}${url}`, { method, headers, body: payload, redirect: 'manual' });
      for (const cookie of res.headers.getSetCookie?.() || []) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (value === '' ) jar.delete(name); else jar.set(name, value);
      }
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
      return { status: res.status, data, headers: res.headers };
    },
    get(url, options) { return this.request('GET', url, undefined, options); },
    post(url, body, options) { return this.request('POST', url, body, options); },
    patch(url, body, options) { return this.request('PATCH', url, body, options); },
    put(url, body, options) { return this.request('PUT', url, body, options); },
    del(url, options) { return this.request('DELETE', url, undefined, options); },
    cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

/* ── gateway client ───────────────────────────────────────────────────── */

function gatewayClient(client, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`, { headers: { cookie: client.cookieHeader() } });
    const events = [];
    const waiters = [];
    const api = {
      label,
      events,
      ws,
      send(payload) { ws.send(JSON.stringify(payload)); },
      dispatch(type, data) { ws.send(JSON.stringify({ op: 'DISPATCH', type, data })); },
      next(type, timeout = 4000) {
        const hit = events.find((e) => e.type === type);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.indexOf(entry);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`timed out waiting for ${type} as ${label}`));
          }, timeout);
          const entry = (event) => {
            if (event.type !== type) return;
            clearTimeout(timer);
            const i = waiters.indexOf(entry);
            if (i >= 0) waiters.splice(i, 1);
            res(event);
          };
          waiters.push(entry);
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    };
    ws.on('message', (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.op === 'HELLO') { api.send({ op: 'IDENTIFY' }); return; }
      if (payload.op === 'ERROR') { console.error(`  [${label}] gateway error:`, payload.data); }
      const event = { type: payload.op || payload.type, data: payload.data, raw: payload };
      events.push(event);
      for (const waiter of [...waiters]) waiter(event);
    });
    ws.on('error', reject);
    ws.on('open', () => resolve(api));
  });
}

/* ── the actual run ───────────────────────────────────────────────────── */

async function main() {
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BLA_PORT: String(PORT),
      BLA_HOST: '127.0.0.1',
      BLA_DATA_DIR: dataDir,
      BLA_DB: path.join(dataDir, 'test.db'),
      BLA_REGISTRATION_OPEN: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const shutdown = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
  process.on('exit', shutdown);

  // wait for the server to answer
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(150);
  }
  if (!ready) {
    console.error('server did not start\n', serverLog);
    shutdown();
    process.exit(1);
  }

  const alice = makeClient('alice');
  const bob = makeClient('bob');

  try {
    /* ── health & config ─────────────────────────────────────────── */
    section('Health & config');
    const health = await alice.get('/api/health');
    ok('GET /api/health returns ok', health.status === 200 && health.data.status === 'ok');
    const config = await alice.get('/api/auth/config');
    ok('config advertises email-free signup', config.data.registration_open === true && config.data.features?.no_email_required === true);
    ok('config reports every boost perk free', config.data.features?.all_boost_perks_unlocked === true, JSON.stringify(config.data.features || {}).slice(0, 120));
    ok('config advertises unlimited free servers', config.data.features?.unlimited_free_servers === true);
    ok('voice is enabled with ICE servers', config.data.voice_enabled === true && Array.isArray(config.data.stun_servers));

    /* ── accounts: no email anywhere ─────────────────────────────── */
    section('Accounts (free, no email)');
    const aliceReg = await alice.post('/api/auth/register', { username: 'alice', password: 'hunter2hunter2', display_name: 'Alice' });
    ok('register alice', aliceReg.status === 201 || aliceReg.status === 200, JSON.stringify(aliceReg.data).slice(0, 160));
    ok('first account becomes instance admin', aliceReg.data?.user?.admin === true);
    ok('session cookie set', alice.jar.has('bla_session'));
    ok('no email field is ever returned', !JSON.stringify(aliceReg.data).includes('email'));

    const bobReg = await bob.post('/api/auth/register', { username: 'bob', password: 'hunter2hunter2', display_name: 'Bob' });
    ok('register bob', bobReg.status === 201 || bobReg.status === 200);
    ok('second account is not admin', bobReg.data?.user?.admin !== true);

    const dupe = await bob.post('/api/auth/register', { username: 'alice', password: 'hunter2hunter2' });
    ok('duplicate username rejected', dupe.status === 400 || dupe.status === 409);
    const weak = await bob.post('/api/auth/register', { username: 'shorty', password: 'x' });
    ok('weak password rejected', weak.status === 400);

    const me = await alice.get('/api/auth/me');
    ok('GET /api/auth/me works', me.status === 200 && me.data.user.username === 'alice');
    const meAlias = await alice.get('/api/users/@me');
    ok('GET /api/users/@me works too', meAlias.status === 200 && meAlias.data.user.username === 'alice');

    /* ── servers are free, perks unlocked ────────────────────────── */
    section('Servers (free, all perks unlocked)');
    const guildRes = await alice.post('/api/guilds', { name: 'Test Server' });
    ok('create a server without paying anything', guildRes.status === 201 || guildRes.status === 200);
    const guild = guildRes.data.guild;
    ok('server reports boost tier 3', guild.boost_level === 3);
    ok('server features include community perks', (guild.features || []).includes('ANIMATED_ICON') && (guild.features || []).includes('BANNER'));

    const channelRes = await alice.post(`/api/guilds/${guild.id}/channels`, { name: 'general', type: 0 });
    ok('create a text channel', channelRes.status === 201 || channelRes.status === 200);
    const channel = channelRes.data.channel;

    const hiddenRes = await alice.post(`/api/guilds/${guild.id}/channels`, { name: 'secret', type: 0 });
    ok('create a second text channel', hiddenRes.status === 201 || hiddenRes.status === 200);
    const hiddenChannel = hiddenRes.data.channel;

    const voiceRes = await alice.post(`/api/guilds/${guild.id}/channels`, { name: 'Lounge', type: 2 });
    ok('create a voice channel', voiceRes.status === 201 || voiceRes.status === 200);
    const voiceChannel = voiceRes.data.channel;
    ok('voice channel gets the max bitrate for free', voiceChannel.bitrate >= 384000, `bitrate=${voiceChannel.bitrate}`);

    /* ── permission overwrites ───────────────────────────────────── */
    section('Permissions');
    const guildPayload = (await alice.get(`/api/guilds/${guild.id}`)).data.guild;
    const everyoneRole = guildPayload.roles.find((r) => r.is_everyone);
    ok('everyone role exists in the payload', !!everyoneRole);
    const overwrite = await alice.put(
      `/api/guilds/${guild.id}/channels/${hiddenChannel.id}/permissions/${everyoneRole.id}`,
      { type: 'role', deny: ['VIEW_CHANNEL'] });
    ok('set a channel overwrite', overwrite.status === 200 || overwrite.status === 204);

    const inviteRes = await alice.post(`/api/guilds/${guild.id}/invites`, { channel_id: channel.id, max_age: 0, max_uses: 0 });
    ok('create an invite', inviteRes.status === 201 || inviteRes.status === 200);
    const inviteCode = inviteRes.data.code;
    const invitePreview = await bob.get(`/api/invites/${inviteCode}`);
    ok('invite preview works before joining', invitePreview.status === 200 && invitePreview.data.guild?.id === String(guild.id));

    const bobGuildList = await bob.get('/api/guilds');
    ok('bob is not in the server yet', (bobGuildList.data.guilds || []).length === 0);
    const bobJoin = await bob.post(`/api/invites/${inviteCode}`);
    ok('invite accept joins the server', bobJoin.status === 200 && String(bobJoin.data.guild_id) === String(guild.id), JSON.stringify(bobJoin.data).slice(0, 160));
    const bobVisible = await bob.get(`/api/channels/${channel.id}/messages?limit=1`);
    ok('members can read the open channel', bobVisible.status === 200);
    const bobHidden = await bob.get(`/api/channels/${hiddenChannel.id}/messages?limit=1`);
    ok('overwrite hides the locked channel from bob', bobHidden.status === 403 || bobHidden.status === 404, `status=${bobHidden.status}`);
    const bobSeesHidden = (await bob.get(`/api/guilds/${guild.id}`)).data.guild.channels.some((c) => String(c.id) === String(hiddenChannel.id));
    ok('locked channel is absent from bob server list', bobSeesHidden === false);

    const patch = await alice.patch(`/api/guilds/${guild.id}/members/${bobReg.data.user.id}`, { roles: [] });
    ok('owner can edit members', patch.status === 200 || patch.status === 204);

    /* ── messages, search, polls ─────────────────────────────────── */
    section('Messages');
    const welcome = await alice.post(`/api/channels/${channel.id}/messages`, { content: 'hello world' });
    ok('send a message', welcome.status === 201 || welcome.status === 200);
    const messageId = welcome.data.message.id;

    const mention = await alice.post(`/api/channels/${channel.id}/messages`, { content: `hi <@${bobReg.data.user.id}>` });
    ok('mentions are parsed', (mention.data.message.mentions || []).length === 1);

    // Regression: @everyone from someone without MENTION_EVERYONE used to throw
    // (assignment to a const), and the wrapper used to swallow the flag entirely.
    const ping = await bob.post(`/api/channels/${channel.id}/messages`, { content: 'hey @everyone' });
    ok('a member without MENTION_EVERYONE can still post @everyone', ping.status === 201 || ping.status === 200);
    ok('...but the ping is silently downgraded', ping.data.message?.mention_everyone === false);
    const adminPing = await alice.post(`/api/channels/${channel.id}/messages`, { content: 'ok @everyone' });
    ok('the owner can actually ping everyone', adminPing.data.message?.mention_everyone === true);

    const edited = await alice.patch(`/api/messages/${messageId}`, { content: 'hello edited world' });
    ok('edit a message', edited.data.message?.content === 'hello edited world' || edited.status === 200);

    const reaction = await bob.put(`/api/messages/${messageId}/reactions/%F0%9F%91%8D/@me`);
    ok('add a reaction', reaction.status === 200 || reaction.status === 204);

    const pins = await alice.get(`/api/channels/${channel.id}/pins`);
    ok('pins endpoint works', pins.status === 200 && Array.isArray(pins.data.pins));

    const search = await alice.get(`/api/guilds/${guild.id}/messages/search?q=edited`);
    ok('server message search finds the message', search.status === 200 && search.data.total >= 1, JSON.stringify(search.data).slice(0, 140));
    const searchMiss = await alice.get(`/api/guilds/${guild.id}/messages/search?q=zzzznothing`);
    ok('search does not invent results', searchMiss.data.total === 0);
    await alice.post(`/api/channels/${hiddenChannel.id}/messages`, { content: 'topsecret banana' });
    const searchVisible = await bob.get(`/api/guilds/${guild.id}/messages/search?q=edited`);
    ok('search finds messages in channels bob can see', searchVisible.data.total >= 1);
    const searchHidden = await bob.get(`/api/guilds/${guild.id}/messages/search?q=topsecret`);
    ok('search never leaks hidden channels', searchHidden.data.total === 0, JSON.stringify(searchHidden.data).slice(0, 140));
    const searchHiddenOwner = await alice.get(`/api/guilds/${guild.id}/messages/search?q=topsecret`);
    ok('the owner still finds hidden-channel messages', searchHiddenOwner.data.total === 1);

    const poll = await alice.post(`/api/channels/${channel.id}/messages`, {
      content: '', poll: { question: 'Ship it?', answers: [{ text: 'Yes' }, { text: 'No' }], duration: 3600 },
    });
    ok('create a poll with no text', poll.status === 201 || poll.status === 200, JSON.stringify(poll.data).slice(0, 160));
    const pollMessage = poll.data.message;
    ok('poll comes back with answers', pollMessage?.poll?.answers?.length === 2);
    const vote = await bob.post(`/api/messages/${pollMessage.id}/poll/vote`, { answer_ids: [pollMessage.poll.answers[0].id] });
    ok('vote on a poll', vote.status === 200 && vote.data.poll.answers[0].votes === 1, JSON.stringify(vote.data).slice(0, 160));
    const unvote = await bob.post(`/api/messages/${pollMessage.id}/poll/vote`, { answer_ids: [pollMessage.poll.answers[0].id] });
    ok('clicking your own vote removes it', unvote.status === 200 && unvote.data.poll.answers[0].votes === 0);
    const missingAnswer = await bob.post(`/api/messages/${pollMessage.id}/poll/vote`, { answer_ids: [9999] });
    ok('bogus poll answers are rejected', missingAnswer.status === 400);

    /* ── uploads & attachments ───────────────────────────────────── */
    section('Uploads');
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000200000002080600000079af1a8f0000001849444154'
      + '789c636060f80f04030c0c0c8c0c0c0c00000e0001b1b8fbcf0000000049454e44ae426082', 'hex');
    const upload = await alice.post('/api/uploads?kind=attachment&filename=dot.png', png, { headers: { 'content-type': 'image/png' } });
    ok('upload a PNG', upload.status === 201 || upload.status === 200, JSON.stringify(upload.data).slice(0, 160));
    const uploadId = (upload.data.attachment || upload.data).id;
    const withFile = await alice.post(`/api/channels/${channel.id}/messages`, { content: 'look', attachment_ids: [Number(uploadId)] });
    ok('attach the upload to a message', (withFile.data.message?.attachments || []).length === 1);
    const fileFetch = await bob.get(`/api/attachments/${uploadId}/dot.png`);
    ok('a member can download the attachment', fileFetch.status === 200);
    const anon = await fetch(`${BASE}/api/attachments/${uploadId}/dot.png`);
    ok('anonymous download is refused', anon.status === 401 || anon.status === 403, `status=${anon.status}`);

    const fake = Buffer.from('not really an image at all');
    const badUpload = await alice.post('/api/uploads?kind=avatar&filename=evil.png', fake, { headers: { 'content-type': 'image/png' } });
    ok('content sniffing rejects a fake image', badUpload.status === 400 || badUpload.status === 415, `status=${badUpload.status}`);

    /* ── friends ─────────────────────────────────────────────────── */
    section('Friends');
    const req = await alice.post('/api/relationships', { username: 'bob' });
    ok('send a friend request', req.status === 201 || req.status === 200, JSON.stringify(req.data).slice(0, 160));
    const bobRelationships = await bob.get('/api/relationships');
    const incoming = (bobRelationships.data.incoming_requests || [])[0];
    ok('bob sees the incoming request', !!incoming);
    if (incoming) {
      const accept = await bob.put(`/api/relationships/${incoming.id}`, { type: 'friend' });
      ok('accept the friend request', accept.status === 200 || accept.status === 204);
      const aliceFriends = await alice.get('/api/relationships');
      ok('both sides see the friendship', (aliceFriends.data.friends || []).some((f) => f.username === 'bob'));
    }
    const dms = await alice.post('/api/dms', { recipient_id: bobReg.data.user.id });
    ok('open a DM', dms.status === 201 || dms.status === 200, JSON.stringify(dms.data).slice(0, 160));
    const dmChannel = dms.data.channel;
    const dmMessage = await alice.post(`/api/channels/${dmChannel.id}/messages`, { content: 'dm hello' });
    ok('send a DM', dmMessage.status === 201 || dmMessage.status === 200);

    /* ── realtime gateway ────────────────────────────────────────── */
    section('Realtime gateway');
    const aliceGw = await gatewayClient(alice, 'alice');
    const bobGw = await gatewayClient(bob, 'bob');
    const aliceReady = await aliceGw.next('READY');
    const bobReady = await bobGw.next('READY');
    ok('gateway READY for alice', aliceReady.data.user.username === 'alice');
    ok('READY includes the guild list', (aliceReady.data.guild_ids || []).map(String).includes(String(guild.id)));
    ok('READY includes presence list', Array.isArray(aliceReady.data.presences));
    ok('READY exposes a session id (voice)', !!aliceReady.data.session_id);
    ok('READY carries relationships and DM channels', Array.isArray(aliceReady.data.dm_channels) && !!aliceReady.data.relationships);
    ok('gateway READY for bob', !!bobReady.data);

    // Clients subscribe to the channel they have open (this is what the web app does).
    aliceGw.send({ op: 'SUBSCRIBE', data: { channel_ids: [String(channel.id)] } });
    bobGw.send({ op: 'SUBSCRIBE', data: { channel_ids: [String(channel.id)] } });
    await aliceGw.next('SUBSCRIBED');

    bobGw.events.length = 0;
    await alice.post(`/api/channels/${channel.id}/messages`, { content: 'realtime ping' });
    const created = await bobGw.next('MESSAGE_CREATE');
    ok('message fan-out reaches the other client', created.data.content === 'realtime ping');

    const typingPromise = bobGw.next('TYPING_START');
    aliceGw.send({ op: 'TYPING', data: { channel_id: String(channel.id) } });
    const typing = await typingPromise;
    ok('typing indicator is relayed', String(typing.data.channel_id) === String(channel.id));

    const presencePromise = bobGw.next('PRESENCE_UPDATE');
    aliceGw.send({ op: 'PRESENCE_UPDATE', data: { status: 'dnd', custom_status: { text: 'testing' } } });
    const presence = await presencePromise;
    ok('presence updates propagate', presence.data.status === 'dnd' && presence.data.custom_status?.text === 'testing');

    aliceGw.send({ op: 'PING', nonce: 'abc123' });
    const pong = await aliceGw.next('PONG');
    ok('PING/PONG keeps the socket alive', pong.raw.nonce === 'abc123');

    /* ── voice signalling (mesh) ─────────────────────────────────── */
    aliceGw.events.length = 0;
    bobGw.events.length = 0;
    aliceGw.send({ op: 'VOICE_JOIN', data: { channel_id: String(voiceChannel.id) } });
    const voiceReady = await aliceGw.next('VOICE_READY');
    ok('voice join returns a session', voiceReady.data.channel_id && voiceReady.data.session_id);
    ok('voice join returns ICE servers', Array.isArray(voiceReady.data.ice_servers));

    bobGw.send({ op: 'VOICE_JOIN', data: { channel_id: String(voiceChannel.id) } });
    const bobVoice = await bobGw.next('VOICE_READY');
    ok('second joiner sees existing peers', (bobVoice.data.peers || []).length === 1, JSON.stringify(bobVoice.data.peers || []));

    const signalPromise = aliceGw.next('VOICE_SIGNAL');
    bobGw.send({ op: 'VOICE_SIGNAL', data: { channel_id: String(voiceChannel.id), user_id: aliceReady.data.user.id, signal: { sdp: 'fake-offer' } } });
    const signal = await signalPromise;
    ok('voice signals are relayed to the peer', signal.data.signal?.sdp === 'fake-offer' && !!signal.data.from_user_id);
    const voiceState = await bobGw.next('VOICE_STATE_UPDATE');
    ok('voice state updates are broadcast', !!voiceState.data);

    /* ── admin ───────────────────────────────────────────────────── */
    section('Admin');
    const adminStats = await alice.get('/api/admin/stats');
    ok('admin stats for the first account', adminStats.status === 200 && (adminStats.data.counts?.users ?? adminStats.data.stats?.users) >= 2);
    const adminDenied = await bob.get('/api/admin/stats');
    ok('admin endpoints are closed to normal users', adminDenied.status === 403, `status=${adminDenied.status}`);

    /* ── cleanup endpoints ───────────────────────────────────────── */
    section('Moderation');
    const banRes = await alice.put(`/api/guilds/${guild.id}/bans/${bobReg.data.user.id}`, { reason: 'test' });
    ok('ban a member', banRes.status === 200 || banRes.status === 204, `status=${banRes.status}`);
    const bans = await alice.get(`/api/guilds/${guild.id}/bans`);
    ok('bans are recorded', (bans.data.bans || []).length === 1);
    const resync = await alice.get(`/api/guilds/${guild.id}/sync`);
    ok('guild resync returns read states', resync.status === 200 && Array.isArray(resync.data.read_states?.channels));

    const audit = await alice.get(`/api/guilds/${guild.id}/audit-logs`);
    ok('audit log is written', (audit.data.audit_log_entries || []).length >= 1, JSON.stringify(audit.data).slice(0, 120));
    const auditDenied = await bob.get(`/api/guilds/${guild.id}/audit-logs`);
    ok('audit log needs the permission', auditDenied.status === 403, `status=${auditDenied.status}`);

    aliceGw.close();
    bobGw.close();
  } catch (err) {
    failed += 1;
    failures.push(err.message);
    console.error(`\n\x1b[31mTest run crashed:\x1b[0m ${err.stack}`);
  }

  shutdown();
  await sleep(300);

  console.log(`\n${'─'.repeat(56)}`);
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed.\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed} of ${passed + failed} checks failed:\x1b[0m`);
    for (const name of failures) console.log(`  · ${name}`);
    console.log('\nServer log tail:\n' + serverLog.split('\n').slice(-25).join('\n'));
  }
  console.log(`${'─'.repeat(56)}\n`);

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
