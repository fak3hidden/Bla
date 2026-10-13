/* Bla — modal framework and the dialogs the app uses everywhere. */
(function () {
  'use strict';
  const { el, clear, icon, $, showMenu, copy, toast, formatBytes, relative, debounce } = window.Bla;
  const S = window.BlaState;
  const state = S.state;
  const api = window.BlaApi;
  const R = window.BlaRender;

  let stack = [];

  /**
   * openModal({ title, size, body, footer, tabs, onClose }) -> controller
   * `body` may be a node or a function that receives the controller.
   */
  function openModal({ title, size = '', body, footer = null, tabs = null, onClose = null }) {
    const root = $('#modal-root');
    const bodyEl = el('div', { class: 'modal-body' });
    const footerEl = footer ? el('div', { class: 'modal-footer' }, footer) : null;
    const headerEl = el('div', { class: 'modal-header' }, [
      title ? el('h2', {}, title) : null,
      el('button', { class: 'icon-btn', onclick: () => controller.close() }, [icon('close')]),
    ]);
    const modal = el('div', { class: `modal ${size}` }, [headerEl]);
    if (tabs) modal.append(tabs);
    modal.append(bodyEl, footerEl);
    const backdrop = el('div', { class: 'modal-backdrop', onclick: () => controller.close() });

    const controller = {
      modal, bodyEl, footerEl, headerEl,
      close() {
        clear(root);
        root.classList.remove('open');
        stack = stack.filter((c) => c !== controller);
        onClose?.();
      },
      closeAll() {
        stack.forEach((c) => c.close());
      },
      setTitle(text) {
        headerEl.querySelector('h2').textContent = text;
      },
      setBody(node) {
        clear(bodyEl);
        bodyEl.append(node);
      },
      setFooter(nodes) {
        if (!footerEl) return;
        clear(footerEl);
        footerEl.append(...(Array.isArray(nodes) ? nodes : [nodes]));
      },
    };

    clear(root);
    root.append(backdrop, modal);
    root.classList.add('open');
    stack.push(controller);
    if (typeof body === 'function') bodyEl.append(body(controller));
    else if (body) bodyEl.append(body);
    return controller;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && stack.length) {
      event.stopPropagation();
      stack[stack.length - 1].close();
    }
  });

  function confirm({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }) {
    const controller = openModal({
      title,
      size: 'sm',
      body: el('p', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, body),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => { controller.close(); onCancel?.(); } }, cancelLabel),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          onclick: async () => {
            controller.close();
            await onConfirm?.();
          },
        }, confirmLabel),
      ],
    });
    return controller;
  }

  function prompt({ title, label, placeholder = '', value = '', confirmLabel = 'Save', multiline = false, onConfirm }) {
    const input = multiline
      ? el('textarea', { placeholder, value })
      : el('input', { type: 'text', placeholder, value });
    const controller = openModal({
      title,
      size: 'sm',
      body: el('label', { class: 'field' }, [el('span', {}, label), input]),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => controller.close() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const text = input.value.trim();
          if (!text) return;
          controller.close();
          await onConfirm?.(text);
        } }, confirmLabel),
      ],
    });
    setTimeout(() => input.focus(), 30);
    return controller;
  }

  /* ── create server ─────────────────────────────────────────────── */
  function createGuild() {
    const nameInput = el('input', { type: 'text', placeholder: 'My awesome server', maxlength: 100 });
    const descInput = el('textarea', { placeholder: 'What is this server about? (optional)', maxlength: 300, style: { minHeight: '70px' } });
    const preview = el('div', { class: 'row', style: { gap: '14px', alignItems: 'center' } });
    const updatePreview = () => {
      clear(preview).append(
        R.avatar({ id: 'preview', display_name: nameInput.value || 'S', avatar: null }, { size: 56, square: true }),
        el('div', {}, [
          el('div', { style: { fontWeight: 700 } }, nameInput.value || 'New server'),
          el('div', { class: 'faint', style: { fontSize: '13px' } }, 'All boost perks unlocked for free'),
        ]),
      );
    };
    nameInput.addEventListener('input', updatePreview);
    updatePreview();

    let iconUrl = null;
    const iconSlot = el('div', {
      class: 'row',
      style: { gap: '12px', alignItems: 'center', marginBottom: '16px' },
    });
    const fileInput = el('input', {
      type: 'file', accept: 'image/*', style: { display: 'none' },
      onchange: async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
          const data = await api.upload(file, 'guild_icon');
          iconUrl = data.url;
          toast('Icon uploaded', 'It will show up on your server.');
          updatePreview();
        } catch { /* handled */ }
      },
    });

    const controller = openModal({
      title: 'Create a server',
      size: 'md',
      body: el('div', {}, [
        el('div', { class: 'card', style: { background: 'var(--chat-alt)' } }, [
          el('div', { class: 'row', style: { gap: '10px', alignItems: 'center', marginBottom: '12px' } }, [
            icon('bolt'),
            el('div', {}, [
              el('div', { style: { fontWeight: 700 } }, 'Everything is included'),
              el('div', { class: 'faint', style: { fontSize: '13px' } },
                'No boost tiers, no paywalls: 384 kbps voice, 500 emoji, banners, vanity URLs and the soundboard are on from day one.'),
            ]),
          ]),
        ]),
        el('div', { class: 'field' }, [el('span', {}, 'Server name'), nameInput]),
        el('div', { class: 'field' }, [el('span', {}, 'Description'), descInput]),
        el('div', { class: 'field' }, [
          el('span', {}, 'Icon (optional)'),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn btn-outline', onclick: () => fileInput.click() }, [icon('upload'), 'Upload image']),
            fileInput,
          ]),
        ]),
        el('div', { class: 'field' }, [el('span', {}, 'Preview'), preview]),
      ]),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => controller.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const name = nameInput.value.trim();
            if (name.length < 2) return toast('Name too short', 'Server names need at least 2 characters.', 'error');
            try {
              const data = await api.createGuild({ name, description: descInput.value.trim(), icon: iconUrl });
              S.setGuild(data.guild);
              controller.close();
              await window.BlaApp.loadGuilds();
              window.BlaApp.openGuild(data.guild.id);
              toast('Server created', `${name} is ready. Invite some people!`);
            } catch { /* handled */ }
          },
        }, 'Create server'),
      ],
    });
    setTimeout(() => nameInput.focus(), 30);
    return controller;
  }

  /* ── channel create / edit helpers ─────────────────────────────── */
  function createChannel(guildId, parentId = null) {
    const guild = state.guilds.get(String(guildId));
    if (!guild) return;
    let type = 0;
    const nameInput = el('input', { type: 'text', placeholder: 'new-channel' });
    const topicInput = el('input', { type: 'text', placeholder: 'What is this channel for? (optional)' });
    const parentSelect = el('select', {}, [
      el('option', { value: '' }, 'No category'),
      ...guild.channels.filter((c) => c.type === 4).map((c) => el('option', {
        value: String(c.id), selected: String(parentId) === String(c.id),
      }, c.name)),
    ]);
    const typeRow = el('div', { class: 'row', style: { gap: '10px' } });
    const types = [
      { value: 0, label: 'Text', icon: 'hash', hint: 'Send messages, images and files' },
      { value: 2, label: 'Voice', icon: 'volume', hint: 'Hang out with voice, video and screen share' },
      { value: 4, label: 'Category', icon: 'chevron', hint: 'Group channels together' },
      { value: 15, label: 'Forum', icon: 'poll', hint: 'Post-based text channel' },
    ];
    const renderTypes = () => {
      clear(typeRow);
      for (const option of types) {
        typeRow.append(el('button', {
          class: `btn ${type === option.value ? 'btn-primary' : 'btn-outline'}`,
          title: option.hint,
          onclick: () => { type = option.value; nameInput.placeholder = type === 4 ? 'New Category' : 'new-channel'; renderTypes(); },
        }, [icon(option.icon), option.label]));
      }
    };
    renderTypes();

    const controller = openModal({
      title: `Create channel in ${guild.name}`,
      size: 'md',
      body: el('div', {}, [
        el('div', { class: 'field' }, [el('span', {}, 'Channel type'), typeRow]),
        el('div', { class: 'field' }, [el('span', {}, 'Name'), nameInput]),
        el('div', { class: 'field' }, [el('span', {}, 'Category'), parentSelect]),
        el('div', { class: 'field' }, [el('span', {}, 'Topic'), topicInput]),
      ]),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => controller.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const name = nameInput.value.trim() || (type === 4 ? 'New Category' : 'new-channel');
            try {
              const data = await api.createChannel(guildId, {
                name, type, topic: topicInput.value.trim(),
                parent_id: parentSelect.value || null,
              });
              S.setChannel(data.channel);
              controller.close();
              window.BlaApp.renderSidebar();
              if (data.channel.type !== 4) window.BlaApp.openChannel(data.channel.id, guildId);
            } catch { /* handled */ }
          },
        }, 'Create channel'),
      ],
    });
    setTimeout(() => nameInput.focus(), 30);
    return controller;
  }

  /* ── invites ───────────────────────────────────────────────────── */
  async function invite(guildId, channelId = null) {
    const guild = state.guilds.get(String(guildId));
    const codeSlot = el('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } });
    const settingsRow = el('div', { class: 'grid-2' }, [
      el('label', { class: 'field' }, [
        el('span', {}, 'Expires after'),
        el('select', {}, [
          el('option', { value: '1800' }, '30 minutes'),
          el('option', { value: '3600' }, '1 hour'),
          el('option', { value: '21600' }, '6 hours'),
          el('option', { value: '86400' }, '24 hours'),
          el('option', { value: '604800' }, '7 days'),
          el('option', { value: '0', selected: true }, 'Never'),
        ]),
      ]),
      el('label', { class: 'field' }, [
        el('span', {}, 'Max uses'),
        el('select', {}, [
          el('option', { value: '0', selected: true }, 'Unlimited'),
          el('option', { value: '1' }, '1 use'),
          el('option', { value: '5' }, '5 uses'),
          el('option', { value: '25' }, '25 uses'),
        ]),
      ]),
    ]);
    const existing = el('div', {});

    const createInvite = async () => {
      const [maxAge, maxUses] = [...settingsRow.querySelectorAll('select')].map((s) => s.value);
      const data = await api.createInvite(guildId, {
        channel_id: channelId || undefined, max_age: Number(maxAge), max_uses: Number(maxUses),
      });
      const url = `${location.origin}/invite/${data.code}`;
      clear(codeSlot).append(
        el('span', { class: 'invite-code', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, url),
        el('button', {
          class: 'btn btn-primary', onclick: async () => { await copy(url); toast('Invite copied', url); },
        }, [icon('copy'), 'Copy']),
      );
      await refreshExisting();
    };

    const refreshExisting = async () => {
      try {
        const data = await api.invites(guildId);
        clear(existing);
        if (!data.invites.length) return;
        existing.append(el('div', { class: 'section-title' }, `Active invites — ${data.invites.length}`));
        for (const item of data.invites) {
          const url = `${location.origin}/invite/${item.code}`;
          existing.append(el('div', { class: 'row between role-row' }, [
            el('div', {}, [
              el('div', { style: { fontWeight: 600 } }, item.code),
              el('div', { class: 'faint', style: { fontSize: '12.5px' } },
                `${item.uses}${item.max_uses ? `/${item.max_uses}` : ''} uses · ${item.expires_at ? `expires ${relative(item.expires_at)}` : 'never expires'}`),
            ]),
            el('div', { class: 'row', style: { gap: '6px' } }, [
              el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await copy(url); toast('Copied'); } }, [icon('copy')]),
              S.can(S.PERM.MANAGE_GUILD, guildId)
                ? el('button', {
                  class: 'btn btn-sm btn-outline',
                  onclick: async () => { await api.revokeInvite(guildId, item.code); await refreshExisting(); },
                }, [icon('trash')])
                : null,
            ]),
          ]));
        }
      } catch { /* needs Manage Server */ }
    };

    const vanity = guild?.vanity_url;
    openModal({
      title: `Invite people to ${guild?.name || 'server'}`,
      size: 'md',
      body: el('div', {}, [
        vanity ? el('div', { class: 'card' }, [
          el('h3', {}, 'Vanity URL'),
          el('p', { class: 'hint' }, 'Yours for free — no boost tier required.'),
          el('div', { class: 'row' }, [
            el('span', { class: 'invite-code', style: { flex: 1 } }, `${location.origin}/invite/${vanity}`),
            el('button', { class: 'btn btn-outline', onclick: async () => { const url = `${location.origin}/invite/${vanity}`; await copy(url); toast('Copied'); } }, [icon('copy')]),
          ]),
        ]) : null,
        el('div', { class: 'card' }, [
          el('h3', {}, 'Create a new invite link'),
          el('p', { class: 'hint' }, 'Anyone with this link can join. No account fees, no email needed.'),
          settingsRow,
          el('button', { class: 'btn btn-primary', onclick: () => createInvite().catch(() => {}) }, [icon('link'), 'Generate link']),
        ]),
        codeSlot,
        existing,
      ]),
    });
    await refreshExisting();
    if (!guild?.vanity_url) createInvite().catch(() => {});
  }

  /* ── user profile popout ───────────────────────────────────────── */
  async function userProfile(userId, guildId = null) {
    const user = S.user(userId);
    const body = el('div', {}, el('p', { class: 'faint' }, 'Loading profile…'));
    const controller = openModal({ title: 'Profile', size: 'md', body });

    try {
      const data = await api.userProfile(userId);
      const profile = data.user;
      S.rememberUser(profile);
      const status = R.presenceOf(userId);
      const color = guildId ? S.topRoleColor(guildId, userId) : (profile.accent_color || null);
      const banner = profile.banner || (color ? `#${color.toString(16).padStart(6, '0')}` : 'var(--accent)');
      const isMe = String(userId) === String(state.me?.id);
      const member = guildId ? S.memberOf(guildId, userId) : null;
      const roles = guildId ? S.rolesOf(guildId, userId) : [];

      const actions = [];
      if (!isMe) {
        actions.push(el('button', { class: 'btn btn-primary', onclick: () => { controller.close(); window.BlaApp.openDm(userId); } }, [icon('hash'), 'Message']));
        const isFriend = state.relationships.friends.some((f) => String(f.id) === String(userId));
        if (!isFriend) {
          actions.push(el('button', {
            class: 'btn btn-outline',
            onclick: async () => {
              await api.addFriend({ user_id: userId });
              state.relationships = await api.relationships();
              toast('Friend request sent');
              controller.close();
            },
          }, [icon('plus'), 'Add friend']));
        }
      }
      if (guildId && S.can(S.PERM.KICK_MEMBERS, guildId) && !isMe) {
        actions.push(el('button', {
          class: 'btn btn-outline', onclick: (event) => memberMenu(event, guildId, userId),
        }, [icon('more')]));
      }
      if (isMe) {
        actions.push(el('button', { class: 'btn btn-outline', onclick: () => { controller.close(); window.BlaSettings.openUser('profile'); } }, [icon('edit'), 'Edit profile']));
      }

      const card = el('div', { class: 'profile-card' }, [
        el('div', { class: 'profile-banner', style: { background: banner } }, profile.banner ? el('img', { src: profile.banner, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } }) : null),
        el('div', { class: 'profile-body' }, [
          el('div', { class: 'profile-avatar', style: { width: '92px', height: '92px', borderRadius: '50%', overflow: 'hidden', display: 'inline-block' } }, [R.avatar(profile, { size: 80, status })]),
          el('div', { class: 'profile-name' }, S.displayName(profile)),
          el('div', { class: 'profile-tag' }, `${profile.username}#${profile.discriminator}`),
          profile.bot ? el('span', { class: 'badge bot' }, 'BOT') : null,
          profile.admin ? el('span', { class: 'badge admin', style: { marginLeft: '6px' } }, 'INSTANCE ADMIN') : null,
          profile.pronouns ? el('div', { class: 'faint', style: { marginTop: '4px' } }, profile.pronouns) : null,
          profile.bio ? el('div', { class: 'profile-section' }, [el('h4', {}, 'About me'), el('div', {}, profile.bio)]) : null,
          roles.length ? el('div', { class: 'profile-section' }, [
            el('h4', {}, 'Roles'),
            el('div', { class: 'chip-row' }, roles.map((role) => el('span', { class: 'chip' }, [
              el('span', { class: 'dot', style: { background: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'var(--text-faint)' } }),
              role.name,
            ]))),
          ]) : null,
          member ? el('div', { class: 'profile-section' }, [
            el('h4', {}, 'Member since'),
            el('div', {}, new Date(member.joined_at).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })),
          ]) : null,
          el('div', { class: 'profile-section' }, [
            el('h4', {}, 'Mutual servers'),
            data.mutual_guilds?.length
              ? el('div', { class: 'chip-row' }, data.mutual_guilds.map((g) => el('span', {
                class: 'chip',
                onclick: () => { controller.close(); window.BlaApp.openGuild(g.id); },
              }, [
                R.guildIcon(g, 18),
                g.name,
              ])))
              : el('span', { class: 'faint' }, 'No servers in common yet.'),
          ]),
          el('div', { class: 'profile-section' }, [
            el('h4', {}, 'Member id'),
            el('div', { class: 'row' }, [
              el('span', { class: 'invite-code' }, profile.id),
              el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await copy(profile.id); toast('User id copied'); } }, [icon('copy')]),
            ]),
          ]),
        ]),
      ]);

      controller.setBody(card);
      if (actions.length) controller.setFooter(actions);
    } catch (err) {
      controller.setBody(el('p', { class: 'faint' }, err.message));
    }
    return controller;
  }

  /* ── member context menu ───────────────────────────────────────── */
  function memberMenu(event, guildId, userId) {
    const guild = state.guilds.get(String(guildId));
    const member = S.memberOf(guildId, userId);
    const isMe = String(userId) === String(state.me?.id);
    const canModerate = S.can(S.PERM.KICK_MEMBERS, guildId) || S.can(S.PERM.BAN_MEMBERS, guildId);
    const voice = state.voiceStates.get(String(userId));

    showMenu(event, [
      { label: 'Profile', icon: 'users', action: () => userProfile(userId, guildId) },
      { label: 'Message', icon: 'hash', action: () => window.BlaApp.openDm(userId) },
      !isMe ? { label: 'Add friend', icon: 'plus', action: async () => {
        try {
          await api.addFriend({ user_id: userId });
          state.relationships = await api.relationships();
          toast('Friend request sent');
        } catch { /* toast shown */ }
      } } : null,
      { type: 'separator' },
      { label: 'Copy user id', icon: 'copy', action: async () => { await copy(userId); toast('User id copied'); } },
      member?.nickname ? { label: 'Copy nickname', icon: 'copy', action: async () => { await copy(member.nickname); toast('Nickname copied'); } } : null,
      { type: 'separator' },
      !isMe && S.can(S.PERM.CHANGE_NICKNAME, guildId) ? {
        label: 'Change nickname', icon: 'edit', action: () => prompt({
          title: 'Change nickname',
          label: `Nickname for ${S.displayName(userId, guildId)}`,
          value: member?.nickname || '',
          onConfirm: async (text) => {
            await api.updateMember(guildId, userId, { nick: text });
            toast('Nickname updated');
          },
        }),
      } : null,
      !isMe && S.can(S.PERM.MANAGE_ROLES, guildId) ? {
        label: 'Add role', icon: 'shield', action: () => rolePicker(guildId, userId),
      } : null,
      voice && S.can(S.PERM.MUTE_MEMBERS, guildId) ? {
        label: voice.server_mute ? 'Unmute in voice' : 'Mute in voice', icon: 'micOff',
        action: async () => { await api.voiceModerate(userId, { guild_id: guildId, server_mute: !voice.server_mute }); },
      } : null,
      voice && S.can(S.PERM.MOVE_MEMBERS, guildId) ? {
        label: 'Move to channel', icon: 'volume', action: () => moveMemberModal(guildId, userId),
      } : null,
      voice && S.can(S.PERM.DEAFEN_MEMBERS, guildId) ? {
        label: voice.server_deaf ? 'Un-deafen' : 'Deafen in voice', icon: 'headphones',
        action: async () => { await api.voiceModerate(userId, { guild_id: guildId, server_deaf: !voice.server_deaf }); },
      } : null,
      canModerate && !isMe ? { type: 'separator' } : null,
      canModerate && !isMe && S.can(S.PERM.MODERATE_MEMBERS, guildId) ? {
        label: 'Timeout', icon: 'clock', action: () => timeoutModal(guildId, userId),
      } : null,
      canModerate && !isMe && S.can(S.PERM.KICK_MEMBERS, guildId) ? {
        label: 'Kick', icon: 'kick', danger: true, action: () => confirm({
          title: `Kick ${S.displayName(userId, guildId)}?`,
          body: 'They can rejoin with a new invite.',
          confirmLabel: 'Kick', danger: true,
          onConfirm: async () => { await api.kickMember(guildId, userId); toast('Member kicked'); },
        }),
      } : null,
      canModerate && !isMe && S.can(S.PERM.BAN_MEMBERS, guildId) ? {
        label: 'Ban', icon: 'ban', danger: true, action: () => prompt({
          title: `Ban ${S.displayName(userId, guildId)}?`,
          label: 'Reason (optional, shown in the audit log)',
          confirmLabel: 'Ban', placeholder: 'Why are you banning them?',
          onConfirm: async (reason) => { await api.ban(guildId, userId, reason); toast('Member banned', reason || ''); },
        }),
      } : null,
      !isMe && !canModerate ? { label: 'No moderation actions available', disabled: true } : null,
    ]);
  }

  function timeoutModal(guildId, userId) {
    const durations = [
      ['60 seconds', 60], ['5 minutes', 300], ['10 minutes', 600], ['1 hour', 3600],
      ['1 day', 86400], ['1 week', 604800], ['Remove timeout', 0],
    ];
    const controller = openModal({
      title: `Timeout ${S.displayName(userId, guildId)}`,
      size: 'sm',
      body: el('div', { class: 'chip-row' }, durations.map(([label, seconds]) => el('button', {
        class: 'chip',
        onclick: async () => {
          const until = seconds ? Date.now() + seconds * 1000 : null;
          try {
            await api.updateMember(guildId, userId, { communication_disabled_until: until });
            const updated = await api.member(guildId, userId);
            const guild = state.guilds.get(String(guildId));
            const index = guild?.members?.findIndex((m) => String(m.user_id) === String(userId)) ?? -1;
            if (guild && index >= 0) guild.members[index] = updated.member ?? updated;
            R.renderMemberList();
            toast(seconds ? `Timed out for ${label}` : 'Timeout removed', S.displayName(userId, guildId));
            controller.close();
          } catch {
            /* api layer already surfaced the error */
          }
        },
      }, label))),
    });
  }

  function moveMemberModal(guildId, userId) {
    const guild = state.guilds.get(String(guildId));
    const channels = guild.channels.filter((c) => c.type === 2);
    openModal({
      title: `Move ${S.displayName(userId, guildId)}`,
      size: 'sm',
      body: el('div', {}, channels.map((channel) => el('button', {
        class: 'btn btn-outline btn-block', style: { marginBottom: '8px', justifyContent: 'flex-start' },
        onclick: async () => { await api.voiceModerate(userId, { guild_id: guildId, channel_id: channel.id }); toast('Moved', channel.name); },
      }, [icon('volume'), channel.name]))),
    });
  }

  async function rolePicker(guildId, userId) {
    const guild = state.guilds.get(String(guildId));
    const member = S.memberOf(guildId, userId);
    const current = new Set((member?.roles || []).map(String));
    const list = el('div', {});
    for (const role of guild.roles.filter((r) => !r.is_everyone).sort((a, b) => b.position - a.position)) {
      const checked = current.has(String(role.id));
      list.append(el('label', { class: 'permission-row', style: { cursor: 'pointer' } }, [
        el('input', {
          type: 'checkbox', checked,
          onchange: async (event) => {
            if (event.target.checked) await api.addRole(guildId, userId, role.id);
            else await api.removeRole(guildId, userId, role.id);
            const fresh = await api.member(guildId, userId);
            const index = guild.members.findIndex((m) => String(m.user_id) === String(userId));
            if (index >= 0 && fresh.member) guild.members[index] = fresh.member;
            S.emit('members:update', guildId);
          },
        }),
        el('div', { class: 'perm-text' }, [
          el('div', { class: 'perm-name', style: { color: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : undefined } }, role.name),
          el('div', { class: 'perm-desc' }, `${(member?.roles || []).length ? '' : ''}${role.position === 0 ? 'Base role' : `Position ${role.position}`}`),
        ]),
      ]));
    }
    if (S.can(S.PERM.MANAGE_ROLES, guildId)) {
      list.append(el('button', {
        class: 'btn btn-outline', style: { marginTop: '12px' },
        onclick: async () => {
          const name = window.prompt('New role name');
          if (!name) return;
          await api.createRole(guildId, { name, permissions: '0' });
          rolePicker(guildId, userId);
        },
      }, [icon('plus'), 'Create role']));
    }
    openModal({ title: `Roles for ${S.displayName(userId, guildId)}`, size: 'sm', body: list });
  }

  /* ── pins, search, quick switcher ──────────────────────────────── */
  async function pins(channelId) {
    const body = el('div', {}, el('p', { class: 'faint' }, 'Loading pins…'));
    const controller = openModal({ title: 'Pinned messages', size: 'md', body });
    try {
      const data = await api.pins(channelId);
      clear(body);
      if (!data.pins.length) {
        body.append(el('div', { class: 'empty-state' }, [icon('pin'), el('h2', {}, 'No pins yet'), el('p', {}, 'Hover a message and use the pin button to keep it here.')]));
        return;
      }
      for (const message of data.pins) {
        body.append(el('div', { class: 'card' }, [
          el('div', { class: 'row between' }, [
            el('div', { class: 'row', style: { gap: '8px' } }, [
              R.avatar(message.author, { size: 24 }),
              el('b', {}, S.displayName(message.author)),
              el('span', { class: 'faint' }, window.Bla.formatDate(message.timestamp)),
            ]),
            el('button', {
              class: 'btn btn-sm btn-outline',
              onclick: async () => { await api.unpin(channelId, message.id); controller.close(); pins(channelId); },
            }, 'Unpin'),
          ]),
          el('div', { style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, message.content || '(attachment)'),
        ]));
      }
    } catch (err) {
      clear(body).append(el('p', { class: 'faint' }, err.message));
    }
  }

  async function searchMessages(guildId, channelId = null) {
    const input = el('input', { type: 'search', placeholder: 'Search messages…' });
    const results = el('div', {});
    const controller = openModal({
      title: 'Search',
      size: 'lg',
      body: el('div', {}, [input, el('div', { style: { marginTop: '14px' } }, results)]),
      footer: [
        el('label', { class: 'row', style: { gap: '8px' } }, [
          el('input', { type: 'checkbox', id: 'search-mentions' }),
          el('span', {}, 'Only messages that mention me'),
        ]),
        el('label', { class: 'row', style: { gap: '8px' } }, [
          el('input', { type: 'checkbox', id: 'search-pinned' }),
          el('span', {}, 'Only pinned'),
        ]),
      ],
    });
    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) { clear(results).append(el('p', { class: 'faint' }, 'Type at least two characters.')); return; }
      clear(results).append(el('p', { class: 'faint' }, 'Searching…'));
      const params = { q, limit: 25 };
      if (channelId) params.channel_id = channelId;
      if ($('#search-mentions')?.checked) params.mentions_me = 1;
      if ($('#search-pinned')?.checked) params.pinned = 1;
      try {
        const data = await api.searchMessages(guildId, params);
        clear(results);
        if (!data.messages.length) {
          results.append(el('p', { class: 'faint' }, 'No matches.'));
          return;
        }
        for (const message of data.messages) {
          const channel = state.channels.get(String(message.channel_id));
          results.append(el('div', {
            class: 'card', style: { cursor: 'pointer' },
            onclick: () => { controller.close(); window.BlaApp.openChannel(message.channel_id, guildId, message.id); },
          }, [
            el('div', { class: 'row between' }, [
              el('div', { class: 'row', style: { gap: '8px' } }, [
                R.avatar(message.author, { size: 22 }),
                el('b', {}, S.displayName(message.author)),
                el('span', { class: 'faint' }, `#${channel?.name || 'channel'}`),
              ]),
              el('span', { class: 'faint' }, window.Bla.formatDate(message.timestamp)),
            ]),
            el('div', { style: { marginTop: '6px' } }, window.BlaMarkdown.plain(message.content, 220)),
          ]));
        }
      } catch (err) {
        clear(results).append(el('p', { class: 'faint' }, err.message));
      }
    };
    input.addEventListener('input', debounce(run, 350));
    $('#search-mentions', controller.modal)?.addEventListener('change', run);
    $('#search-pinned', controller.modal)?.addEventListener('change', run);
    setTimeout(() => input.focus(), 40);
    run();
  }

  async function quickSwitcher() {
    const input = el('input', { type: 'search', placeholder: 'Jump to a server, channel or person…' });
    const results = el('div', { style: { marginTop: '12px', maxHeight: '46vh', overflowY: 'auto' } });
    const controller = openModal({ title: 'Quick switcher', size: 'md', body: el('div', {}, [input, results]) });

    const render = async (q = '') => {
      clear(results);
      const query = q.toLowerCase();
      const guildHits = [...state.guilds.values()]
        .filter((g) => !query || g.name.toLowerCase().includes(query)).slice(0, 6);
      const channelHits = [...state.channels.values()]
        .filter((c) => c.guild_id && (!query || c.name?.toLowerCase().includes(query))).slice(0, 10);
      const userHits = query
        ? (await api.users(query, 8)).users
        : state.relationships.friends.slice(0, 8);

      const section = (title, nodes) => {
        if (!nodes.length) return;
        results.append(el('div', { class: 'section-title' }, title));
        nodes.forEach((node) => results.append(node));
      };

      section('Servers', guildHits.map((guild) => el('button', {
        class: 'menu-item',
        onclick: () => { controller.close(); window.BlaApp.openGuild(guild.id); },
      }, [R.guildIcon(guild, 22), guild.name])));

      section('Channels', channelHits.map((channel) => {
        const guild = state.guilds.get(String(channel.guild_id));
        return el('button', {
          class: 'menu-item',
          onclick: () => { controller.close(); window.BlaApp.openChannel(channel.id, channel.guild_id); },
        }, [icon(channel.type === 2 ? 'volume' : 'hash'), `${guild?.name || ''} › ${channel.name}`]);
      }));

      section('People', userHits.map((user) => el('button', {
        class: 'menu-item',
        onclick: () => { controller.close(); userProfile(user.id); },
      }, [R.avatar(user, { size: 22, status: R.presenceOf(user.id) }), S.displayName(user)])));
    };

    input.addEventListener('input', debounce(() => render(input.value), 200));
    setTimeout(() => input.focus(), 40);
    await render();
  }

  /* ── group DMs ─────────────────────────────────────────────────── */
  function newGroupDm() {
    const selected = new Map();
    const chips = el('div', { class: 'chip-row', style: { marginBottom: '10px' } });
    const input = el('input', { type: 'search', placeholder: 'Search people…' });
    const results = el('div', { style: { maxHeight: '240px', overflowY: 'auto' } });
    const renderChips = () => {
      clear(chips);
      for (const [id, user] of selected) {
        chips.append(el('span', { class: 'chip', onclick: () => { selected.delete(id); renderChips(); } }, [
          R.avatar(user, { size: 18 }), S.displayName(user), icon('close'),
        ]));
      }
    };
    const search = async (q) => {
      const data = await api.users(q, 12);
      clear(results);
      for (const user of data.users) {
        if (String(user.id) === String(state.me?.id)) continue;
        results.append(el('button', {
          class: 'menu-item',
          onclick: () => { selected.set(String(user.id), user); renderChips(); },
        }, [R.avatar(user, { size: 24 }), S.displayName(user), el('span', { class: 'menu-hint' }, user.username)]));
      }
    };
    input.addEventListener('input', debounce(() => search(input.value.trim()), 250));

    const controller = openModal({
      title: 'New group conversation',
      size: 'md',
      body: el('div', {}, [chips, input, results]),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => controller.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!selected.size) return toast('Pick at least one person', '', 'error');
            const data = await api.openDm([...selected.keys()]);
            controller.close();
            if (!state.dmChannels.some((c) => String(c.id) === String(data.channel.id))) state.dmChannels.push(data.channel);
            window.BlaApp.openChannel(data.channel.id, null);
          },
        }, 'Create'),
      ],
    });
    search('');
  }

  function addToGroup(channelId) {
    const input = el('input', { type: 'search', placeholder: 'Search people…' });
    const results = el('div', { style: { maxHeight: '260px', overflowY: 'auto' } });
    const search = async (q) => {
      const data = await api.users(q, 12);
      clear(results);
      for (const user of data.users) {
        results.append(el('button', {
          class: 'menu-item',
          onclick: async () => {
            await api.addRecipient(channelId, user.id);
            toast('Added', S.displayName(user));
            controller.close();
          },
        }, [R.avatar(user, { size: 24 }), S.displayName(user)]));
      }
    };
    input.addEventListener('input', debounce(() => search(input.value.trim()), 250));
    const controller = openModal({ title: 'Add people', size: 'sm', body: el('div', {}, [input, results]) });
    search('');
  }

  /* ── guild preview (discovery) ─────────────────────────────────── */
  async function guildPreview(guildId) {
    const body = el('div', {}, el('p', { class: 'faint' }, 'Loading…'));
    const controller = openModal({ title: 'Server preview', size: 'md', body });
    try {
      const data = await api.discoveryPreview(guildId);
      clear(body);
      body.append(el('div', { class: 'card' }, [
        el('div', { class: 'row', style: { gap: '14px' } }, [
          R.avatar({ id: data.id, avatar: data.icon, display_name: data.name }, { size: 64, square: true }),
          el('div', {}, [
            el('h3', { style: { margin: 0 } }, data.name),
            el('div', { class: 'faint' }, `${data.member_count} members · all perks free`),
          ]),
        ]),
        data.description ? el('p', { style: { marginTop: '14px' } }, data.description) : null,
        el('div', { class: 'chip-row' }, (data.tags || []).map((tag) => el('span', { class: 'tag-pill' }, `#${tag}`))),
      ]));
      body.append(el('div', { class: 'section-title' }, `Members — ${data.sample_members?.length || 0} shown`));
      body.append(el('div', { class: 'chip-row' }, (data.sample_members || []).map((member) => el('span', { class: 'chip' }, [
        R.avatar(member, { size: 18 }), S.displayName(member),
      ]))));
      body.append(el('div', { class: 'section-title' }, 'Channels'));
      body.append(el('div', { class: 'row wrap', style: { gap: '8px', padding: '0 12px' } },
        (data.channels || []).map((channel) => el('span', { class: 'tag-pill' }, `#${channel.name}`))));
      controller.setFooter([
        data.already_member
          ? el('button', { class: 'btn btn-primary', onclick: () => { controller.close(); window.BlaApp.openGuild(guildId); } }, 'Open server')
          : el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              await api.joinDiscovery(guildId);
              controller.close();
              await window.BlaApp.loadGuilds();
              window.BlaApp.openGuild(guildId);
              toast('Welcome!', 'You joined the server.');
            },
          }, [icon('plus'), 'Join server']),
      ]);
    } catch (err) {
      clear(body).append(el('p', { class: 'faint' }, err.message));
    }
  }

  function confirmLeaveOrDelete(guild) {
    const isOwner = String(guild.owner_id) === String(state.me?.id);
    if (isOwner) {
      prompt({
        title: `Delete ${guild.name}?`,
        label: `This permanently deletes the server and every message. Type the server name to confirm.`,
        placeholder: guild.name,
        confirmLabel: 'Delete server forever',
        onConfirm: async (text) => {
          if (text !== guild.name) return toast('Name did not match', 'Nothing was deleted.', 'error');
          await api.deleteGuild(guild.id);
          S.removeGuild(guild.id);
          toast('Server deleted', guild.name);
          window.BlaApp.openHome('friends');
        },
      });
      return;
    }
    confirm({
      title: `Leave ${guild.name}?`,
      body: 'You will need a new invite to come back.',
      confirmLabel: 'Leave server',
      danger: true,
      onConfirm: async () => {
        await api.leaveGuild(guild.id);
        S.removeGuild(guild.id);
        window.BlaApp.openHome('friends');
      },
    });
  }

  /* ── emoji picker ──────────────────────────────────────────────── */
  function emojiPicker(event, onPick) {
    const categories = window.Bla.emojiCategories();
    const search = el('input', { type: 'search', placeholder: 'Search emoji…' });
    const grid = el('div', { class: 'cats' });

    const renderAll = (filter = '') => {
      clear(grid);
      const query = filter.toLowerCase();
      const guild = S.currentGuild();
      if (!query && guild?.emojis?.length) {
        grid.append(el('div', { class: 'cat-label' }, `${guild.name} emoji`));
        for (const emoji of guild.emojis) {
          grid.append(el('button', {
            title: `:${emoji.name}:`,
            onclick: () => { onPick(`<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`); window.Bla.closeMenu(); },
          }, el('img', { src: emoji.url, alt: emoji.name })));
        }
      }
      for (const [name, list] of categories) {
        const matches = query ? list.filter((e) => e.includes(query)) : list;
        if (!matches.length) continue;
        grid.append(el('div', { class: 'cat-label' }, name));
        for (const emoji of matches) {
          grid.append(el('button', { onclick: () => { onPick(emoji); window.Bla.closeMenu(); } }, emoji));
        }
      }
    };
    search.addEventListener('input', () => renderAll(search.value));
    renderAll();

    const root = $('#menu-root');
    window.Bla.closeMenu();
    const menu = el('div', { class: 'menu emoji-picker' }, [
      el('div', { class: 'search' }, search),
      grid,
    ]);
    root.innerHTML = '';
    root.append(el('div', { class: 'modal-backdrop', onclick: () => window.Bla.closeMenu() }), menu);
    root.classList.add('open');
    const width = 340;
    menu.style.left = `${Math.min(Math.max(event.clientX - width, 8), window.innerWidth - width - 8)}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY - 300, window.innerHeight - 420))}px`;
    setTimeout(() => search.focus(), 30);
  }

  window.BlaModals = {
    openModal, confirm, prompt, createGuild, createChannel, invite, userProfile, memberMenu,
    pins, searchMessages, quickSwitcher, newGroupDm, addToGroup, guildPreview, confirmLeaveOrDelete,
    emojiPicker, rolePicker, timeoutModal, moveMemberModal,
  };
}());
