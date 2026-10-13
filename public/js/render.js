/* Bla — DOM rendering for the shell: rail, sidebar, channel list, member list,
   friends view, discovery and profiles. */
(function () {
  'use strict';
  const { el, clear, icon, $, formatBytes, relative, initials, colorFromId, showMenu, copy, toast } = window.Bla;
  const S = window.BlaState;
  const state = S.state;
  const api = window.BlaApi;

  const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible', offline: 'Offline' };

  /* ── avatars ───────────────────────────────────────────────────── */
  function avatar(entity, { size = 40, status = null, square = false, tip = true } = {}) {
    const user = entity?.user || entity;
    const id = user?.id ?? entity?.user_id ?? '0';
    const src = user?.avatar;
    const name = user?.display_name || user?.username || '?';
    const node = el('div', {
      class: `avatar ${square ? 'square' : ''}`,
      style: { width: `${size}px`, height: `${size}px`, flex: `0 0 ${size}px` },
      dataset: tip ? { tip: name } : {},
    });
    if (src) {
      node.append(el('img', {
        class: 'img',
        src,
        alt: '',
        loading: 'lazy',
        onerror: (e) => {
          e.target.replaceWith(el('div', {
            class: 'img',
            style: { background: colorFromId(id), fontSize: `${Math.round(size / 2.6)}px` },
          }, initials(name)));
        },
      }));
    } else {
      node.append(el('div', {
        class: 'img',
        style: { background: colorFromId(id), fontSize: `${Math.round(size / 2.6)}px` },
      }, initials(name)));
    }
    if (status) {
      node.append(el('span', { class: `status-dot ${status}`, style: size < 32 ? { width: '10px', height: '10px', borderWidth: '2px' } : {} }));
    }
    return node;
  }

  function guildIcon(guild, size = 48) {
    const node = el('div', { class: 'avatar square', style: { width: `${size}px`, height: `${size}px`, flex: `0 0 ${size}px` } });
    if (guild.icon) node.append(el('img', { class: 'img', src: guild.icon, alt: '' }));
    else node.append(el('div', { class: 'img', style: { background: colorFromId(guild.id), fontSize: '18px' } }, initials(guild.name)));
    return node;
  }

  function presenceOf(userId) {
    const presence = S.presence(userId);
    const inVoice = state.voiceStates.get(String(userId));
    if (inVoice && presence.status !== 'offline') return presence.status;
    return presence.status || 'offline';
  }

  /* ── guild rail ────────────────────────────────────────────────── */
  function renderGuildRail() {
    const rail = $('#guild-rail');
    clear(rail);

    rail.append(el('button', {
      class: `rail-item home ${state.view.kind === 'home' ? 'active' : ''}`,
      title: 'Direct messages',
      'data-tip': 'Home',
      onclick: () => window.BlaApp.openHome('friends'),
    }, [
      el('span', { class: 'pill' }),
      (() => {
        const svg = icon('home', 'glyph');
        return svg;
      })(),
      homeBadge(),
    ]));

    rail.append(el('div', { class: 'rail-divider' }));

    for (const guildId of state.guildOrder) {
      const guild = state.guilds.get(guildId);
      if (!guild) continue;
      const mentions = S.unreadCount(guildId);
      const active = String(state.view.guildId) === String(guildId);
      const item = el('button', {
        class: `rail-item ${active ? 'active' : ''} ${mentions ? '' : hasUnread(guildId) ? 'unread' : ''}`,
        'data-tip': guild.name,
        onclick: () => window.BlaApp.openGuild(guildId),
        oncontextmenu: (event) => guildMenu(event, guild),
      }, [
        el('span', { class: 'pill' }),
        guild.icon
          ? el('img', { src: guild.icon, alt: '' })
          : el('span', {}, initials(guild.name)),
        mentions ? el('span', { class: 'rail-badge' }, mentions > 99 ? '99+' : String(mentions)) : null,
      ]);
      rail.append(item);
    }

    rail.append(el('button', {
      class: 'rail-item add',
      'data-tip': 'Create a server — free, unlimited',
      onclick: () => window.BlaModals.createGuild(),
    }, [icon('plus', 'glyph')]));

    rail.append(el('button', {
      class: `rail-item add ${state.view.kind === 'discovery' ? 'active' : ''}`,
      'data-tip': 'Explore public servers',
      onclick: () => window.BlaApp.openDiscovery(),
    }, [icon('compass', 'glyph')]));
  }

  function homeBadge() {
    const mentions = state.guilds.size
      ? [...state.guilds.keys()].reduce((sum, id) => sum + S.unreadCount(id), 0)
      : 0;
    const dmMentions = state.dmChannels.reduce((sum, c) => sum + (c.mention_count || 0), 0);
    const total = mentions + dmMentions;
    return total ? el('span', { class: 'rail-badge' }, total > 99 ? '99+' : String(total)) : null;
  }

  function hasUnread(guildId) {
    const guild = state.guilds.get(String(guildId));
    if (!guild) return false;
    return guild.channels.some((channel) => S.channelUnread(channel.id).unread);
  }

  function guildMenu(event, guild) {
    showMenu(event, [
      { label: 'Copy server id', icon: 'copy', action: async () => { await copy(guild.id); toast('Server id copied', guild.id); } },
      { label: 'Copy vanity URL', icon: 'link', action: async () => {
        const url = `${location.origin}/invite/${guild.vanity_url}`;
        await copy(url); toast('Invite link copied', url);
      } },
      { type: 'separator' },
      { label: 'Invite people', icon: 'plus', disabled: !S.can(S.PERM.CREATE_INSTANT_INVITE, guild.id), action: () => window.BlaModals.invite(guild.id) },
      { label: 'Notification settings', icon: 'bell', action: () => window.BlaSettings.guildNotifications(guild.id) },
      { label: 'Privacy settings', icon: 'shield' },
      { type: 'separator' },
      { label: 'Server settings', icon: 'gear', disabled: !S.can(S.PERM.MANAGE_GUILD, guild.id), action: () => window.BlaSettings.openGuild(guild.id) },
      { label: 'Create channel', icon: 'plus', disabled: !S.can(S.PERM.MANAGE_CHANNELS, guild.id), action: () => window.BlaModals.createChannel(guild.id) },
      { type: 'separator' },
      {
        label: guild.owner_id === String(state.me?.id) ? 'Delete server' : 'Leave server',
        icon: 'logout',
        danger: true,
        action: () => window.BlaModals.confirmLeaveOrDelete(guild),
      },
    ]);
  }

  /* ── sidebar ───────────────────────────────────────────────────── */
  function renderSidebar() {
    const header = $('#sidebar-header');
    const body = $('#sidebar-body');
    clear(header);
    clear(body);

    if (state.view.kind === 'home') renderHomeSidebar(header, body);
    else if (state.view.kind === 'discovery') renderDiscoverySidebar(header, body);
    else renderGuildSidebar(header, body);

    renderUserPanel();
  }

  function renderGuildSidebar(header, body) {
    const guild = S.currentGuild();
    if (!guild) {
      header.append(el('span', { class: 'title' }, 'No server selected'));
      return;
    }
    header.append(el('button', {
      class: 'title clickable',
      onclick: (event) => guildMenu(event, guild),
    }, guild.name));
    header.append(el('span', { class: 'badge boost' }, 'PERKS FREE'));

    const channels = guild.channels.filter((c) => c.type !== 2 || true);
    const categories = channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
    const uncategorised = channels.filter((c) => c.type !== 4 && !c.parent_id);

    const appendChannel = (channel) => {
      if (channel.type === 4) return; // categories handled separately
      const item = channelItem(channel, guild);
      body.append(item);
      if (channel.type === 2 || channel.type === 13) {
        const occupants = [...state.voiceStates.values()].filter((v) => String(v.channel_id) === String(channel.id));
        if (occupants.length) {
          const list = el('div', { class: 'voice-members' });
          for (const occupant of occupants) {
            const user = S.user(occupant.user_id);
            const name = S.displayName(user, guild.id);
            const row = el('div', {
              class: `voice-member ${state.speakingUsers?.has(String(occupant.user_id)) ? 'speaking' : ''}`,
              onclick: () => window.BlaModals.userProfile(occupant.user_id, guild.id),
            }, [
              avatar(user, { size: 22 }),
              el('span', { class: 'label' }, name),
              el('span', { class: 'mini-icons' }, [
                occupant.self_mute || occupant.server_mute ? icon('micOff') : null,
                occupant.self_deaf || occupant.server_deaf ? icon('headphones') : null,
                occupant.self_video ? icon('video') : null,
                occupant.self_stream ? icon('screen') : null,
              ]),
            ]);
            list.append(row);
          }
          body.append(list);
        }
      }
    };

    for (const channel of uncategorised) appendChannel(channel);
    for (const category of categories) {
      const collapsed = state.collapsedCategories.has(String(category.id));
      const row = el('div', {
        class: `channel-category ${collapsed ? 'collapsed' : ''}`,
        onclick: () => S.toggleCategory(category.id),
      }, [
        icon('chevronDown', 'chevron'),
        el('span', {}, category.name),
        el('span', { class: 'actions' }, [
          el('button', {
            class: 'icon-btn', 'data-tip': 'Create channel',
            onclick: (event) => { event.stopPropagation(); window.BlaModals.createChannel(guild.id, category.id); },
            disabled: !S.can(S.PERM.MANAGE_CHANNELS, guild.id),
          }, [icon('plus')]),
        ]),
      ]);
      body.append(row);
      if (collapsed) continue;
      for (const child of channels.filter((c) => String(c.parent_id) === String(category.id) && c.type !== 4)) {
        appendChannel(child);
      }
    }

    if (S.can(S.PERM.MANAGE_CHANNELS, guild.id)) {
      body.append(el('div', {
        class: 'channel-category',
        style: { cursor: 'pointer', paddingTop: '14px' },
        onclick: () => window.BlaModals.createChannel(guild.id),
      }, [icon('plus', 'chevron'), el('span', {}, 'Create channel')]));
    }
  }

  function channelItem(channel, guild) {
    const { unread, mentions } = S.channelUnread(channel.id);
    const active = String(state.view.channelId) === String(channel.id);
    const canView = true;
    const glyph = channel.type === 2 || channel.type === 13 ? 'volume' : 'hash';
    const item = el('div', {
      class: `channel-item ${active ? 'active' : ''} ${unread && !active ? 'unread' : ''}`,
      dataset: { channelId: String(channel.id) },
      onclick: () => window.BlaApp.openChannel(channel.id, channel.guild_id),
      oncontextmenu: (event) => channelMenu(event, channel, guild),
    }, [
      el('span', { class: 'glyph' }, [icon(glyph)]),
      el('span', { class: 'label' }, channel.name),
      mentions ? el('span', { class: 'badge-count' }, mentions > 99 ? '99+' : String(mentions)) : null,
      el('span', { class: 'actions' }, [
        S.can(S.PERM.MANAGE_CHANNELS, channel.guild_id)
          ? el('button', { class: 'icon-btn', 'data-tip': 'Edit channel', onclick: (event) => { event.stopPropagation(); window.BlaSettings.openChannel(channel.id); } }, [icon('gear')])
          : null,
        S.can(S.PERM.CREATE_INSTANT_INVITE, channel.guild_id)
          ? el('button', { class: 'icon-btn', 'data-tip': 'Invite', onclick: (event) => { event.stopPropagation(); window.BlaModals.invite(channel.guild_id, channel.id); } }, [icon('plus')])
          : null,
      ]),
    ]);
    return item;
  }

  function channelMenu(event, channel, guild) {
    const items = [
      { label: 'Mark as read', icon: 'check', action: () => window.BlaApp.markRead(channel.id) },
      { label: 'Copy channel id', icon: 'copy', action: async () => { await copy(channel.id); toast('Channel id copied', channel.id); } },
      { label: 'Copy link', icon: 'link', action: async () => {
        const link = `${location.origin}/#/guild/${channel.guild_id}/channel/${channel.id}`;
        await copy(link); toast('Link copied', link);
      } },
      { label: S.channelUnread(channel.id).muted ? 'Unmute channel' : 'Mute channel', icon: S.channelUnread(channel.id).muted ? 'bell' : 'bellOff', action: async () => {
        const muted = !S.channelUnread(channel.id).muted;
        await api.muteChannel(channel.id, muted);
        S.setReadState(channel.id, { muted });
        renderSidebar();
      } },
    ];
    if (channel.type === 2 || channel.type === 13) {
      items.push({ type: 'separator' }, {
        label: 'Join voice', icon: 'volume',
        disabled: !S.canInChannel(channel.id, S.PERM.CONNECT),
        action: () => window.BlaVoice.join(channel.id),
      });
    }
    if (S.can(S.PERM.MANAGE_CHANNELS, guild.id)) {
      items.push({ type: 'separator' },
        { label: 'Edit channel', icon: 'gear', action: () => window.BlaSettings.openChannel(channel.id) },
        { label: 'Duplicate', icon: 'copy', action: async () => {
          await api.createChannel(guild.id, {
            name: channel.name, type: channel.type, parent_id: channel.parent_id, topic: channel.topic,
          });
          toast('Channel duplicated', channel.name);
        } },
        { type: 'separator' },
        { label: 'Delete channel', icon: 'trash', danger: true, action: () => window.BlaModals.confirm({
          title: `Delete #${channel.name}?`,
          body: 'This deletes the channel and every message in it. This cannot be undone.',
          confirmLabel: 'Delete channel',
          danger: true,
          onConfirm: async () => { await api.deleteChannel(guild.id, channel.id); toast('Channel deleted', channel.name); },
        }) });
    }
    showMenu(event, items);
  }

  /* ── home (friends + DMs) ──────────────────────────────────────── */
  function renderHomeSidebar(header, body) {
    header.append(el('span', { class: 'title' }, 'Direct messages'));
    const tabs = el('div', { class: 'tab-row' }, [
      el('button', {
        class: `btn btn-sm ${state.view.homeTab === 'friends' ? 'btn-primary' : 'btn-outline'}`,
        onclick: () => window.BlaApp.openHome('friends'),
      }, 'Friends'),
      el('button', {
        class: 'btn btn-sm btn-outline',
        onclick: () => window.BlaModals.newGroupDm(),
      }, 'New group'),
    ]);
    body.append(tabs);

    const dms = [...state.dmChannels].sort((a, b) => Number(b.last_message?.id || b.id) - Number(a.last_message?.id || a.id));
    if (!dms.length) {
      body.append(el('div', { class: 'section-title' }, 'No conversations yet'));
      body.append(el('p', { class: 'faint', style: { padding: '0 12px', fontSize: '13px' } },
        'Start one from a friend\u2019s profile, or search for someone with Ctrl+K.'));
    }
    for (const dm of dms) {
      const other = dm.recipients?.[0];
      const label = dm.name || (dm.recipients?.length > 1
        ? dm.recipients.map((r) => r.display_name || r.username).join(', ')
        : S.displayName(other));
      const active = String(state.view.channelId) === String(dm.id);
      body.append(el('div', {
        class: `dm-item ${active ? 'active' : ''} ${dm.unread ? 'unread' : ''}`,
        onclick: () => window.BlaApp.openChannel(dm.id, null),
      }, [
        dm.recipients?.length > 1
          ? avatar({ id: dm.id, display_name: label, avatar: dm.icon }, { size: 30, status: null })
          : avatar(other, { size: 30, status: presenceOf(other?.id) }),
        el('span', { class: 'label' }, label),
        dm.mention_count ? el('span', { class: 'badge-count' }, String(dm.mention_count)) : null,
      ]));
    }
  }

  function renderDiscoverySidebar(header, body) {
    header.append(el('span', { class: 'title' }, 'Explore servers'));
    body.append(el('p', { class: 'faint', style: { padding: '12px', fontSize: '13px' } },
      'Every server on this instance that has discovery enabled shows up here. Joining is instant and free.'));
    body.append(el('button', {
      class: 'btn btn-outline btn-block',
      onclick: () => window.BlaModals.createGuild(),
    }, [icon('plus'), 'Create your own']));
  }

  /* ── user panel ────────────────────────────────────────────────── */
  function renderUserPanel() {
    const panel = $('#user-panel');
    clear(panel);
    const me = state.me;
    if (!me) return;
    const status = S.presence(me.id).status || 'online';
    panel.append(el('div', {
      class: 'me',
      onclick: () => window.BlaModals.userProfile(me.id),
    }, [
      avatar(me, { size: 32, status }),
      el('div', { class: 'me-text' }, [
        el('div', { class: 'me-name' }, S.displayName(me)),
        el('div', { class: 'me-status' }, S.presence(me.id).custom_status?.text || STATUS_LABEL[status] || 'Online'),
      ]),
    ]));
    const voice = state.voiceChannel;
    panel.append(el('div', { class: 'actions' }, [
      el('button', {
        class: `icon-btn ${voice?.selfMute ? 'danger' : ''}`,
        'data-tip': voice?.selfMute ? 'Unmute' : 'Mute',
        onclick: () => window.BlaVoice.toggleMute(),
      }, [icon(voice?.selfMute ? 'micOff' : 'mic')]),
      el('button', {
        class: `icon-btn ${voice?.selfDeaf ? 'danger' : ''}`,
        'data-tip': voice?.selfDeaf ? 'Undeafen' : 'Deafen',
        onclick: () => window.BlaVoice.toggleDeafen(),
      }, [icon('headphones')]),
      el('button', {
        class: 'icon-btn',
        'data-tip': 'User settings',
        onclick: () => window.BlaSettings.openUser('profile'),
      }, [icon('gear')]),
    ]));
  }

  /* ── member list ───────────────────────────────────────────────── */
  function renderMemberList() {
    const container = $('#members');
    clear(container);
    const guild = S.currentGuild();
    if (!guild || !state.settings.showMembers) {
      container.classList.add('collapsed');
      return;
    }
    container.classList.remove('collapsed');

    const members = [...guild.members];
    for (const member of members) S.rememberUser(member.user);

    const groups = new Map();
    const onlineMembers = [];
    const offlineMembers = [];

    for (const member of members) {
      const status = presenceOf(member.user_id);
      const isOffline = status === 'offline' || status === 'invisible';
      const hoistedRole = S.rolesOf(guild.id, member.user_id).find((r) => r.hoist);
      if (!isOffline) {
        if (hoistedRole) {
          if (!groups.has(hoistedRole.id)) groups.set(hoistedRole.id, { role: hoistedRole, members: [] });
          groups.get(hoistedRole.id).members.push(member);
        } else onlineMembers.push(member);
      } else offlineMembers.push(member);
    }

    const sortByName = (a, b) => S.displayName(a.user, guild.id).localeCompare(S.displayName(b.user, guild.id));
    onlineMembers.sort(sortByName);
    offlineMembers.sort(sortByName);

    const renderRow = (member) => {
      const status = presenceOf(member.user_id);
      const roles = S.rolesOf(guild.id, member.user_id);
      const color = S.topRoleColor(guild.id, member.user_id);
      const name = S.displayName(member.user, guild.id);
      const streaming = state.voiceStates.get(String(member.user_id))?.self_stream;
      return el('div', {
        class: `member ${status === 'offline' || status === 'invisible' ? 'offline' : ''}`,
        onclick: (event) => window.BlaModals.userProfile(member.user_id, guild.id),
        oncontextmenu: (event) => window.BlaModals.memberMenu(event, guild.id, member.user_id),
      }, [
        avatar(member.user, { size: 32, status: streaming ? 'streaming' : status }),
        el('div', { style: { minWidth: 0 } }, [
          el('div', { class: 'member-name', style: color ? { color: `#${color.toString(16).padStart(6, '0')}` } : {} }, [
            name,
            member.user.bot ? el('span', { class: 'badge bot' }, 'BOT') : null,
            String(member.user_id) === String(guild.owner_id) ? el('span', { class: 'badge boost' }, 'OWNER') : null,
          ]),
          S.presence(member.user_id).custom_status?.text
            ? el('div', { class: 'member-sub' }, S.presence(member.user_id).custom_status.text)
            : (roles.length ? el('div', { class: 'member-sub' }, roles[0].name) : null),
        ]),
      ]);
    };

    if (onlineMembers.length) {
      container.append(el('div', { class: 'member-group-title' }, `Online — ${onlineMembers.length}`));
      for (const member of onlineMembers) container.append(renderRow(member));
    }
    for (const [roleId, group] of [...groups.entries()].sort((a, b) => b[1].role.position - a[1].role.position)) {
      container.append(el('div', {
        class: 'member-group-title',
        style: group.role.color ? { color: `#${group.role.color.toString(16).padStart(6, '0')}` } : {},
      }, `${group.role.name} — ${group.members.length}`));
      for (const member of group.members.sort(sortByName)) container.append(renderRow(member));
    }
    if (offlineMembers.length) {
      container.append(el('div', { class: 'member-group-title' }, `Offline — ${offlineMembers.length}`));
      for (const member of offlineMembers) container.append(renderRow(member));
    }
  }

  /* ── home content: friends ─────────────────────────────────────── */
  function renderFriendsView(container) {
    const tab = state.view.homeTab || 'friends';
    const header = el('div', { class: 'discovery-head' }, [
      el('h1', {}, 'Friends'),
      el('div', { class: 'tab-row', style: { padding: 0 } },
        ['friends', 'online', 'pending', 'blocked', 'add'].map((key) => el('button', {
          class: `btn btn-sm ${tab === key ? 'btn-primary' : 'btn-ghost'}`,
          onclick: () => window.BlaApp.openHome(key),
        }, key === 'add' ? 'Add friend' : key[0].toUpperCase() + key.slice(1)))),
    ]);
    container.append(header);

    if (tab === 'add') {
      const input = el('input', { type: 'text', placeholder: 'username or username#0000' });
      const searchBtn = el('button', { class: 'btn btn-primary' }, 'Send request');
      const results = el('div', { style: { marginTop: '18px' } });
      const submit = async () => {
        const value = input.value.trim();
        if (!value) return;
        try {
          const data = await api.addFriend(value.includes('#') ? { username: value } : { username: value });
          clear(results).append(el('div', { class: 'friend-row' }, [
            avatar(data.user, { size: 36 }),
            el('div', { class: 'who' }, [
              el('div', {}, S.displayName(data.user)),
              el('div', { class: 'sub' }, data.status === 'friends' ? 'You are now friends!' : 'Friend request sent.'),
            ]),
          ]));
          input.value = '';
        } catch (err) {
          clear(results).append(el('div', { class: 'friend-row' }, el('div', { class: 'sub' }, err.message)));
        }
      };
      searchBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      container.append(el('div', { class: 'row', style: { maxWidth: '520px' } }, [input, searchBtn]));
      container.append(el('p', { class: 'faint', style: { marginTop: '12px', fontSize: '13px' } },
        'Friends are optional here — you can talk to anyone on this instance. Add people to see when they are around.'));
      container.append(results);
      return;
    }

    if (tab === 'pending') {
      const { incoming_requests: incoming, outgoing_requests: outgoing } = state.relationships;
      container.append(el('div', { class: 'section-title' }, `Incoming — ${incoming.length}`));
      if (!incoming.length) container.append(el('p', { class: 'faint', style: { padding: '0 12px' } }, 'No incoming requests.'));
      for (const user of incoming) container.append(friendRow(user, 'incoming'));
      container.append(el('div', { class: 'section-title' }, `Outgoing — ${outgoing.length}`));
      if (!outgoing.length) container.append(el('p', { class: 'faint', style: { padding: '0 12px' } }, 'No pending requests.'));
      for (const user of outgoing) container.append(friendRow(user, 'outgoing'));
      return;
    }

    if (tab === 'blocked') {
      const blocked = state.relationships.blocked;
      container.append(el('div', { class: 'section-title' }, `Blocked — ${blocked.length}`));
      if (!blocked.length) container.append(el('p', { class: 'faint', style: { padding: '0 12px' } }, 'Nobody is blocked.'));
      for (const user of blocked) container.append(friendRow(user, 'blocked'));
      return;
    }

    const friends = S.sortedFriends();
    const filtered = tab === 'online'
      ? friends.filter((f) => ['online', 'idle', 'dnd', 'streaming'].includes(presenceOf(f.id)))
      : friends;
    container.append(el('div', { class: 'section-title' }, `${tab === 'online' ? 'Online' : 'All friends'} — ${filtered.length}`));
    if (!filtered.length) {
      container.append(el('div', { class: 'empty-state' }, [
        icon('users'),
        el('h2', {}, tab === 'online' ? 'No one is around right now' : 'No friends yet'),
        el('p', {}, 'Use “Add friend” or open someone\u2019s profile from a server to add them.'),
      ]));
    }
    for (const user of filtered) container.append(friendRow(user, 'friend'));
  }

  function friendRow(user, kind) {
    const status = presenceOf(user.id);
    const actions = [];
    if (kind === 'friend') {
      actions.push(el('button', { class: 'btn btn-sm btn-primary', onclick: () => window.BlaApp.openDm(user.id) }, [icon('hash'), 'Message']));
      actions.push(el('button', {
        class: 'btn btn-sm btn-outline',
        onclick: (event) => showMenu(event, [
          { label: 'Remove friend', icon: 'trash', danger: true, action: async () => {
            await api.removeFriend(user.id);
            state.relationships.friends = state.relationships.friends.filter((f) => String(f.id) !== String(user.id));
            window.BlaApp.refreshHome();
          } },
          { label: 'Block', icon: 'ban', danger: true, action: async () => {
            await api.blockUser(user.id);
            const rel = await api.relationships();
            state.relationships = rel;
            window.BlaApp.refreshHome();
          } },
        ]),
      }, [icon('more')]));
    } else if (kind === 'incoming') {
      actions.push(el('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
        await api.acceptFriend(user.id);
        state.relationships = await api.relationships();
        window.BlaApp.refreshHome();
      } }, 'Accept'));
      actions.push(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        await api.removeFriend(user.id);
        state.relationships = await api.relationships();
        window.BlaApp.refreshHome();
      } }, 'Ignore'));
    } else if (kind === 'outgoing') {
      actions.push(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        await api.removeFriend(user.id);
        state.relationships = await api.relationships();
        window.BlaApp.refreshHome();
      } }, 'Cancel'));
    } else if (kind === 'blocked') {
      actions.push(el('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
        await api.unblockUser(user.id);
        state.relationships = await api.relationships();
        window.BlaApp.refreshHome();
      } }, 'Unblock'));
    }
    return el('div', {
      class: 'friend-row',
      onclick: (event) => { if (event.target.closest('button')) return; window.BlaModals.userProfile(user.id); },
      style: { cursor: 'pointer' },
    }, [
      avatar(user, { size: 36, status }),
      el('div', { class: 'who' }, [
        el('div', {}, S.displayName(user)),
        el('div', { class: 'sub' }, S.presence(user.id).custom_status?.text || STATUS_LABEL[status] || 'Offline'),
      ]),
      el('div', { class: 'friend-actions' }, actions),
    ]);
  }

  /* ── discovery ─────────────────────────────────────────────────── */
  async function renderDiscoveryView(container) {
    container.append(el('div', { class: 'discovery-head' }, [
      el('h1', {}, 'Explore servers'),
      el('p', { class: 'faint', style: { margin: 0 } }, 'Free to join, no invite needed.'),
    ]));
    const searchInput = el('input', {
      type: 'search', placeholder: 'Search servers by name, description or tag…', style: { maxWidth: '420px' },
    });
    container.append(el('div', { class: 'row', style: { marginBottom: '20px' } }, [searchInput]));
    const grid = el('div', { class: 'discovery-grid' });
    container.append(grid);

    const load = async (q = '') => {
      clear(grid).append(el('p', { class: 'faint' }, 'Loading…'));
      try {
        const data = await api.discovery({ q, limit: 30 });
        clear(grid);
        if (!data.guilds.length) {
          grid.append(el('div', { class: 'empty-state' }, [
            icon('compass'), el('h2', {}, 'Nothing here yet'),
            el('p', {}, 'No servers match that search. Create one and it will show up for everyone.'),
          ]));
          return;
        }
        for (const guild of data.guilds) grid.append(guildCard(guild));
      } catch {
        clear(grid).append(el('p', { class: 'faint' }, 'Could not load the directory.'));
      }
    };
    searchInput.addEventListener('input', window.Bla.debounce(() => load(searchInput.value.trim()), 300));
    await load();
  }

  function guildCard(guild) {
    const joinBtn = guild.already_member
      ? el('button', { class: 'btn btn-sm btn-outline', onclick: () => window.BlaApp.openGuild(guild.id) }, 'Open')
      : el('button', {
        class: 'btn btn-sm btn-primary',
        onclick: async (event) => {
          event.stopPropagation();
          try {
            await api.joinDiscovery(guild.id);
            toast('Joined!', guild.name);
            await window.BlaApp.loadGuilds();
            window.BlaApp.openGuild(guild.id);
          } catch (err) { /* toast already shown */ }
        },
      }, 'Join');
    return el('div', { class: 'guild-card', onclick: () => window.BlaModals.guildPreview(guild.id) }, [
      el('div', { class: 'banner' }, guild.banner ? el('img', { src: guild.banner, alt: '' }) : null),
      el('div', { class: 'body' }, [
        el('div', { class: 'icon-badge' }, [
          avatar({ id: guild.id, avatar: guild.icon, display_name: guild.name }, { size: 40, square: true }),
          el('div', {}, [
            el('div', { class: 'name' }, guild.name),
            el('div', { class: 'faint', style: { fontSize: '12.5px' } }, `${guild.member_count} member${guild.member_count === 1 ? '' : 's'}`),
          ]),
        ]),
        el('div', { class: 'desc' }, guild.description || 'No description yet.'),
        el('div', { class: 'chip-row' }, (guild.tags || []).slice(0, 4).map((tag) => el('span', { class: 'tag-pill' }, `#${tag}`))),
        el('div', { class: 'row between' }, [
          el('span', { class: 'meta' }, [icon('bolt'), 'All perks free']),
          joinBtn,
        ]),
      ]),
    ]);
  }

  /* ── channel header ────────────────────────────────────────────── */
  function renderChannelHeader() {
    const header = $('#channel-header');
    clear(header);
    const channel = S.currentChannel();
    if (!channel) return;

    if (!channel.guild_id) {
      const other = channel.recipients?.[0];
      header.append(avatar(channel.recipients?.length > 1 ? { id: channel.id, display_name: channel.name, avatar: channel.icon } : other, {
        size: 28, status: channel.recipients?.length === 1 ? presenceOf(other?.id) : null,
      }));
      header.append(el('span', { class: 'name' }, channel.name || channel.recipients?.map((r) => S.displayName(r)).join(', ') || 'Conversation'));
      header.append(el('div', { class: 'spacer' }));
      header.append(el('button', {
        class: 'icon-btn', 'data-tip': 'Start a call',
        onclick: async () => {
          const data = await api.startCall(channel.id);
          window.BlaVoice.join(data.channel.id);
        },
      }, [icon('phoneOff')]));
      if (channel.recipients?.length > 1) {
        header.append(el('button', { class: 'icon-btn', 'data-tip': 'Add people', onclick: () => window.BlaModals.addToGroup(channel.id) }, [icon('plus')]));
      }
      header.append(el('button', { class: 'icon-btn', 'data-tip': 'Close conversation', onclick: async () => {
        await api.closeDm(channel.id);
        state.dmChannels = state.dmChannels.filter((c) => String(c.id) !== String(channel.id));
        window.BlaApp.openHome('friends');
      } }, [icon('close')]));
      return;
    }

    header.append(el('span', { class: 'hash' }, [icon(channel.type === 2 ? 'volume' : 'hash')]));
    header.append(el('span', { class: 'name' }, channel.name));
    if (channel.topic) header.append(el('span', { class: 'topic' }, channel.topic));
    header.append(el('div', { class: 'spacer' }));
    if (channel.type === 2 || channel.type === 13) {
      header.append(el('button', { class: 'btn btn-sm btn-primary', onclick: () => window.BlaVoice.join(channel.id) }, [icon('volume'), 'Join']));
    }
    header.append(el('button', { class: 'icon-btn', 'data-tip': 'Pinned messages', onclick: () => window.BlaModals.pins(channel.id) }, [icon('pin')]));
    header.append(el('button', {
      class: 'icon-btn', 'data-tip': 'Search messages',
      onclick: () => window.BlaModals.searchMessages(channel.guild_id, channel.id),
    }, [icon('search')]));
    header.append(el('button', { class: 'icon-btn mobile-only', 'data-tip': 'Members', onclick: () => $('#members').classList.toggle('open') }, [icon('users')]));
    header.append(el('button', {
      class: 'icon-btn', 'data-tip': state.settings.showMembers ? 'Hide member list' : 'Show member list',
      onclick: () => { state.settings.showMembers = !state.settings.showMembers; S.saveSettings(); renderMemberList(); },
    }, [icon('users')]));
    header.append(el('button', { class: 'icon-btn', 'data-tip': 'Notification settings', onclick: () => window.BlaSettings.guildNotifications(channel.guild_id) }, [icon('bell')]));
    if (S.can(S.PERM.MANAGE_CHANNELS, channel.guild_id)) {
      header.append(el('button', { class: 'icon-btn', 'data-tip': 'Edit channel', onclick: () => window.BlaSettings.openChannel(channel.id) }, [icon('gear')]));
    }
  }

  window.BlaRender = {
    avatar, guildIcon, presenceOf, renderGuildRail, renderSidebar, renderMemberList, renderUserPanel,
    renderChannelHeader, renderFriendsView, renderDiscoveryView, guildCard, friendRow, STATUS_LABEL,
    channelItem, guildMenu, channelMenu, hasUnread, homeBadge, renderHomeSidebar,
  };
}());
