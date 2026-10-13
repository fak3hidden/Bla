/* Bla — application shell: boot, auth, routing, events and notifications. */
(function () {
  'use strict';
  const { el, clear, icon, $, toast, copy, relative, showMenu } = window.Bla;
  const S = window.BlaState;
  const state = S.state;
  const api = window.BlaApi;
  const GW = window.BlaGateway;
  const R = window.BlaRender;
  const M = window.BlaModals;
  const C = window.BlaChat;
  const V = window.BlaVoice;

  let booting = true;
  let booted = false;
  let pendingInvite = null;
  let titleTimer = null;

  /* ── boot ──────────────────────────────────────────────────────── */
  async function boot() {
    if (booted) return;      // guard against double boot (e.g. DOMContentLoaded plus a manual call)
    booted = true;
    state.config = await api.config().catch(() => null);
    if (!state.config) {
      document.body.innerHTML = '<div class="empty-state" style="height:100vh"><h2>Cannot reach the Bla server</h2><p>Check that the process is running, then reload.</p></div>';
      return;
    }
    applyConfig();
    bindAuthForm();

    const params = new URLSearchParams(location.search);
    if (params.get('invite')) pendingInvite = params.get('invite');

    const hash = parseHash();
    if (hash.invite) pendingInvite = hash.invite;

    try {
      const data = await api.me();
      await enterApp(data.user);
    } catch {
      showAuth();
    }
    booting = false;

    window.addEventListener('hashchange', () => route(parseHash()));
    window.addEventListener('bla:unauthorized', () => {
      GW.disconnect();
      state.me = null;
      state.token = null;
      api.setToken(null);
      showAuth('Your session expired. Sign in again.');
    });
  }

  function applyConfig() {
    document.title = state.config.server_name || 'Bla';
    $('#auth-server-name').textContent = state.config.server_name || 'Bla';
    const notice = $('#auth-notice');
    if (state.config.welcome_message) {
      notice.hidden = false;
      notice.textContent = state.config.welcome_message;
    }
    if (!state.config.registration_open) {
      $('#auth-switch-text').textContent = 'Sign-ups are closed on this instance.';
      $('#auth-switch').hidden = true;
    }
    if (state.config.invite_only) {
      $('#auth-invite-row').hidden = false;
      if (pendingInvite) $('#auth-invite').value = pendingInvite;
    }
  }

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const out = {};
    if (parts[0] === 'guild') {
      out.guildId = parts[1];
      if (parts[2] === 'channel') {
        out.channelId = parts[3];
        out.messageId = parts[4];
      }
    } else if (parts[0] === 'invite') {
      out.invite = parts[1];
    } else if (parts[0] === 'register') {
      out.register = true;
      out.invite = new URLSearchParams(location.hash.split('?')[1] || '').get('invite');
    } else if (parts[0] === 'channel') {
      out.channelId = parts[1];
    }
    return out;
  }

  function route(target) {
    if (!state.me) return;
    if (target.invite) return handleInviteLink(target.invite);
    if (target.guildId && target.channelId) return openChannel(target.channelId, target.guildId, target.messageId);
    if (target.guildId) return openGuild(target.guildId);
    if (target.channelId) return openChannel(target.channelId, null);
  }

  /* ── auth screen ───────────────────────────────────────────────── */
  let mode = 'login';

  function showAuth(message = '') {
    $('#app').hidden = true;
    $('#auth-screen').hidden = false;
    const notice = $('#auth-notice');
    if (message) {
      notice.hidden = false;
      notice.classList.add('error');
      notice.textContent = message;
    }
    setMode(mode);
    setTimeout(() => $('#auth-username')?.focus(), 50);
  }

  function setMode(next) {
    mode = next;
    const isRegister = mode === 'register';
    $('#auth-title').textContent = isRegister ? 'Create your account' : 'Welcome back';
    $('#auth-subtitle').innerHTML = isRegister
      ? 'No email address. No phone number. Just pick a name.'
      : `Sign in to <span id="auth-server-name">${window.Bla.escapeHtml(state.config?.server_name || 'Bla')}</span>`;
    $('#auth-submit').textContent = isRegister ? 'Create account' : 'Sign in';
    $('#auth-switch-text').textContent = isRegister ? 'Already have an account?' : 'Need an account?';
    $('#auth-switch').textContent = isRegister ? 'Sign in instead' : 'Create one — no email';
    $('#auth-confirm-row').hidden = !isRegister;
    $('#auth-password').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
  }

  function bindAuthForm() {
    $('#auth-switch').addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

    $('#auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('#auth-submit');
      const notice = $('#auth-notice');
      notice.hidden = true;
      notice.classList.remove('error');
      const username = $('#auth-username').value.trim();
      const password = $('#auth-password').value;
      button.disabled = true;
      button.textContent = mode === 'register' ? 'Creating account…' : 'Signing in…';
      try {
        let data;
        if (mode === 'register') {
          if (password !== $('#auth-confirm').value) throw new Error('Those passwords do not match.');
          const invite = $('#auth-invite').value.trim() || pendingInvite;
          data = await api.register({ username, password, invite });
        } else {
          data = await api.login({ username, password });
        }
        api.setToken(data.token);
        state.token = data.token;
        await enterApp(data.user);
        if (pendingInvite) {
          const code = pendingInvite;
          pendingInvite = null;
          await handleInviteLink(code);
        }
      } catch (err) {
        notice.hidden = false;
        notice.classList.add('error');
        notice.textContent = err.message;
      } finally {
        button.disabled = false;
        button.textContent = mode === 'register' ? 'Create account' : 'Sign in';
      }
    });
  }

  /* ── entering the app ──────────────────────────────────────────── */
  async function enterApp(user) {
    state.me = user;
    S.rememberUser(user);
    $('#auth-screen').hidden = true;
    $('#app').hidden = false;

    await loadGuilds();
    V.loadIce();
    GW.connect();

    S.on('message:new', onMessage);
    S.on('presence:update', onPresence);
    S.on('typing:update', (channelId) => {
      if (String(channelId) === String(state.view.channelId)) C.renderTyping(channelId);
    });
    S.on('read:update', () => { R.renderGuildRail(); R.renderSidebar(); });
    S.on('guild:update', () => { R.renderGuildRail(); R.renderSidebar(); });
    S.on('guild:remove', () => { R.renderGuildRail(); R.renderSidebar(); });
    S.on('members:update', () => R.renderMemberList());
    S.on('roles:update', () => { R.renderMemberList(); R.renderSidebar(); });
    S.on('message:update', (message) => {
      if (String(message.channel_id) === String(state.view.channelId)) C.onMessageUpdate(message);
    });
    S.on('message:remove', ({ channelId, messageId }) => {
      if (String(channelId) === String(state.view.channelId)) C.onMessageRemove({ channelId, messageId });
    });
    S.on('reaction:update', ({ message_id: messageId, channel_id: channelId }) => C.onReaction({ message_id: messageId, channel_id: channelId }));
    S.on('voice:state', () => { R.renderSidebar(); V.renderStage(); });
    S.on('settings:update', () => { R.renderSidebar(); R.renderMemberList(); });
    S.on('emojis:update', () => R.renderSidebar());

    GW.on('voice:ready', (data) => V.onReady(data));
    GW.on('voice:signal', (data) => V.onSignal(data));
    GW.on('voice:speaking', (data) => V.onSpeaking(data));
    GW.on('voice:state', (data) => V.onVoiceState(data));
    GW.on('relationship', () => refreshRelationships());
    GW.on('call:ring', ({ data }) => {
      const caller = data.caller;
      toast('Incoming call', `${S.displayName(caller)} is calling you.`);
      if (Notification.permission === 'granted' && state.settings.desktopNotifications) {
        new Notification(`${S.displayName(caller)} is calling`, { body: 'Open Bla to answer.' });
      }
    });
    GW.on('channel:create', (channel) => {
      if (channel.recipients) {
        if (!state.dmChannels.some((c) => String(c.id) === String(channel.id))) state.dmChannels.push(channel);
        R.renderSidebar();
      }
    });
    GW.on('dm:create', () => { api.dms().then((data) => { state.dmChannels = data.channels; R.renderSidebar(); }); });

    wireShell();
    applyAppearance();

    // Land somewhere sensible.
    if (!location.hash || location.hash === '#') {
      if (state.guildOrder.length) openGuild(state.guildOrder[0]);
      else openHome('friends');
    } else {
      route(parseHash());
    }
    if (pendingInvite) {
      const code = pendingInvite;
      pendingInvite = null;
      await handleInviteLink(code);
    }
    window.addEventListener('beforeunload', () => GW.disconnect());
  }

  function applyAppearance() {
    document.body.classList.toggle('compact', !!state.settings.compact);
  }

  async function loadGuilds() {
    const data = await api.guilds();
    state.guilds.clear();
    state.guildOrder = [];
    for (const guild of data.guilds) {
      const full = state.guilds.get(String(guild.id));
      S.setGuild({ ...guild, members: full?.members || [], emojis: guild.emojis || [], stickers: guild.stickers || [], soundboard: guild.soundboard || [] });
    }
    R.renderGuildRail();
    return data.guilds;
  }

  /* ── navigation ────────────────────────────────────────────────── */
  function openGuild(guildId) {
    const guild = state.guilds.get(String(guildId));
    if (!guild) return;
    state.view.kind = 'guild';
    state.view.guildId = String(guildId);
    location.hash = `#/guild/${guildId}`;

    GW.subscribe(guild.channels.map((c) => c.id));
    GW.send('SUBSCRIBE', { guild_ids: [String(guildId)] });

    // Full payload includes members, emojis, soundboard.
    api.guild(guildId).then((data) => {
      S.setGuild(data.guild);
      if (state.view.guildId !== String(guildId)) return;
      const remembered = localStorage.getItem(`bla:lastChannel:${guildId}`);
      const preferred = state.view.channelId && data.guild.channels.some((c) => String(c.id) === String(state.view.channelId))
        ? state.view.channelId
        : (remembered && data.guild.channels.some((c) => String(c.id) === remembered) ? remembered : null);
      R.renderGuildRail();
      R.renderSidebar();
      R.renderMemberList();
      if (preferred) openChannel(preferred, guildId);
      else {
        const first = data.guild.channels.find((c) => c.type === 0) || data.guild.channels.find((c) => c.type === 2);
        if (first) openChannel(first.id, guildId);
        else renderNoChannel();
      }
    }).catch(() => {});
    R.renderGuildRail();
    R.renderSidebar();
  }

  function renderNoChannel() {
    const header = $('#channel-header');
    clear(header);
    state.view.channelId = null;
    const container = $('#messages');
    const guild = S.currentGuild();
    const canManage = S.can(S.PERM.MANAGE_CHANNELS, guild?.id);
    clear(container).append(el('div', { class: 'empty-state' }, [
      el('img', { src: '/icons/logo.svg', alt: '' }),
      el('h2', {}, `Welcome to ${guild?.name || 'Bla'}`),
      el('p', {}, 'This server has no channels yet.'),
      canManage ? el('button', { class: 'btn btn-primary', onclick: () => M.createChannel(guild.id) }, [icon('plus'), 'Create the first channel']) : null,
    ]));
    clear($('#composer-wrap'));
    clear($('#members'));
  }

  function openChannel(channelId, guildId = null, jumpTo = null) {
    const channel = state.channels.get(String(channelId));
    if (!channel) {
      api.channel(channelId).then((data) => {
        S.setChannel(data.channel);
        openChannel(channelId, guildId, jumpTo);
      }).catch(() => toast('Channel not found', '', 'error'));
      return;
    }
    const previous = state.view.channelId;
    if (previous && String(previous) !== String(channelId)) {
      const textarea = C._textarea;
      if (textarea) S.setDraft(previous, textarea.value);
    }
    state.view.channelId = String(channelId);
    state.view.guildId = channel.guild_id ? String(channel.guild_id) : (guildId ? String(guildId) : null);
    state.view.kind = channel.guild_id ? 'guild' : 'home';
    localStorage.setItem(`bla:lastChannel:${state.view.guildId || 'dm'}`, String(channelId));
    location.hash = channel.guild_id
      ? `#/guild/${channel.guild_id}/channel/${channelId}${jumpTo ? `/${jumpTo}` : ''}`
      : `#/channel/${channelId}`;

    if (previous && String(previous) !== String(channelId)) GW.unsubscribe([previous]);
    GW.subscribe([channelId]);

    R.renderGuildRail();
    R.renderSidebar();
    R.renderChannelHeader();
    R.renderMemberList();
    C.open(channelId, { jumpTo });
    const members = $('#members');
    members.classList.toggle('collapsed', !channel.guild_id || !state.settings.showMembers);
  }

  function openHome(tab = 'friends') {
    state.view.kind = 'home';
    state.view.homeTab = tab;
    state.view.channelId = null;
    state.view.guildId = null;
    location.hash = '#/channels/@me';
    R.renderGuildRail();
    R.renderSidebar();
    R.renderChannelHeader();

    const header = $('#channel-header');
    clear(header);
    header.append(el('span', { class: 'name' }, 'Friends'));
    $('.members').classList.add('collapsed');

    const container = $('#messages');
    clear(container);
    const wrap = el('div', { class: 'discovery-wrap' });
    container.style.padding = '0';
    container.append(wrap);
    R.renderFriendsView(wrap);
    clear($('#composer-wrap'));
    api.dms().then((data) => {
      state.dmChannels = data.channels;
      R.renderSidebar();
    }).catch(() => {});
  }

  function refreshHome() {
    if (state.view.kind === 'home') openHome(state.view.homeTab);
    R.renderGuildRail();
  }

  async function openDiscovery() {
    state.view.kind = 'discovery';
    state.view.channelId = null;
    R.renderGuildRail();
    R.renderSidebar();
    const header = $('#channel-header');
    clear(header).append(el('span', { class: 'name' }, 'Explore servers'));
    $('.members').classList.add('collapsed');
    const container = $('#messages');
    container.style.padding = '0';
    clear(container);
    const wrap = el('div', { class: 'discovery-wrap' });
    container.append(wrap);
    await R.renderDiscoveryView(wrap);
    clear($('#composer-wrap'));
  }

  async function openDm(userId) {
    try {
      const data = await api.openDm([Number(userId)]);
      if (!state.dmChannels.some((c) => String(c.id) === String(data.channel.id))) state.dmChannels.push(data.channel);
      S.setChannel(data.channel);
      openChannel(data.channel.id, null);
    } catch { /* handled */ }
  }

  function markRead(channelId) {
    const channel = state.channels.get(String(channelId));
    if (!channel) return;
    const last = channel.last_message_id;
    if (last) api.ack(channelId, { message_id: last }).catch(() => {});
    S.setReadState(channelId, { last_message_id: last || '0', mention_count: 0, unread: false });
    R.renderGuildRail();
    R.renderSidebar();
    updateTitle();
  }

  /* ── events from the store ─────────────────────────────────────── */
  function onMessage(message) {
    const isActive = String(message.channel_id) === String(state.view.channelId);
    const channel = state.channels.get(String(message.channel_id));
    if (channel && (!channel.last_message_id || BigInt(message.id) > BigInt(channel.last_message_id))) {
      channel.last_message_id = message.id;
    }

    const mentionsMe = message.mention_everyone ||
      (message.mentions || []).some((u) => String(u.id) === String(state.me?.id));
    const isDm = !message.guild_id && String(message.author.id) !== String(state.me?.id);

    if (isActive && document.hasFocus()) {
      C.onNewMessage(message);
      api.ack(message.channel_id, { message_id: message.id }).catch(() => {});
      S.setReadState(message.channel_id, { last_message_id: message.id, mention_count: 0, unread: false });
    } else {
      const read = state.readStates.get(String(message.channel_id)) || {};
      if (mentionsMe || isDm) {
        S.setReadState(message.channel_id, { mention_count: (read.mention_count || 0) + 1, unread: true });
      } else {
        S.setReadState(message.channel_id, { unread: true });
      }
      if (String(message.author.id) !== String(state.me?.id)) notify(message, { mentionsMe, isDm });
    }
    R.renderGuildRail();
    R.renderSidebar();
    updateTitle();
  }

  function onPresence({ user_id: userId, status, previous }) {
    if (previous?.status !== status || previous?.custom_status !== undefined) {
      R.renderMemberList();
      if (state.view.kind === 'home') R.renderSidebar();
    }
  }

  function updateTitle() {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      let total = 0;
      for (const guildId of state.guildOrder) total += S.unreadCount(guildId);
      for (const dm of state.dmChannels) total += dm.mention_count || 0;
      document.title = total ? `(${total}) ${state.config?.server_name || 'Bla'}` : (state.config?.server_name || 'Bla');
    }, 100);
  }

  function notify(message, { mentionsMe, isDm }) {
    if (!state.settings.desktopNotifications || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    const author = S.displayName(message.author, message.guild_id);
    const channel = state.channels.get(String(message.channel_id));
    const title = isDm ? author : `${author} in #${channel?.name || 'channel'}`;
    const body = window.BlaMarkdown.plain(message.content, 120) || 'Sent an attachment';
    try {
      const notification = new Notification(title, { body, icon: '/icons/icon-192.png', tag: `bla-${message.channel_id}` });
      notification.onclick = () => {
        window.focus();
        openChannel(message.channel_id, message.guild_id);
        notification.close();
      };
    } catch { /* notification failed, no big deal */ }
    if (state.settings.sounds && mentionsMe) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.frequency.value = mentionsMe ? 880 : 620;
        gain.gain.value = 0.04;
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.12);
      } catch { /* ignore */ }
    }
  }

  async function refreshRelationships() {
    try {
      state.relationships = await api.relationships();
      if (state.view.kind === 'home') refreshHome();
      else R.renderGuildRail();
    } catch { /* ignore */ }
  }

  /* ── invite links ──────────────────────────────────────────────── */
  async function handleInviteLink(code) {
    try {
      const preview = await api.invitePreview(code);
      const guild = preview.guild;
      const wrap = el('div', { class: 'discovery-wrap' }, [
        el('div', { class: 'guild-card', style: { maxWidth: '520px', margin: '40px auto' } }, [
          el('div', { class: 'banner', style: { height: '120px' } }, guild.banner ? el('img', { src: guild.banner, alt: '' }) : null),
          el('div', { class: 'body' }, [
            el('div', { class: 'icon-badge' }, [
              R.avatar({ id: guild.id, avatar: guild.icon, display_name: guild.name }, { size: 56, square: true }),
              el('div', {}, [
                el('div', { class: 'name', style: { fontSize: '19px' } }, guild.name),
                el('div', { class: 'faint' }, `${guild.member_count} members · all boost perks free`),
              ]),
            ]),
            el('div', { class: 'desc' }, guild.description || 'No description yet.'),
            el('div', { class: 'chip-row' }, (guild.tags || []).map((tag) => el('span', { class: 'tag-pill' }, `#${tag}`))),
            el('div', { class: 'row', style: { gap: '10px', marginTop: '10px' } }, [
              el('button', {
                class: 'btn btn-primary',
                onclick: async (event) => {
                  event.target.disabled = true;
                  try {
                    const data = await api.acceptInvite(code);
                    toast('Joined!', guild.name);
                    await loadGuilds();
                    openGuild(data.guild_id);
                    if (data.channel_id) openChannel(data.channel_id, data.guild_id);
                  } catch { /* handled */ }
                },
              }, preview.is_member ? 'Open server' : 'Accept invite'),
              preview.is_member ? null : el('button', { class: 'btn btn-ghost', onclick: () => openHome('friends') }, 'Not now'),
            ]),
          ]),
        ]),
      ]);
      const container = $('#messages');
      container.style.padding = '0';
      clear(container).append(wrap);
      clear($('#composer-wrap'));
      const header = $('#channel-header');
      clear(header).append(el('span', { class: 'name' }, 'Server invite'));
      $('.members').classList.add('collapsed');
    } catch (err) {
      toast('Invite unavailable', err.message, 'error');
      openHome('friends');
    }
  }

  /* ── shell wiring ──────────────────────────────────────────────── */
  function wireShell() {
    const messages = $('#messages');
    messages.addEventListener('scroll', window.Bla.throttle(() => {
      if (messages.scrollTop < 60 && state.view.channelId) C.loadOlder(state.view.channelId);
      const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
      if (atBottom) {
        $('.jump-present')?.remove();
        if (state.view.channelId) {
          const channel = state.channels.get(String(state.view.channelId));
          if (channel?.last_message_id) markRead(state.view.channelId);
        }
      }
    }, 200));

    $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });

    document.addEventListener('keydown', (event) => {
      const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        M.quickSwitcher();
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        V.toggleMute();
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        V.toggleDeafen();
      } else if (event.key === 'Escape' && !inField) {
        window.Bla.closeMenu();
        $('#lightbox').hidden = true;
      } else if (event.key.toLowerCase() === 'm' && !inField && !event.ctrlKey && !event.metaKey) {
        if (state.voiceChannel) V.toggleMute();
      }
    });

    window.addEventListener('online', () => { GW.reconnectNow(); toast('Back online'); });
    window.addEventListener('offline', () => toast('You are offline', 'Bla will reconnect automatically.', 'error'));

    // Sidebar swipe toggle on small screens.
    document.addEventListener('click', (event) => {
      if (window.innerWidth > 860) return;
      const sidebar = $('#sidebar');
      if (event.target.closest('.mobile-only')) return;
      if (!sidebar.contains(event.target) && !event.target.closest('.channel-header')) sidebar.classList.remove('open');
    });
  }

  function lightbox(attachment) {
    const box = $('#lightbox');
    box.querySelector('img').src = attachment.url;
    box.querySelector('.lightbox-caption').textContent = `${attachment.filename} · ${window.Bla.formatBytes(attachment.size)}`;
    box.hidden = false;
  }

  window.BlaApp = {
    boot, openGuild, openChannel, openHome, openDiscovery, openDm, markRead, loadGuilds,
    refreshHome, refreshRelationships, lightbox, showAuth, route,
  };

  document.addEventListener('DOMContentLoaded', boot);
}());
