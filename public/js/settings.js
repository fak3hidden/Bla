/* Bla — user settings, server settings, channel settings and notification prefs. */
(function () {
  'use strict';
  const { el, clear, icon, $, toast, showMenu, copy, formatBytes, relative, initials } = window.Bla;
  const S = window.BlaState;
  const state = S.state;
  const api = window.BlaApi;
  const R = window.BlaRender;
  const M = window.BlaModals;

  function tabsLayout(tabs, initial, renderTab) {
    const nav = el('div', { class: 'settings-nav' });
    const content = el('div', { class: 'settings-content' });
    let active = initial;

    const select = (key) => {
      active = key;
      [...nav.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b.dataset.key === key));
      clear(content).append(renderTab(key, () => select(key)));
    };
    for (const tab of tabs) {
      if (tab.type === 'separator') { nav.append(el('div', { class: 'nav-sep' })); continue; }
      nav.append(el('button', {
        class: 'menu-item', dataset: { key: tab.key },
        onclick: () => select(tab.key),
      }, [tab.icon ? icon(tab.icon, 'icon') : null, tab.label]));
    }
    const layout = el('div', { class: 'settings-layout' }, [nav, content]);
    setTimeout(() => select(initial), 0);
    return layout;
  }

  /* ── user settings ─────────────────────────────────────────────── */
  function openUser(section = 'profile') {
    const modal = M.openModal({ title: 'User settings', size: 'wide', body: el('div', {}, 'Loading…') });
    modal.setBody(tabsLayout([
      { key: 'profile', label: 'My Profile', icon: 'users' },
      { key: 'account', label: 'Account & Security', icon: 'shield' },
      { key: 'appearance', label: 'Appearance', icon: 'eye' },
      { key: 'notifications', label: 'Notifications', icon: 'bell' },
      { key: 'voice', label: 'Voice & Video', icon: 'volume' },
      { key: 'status', label: 'Status', icon: 'smile' },
      { type: 'separator' },
      { key: 'about', label: 'About Bla', icon: 'bolt' },
    ], section, (key, reselect) => {
      if (key === 'profile') return profileTab();
      if (key === 'account') return accountTab(modal);
      if (key === 'appearance') return appearanceTab();
      if (key === 'notifications') return notificationsTab();
      if (key === 'voice') return voiceTab();
      if (key === 'status') return statusTab();
      return aboutTab();
    }));
  }

  function profileTab() {
    const me = state.me;
    let avatarUrl = me.avatar;
    let bannerUrl = me.banner;
    const preview = el('div', { class: 'profile-card', style: { marginBottom: '16px' } });
    const renderPreview = () => {
      clear(preview).append(
        el('div', { class: 'profile-banner', style: { background: bannerUrl ? `center/cover url(${bannerUrl})` : (accent.value || 'var(--accent)') } }),
        el('div', { class: 'profile-body' }, [
          el('div', { class: 'profile-avatar', style: { width: '84px', height: '84px', borderRadius: '50%', overflow: 'hidden' } },
            [R.avatar({ ...me, avatar: avatarUrl }, { size: 72 })]),
          el('div', { class: 'profile-name' }, displayName.value || me.username),
          el('div', { class: 'profile-tag' }, `${me.username}#${me.discriminator}`),
          el('div', { class: 'faint', style: { marginTop: '8px' } }, bio.value || 'No bio yet.'),
        ]),
      );
    };

    const displayName = el('input', { type: 'text', value: me.display_name || '', maxlength: 32 });
    const bio = el('textarea', { maxlength: 512, style: { minHeight: '70px' } }, me.bio || '');
    const pronouns = el('input', { type: 'text', value: me.pronouns || '', maxlength: 32, placeholder: 'they/them' });
    const accent = el('input', {
      type: 'color',
      value: me.accent_color ? `#${me.accent_color.toString(16).padStart(6, '0')}` : '#2ec4a6',
    });

    const uploadButton = (kind, label, onDone) => {
      const input = el('input', {
        type: 'file', accept: 'image/*', style: { display: 'none' },
        onchange: async (event) => {
          const file = event.target.files[0];
          if (!file) return;
          try {
            const data = await api.upload(file, kind);
            onDone(data.url);
            renderPreview();
            toast(`${label} uploaded`);
          } catch { /* handled */ }
        },
      });
      return el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-outline', onclick: () => input.click() }, [icon('upload'), `Upload ${label.toLowerCase()}`]),
        input,
        el('button', {
          class: 'btn btn-ghost',
          onclick: () => { onDone(null); renderPreview(); },
        }, 'Remove'),
      ]);
    };

    displayName.addEventListener('input', renderPreview);
    bio.addEventListener('input', renderPreview);
    accent.addEventListener('input', renderPreview);
    setTimeout(renderPreview, 0);

    const save = el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        try {
          const data = await api.updateMe({
            display_name: displayName.value,
            bio: bio.value,
            pronouns: pronouns.value,
            accent_color: accent.value,
            avatar: avatarUrl,
            banner: bannerUrl,
          });
          state.me = { ...state.me, ...data.user };
          S.rememberUser(state.me);
          R.renderUserPanel();
          toast('Profile saved', 'Looking good.');
        } catch { /* handled */ }
      },
    }, 'Save changes');

    return el('div', {}, [
      preview,
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'field' }, [el('span', {}, 'Avatar'), uploadButton('avatar', 'Avatar', (url) => { avatarUrl = url; })]),
        el('div', { class: 'field' }, [el('span', {}, 'Banner (free for everyone)'), uploadButton('user_banner', 'Banner', (url) => { bannerUrl = url; })]),
      ]),
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'field' }, [el('span', {}, 'Display name'), displayName]),
        el('div', { class: 'field' }, [el('span', {}, 'Pronouns'), pronouns]),
      ]),
      el('div', { class: 'field' }, [el('span', {}, 'Accent colour'), accent]),
      el('div', { class: 'field' }, [el('span', {}, 'About me'), bio]),
      save,
    ]);
  }

  function accountTab(modal) {
    const usernameRow = el('div', { class: 'card' }, [
      el('h3', {}, 'Username'),
      el('p', { class: 'hint' }, 'Usernames are permanent on this instance. Ask the instance admin if you need a change.'),
      el('div', { class: 'row' }, [
        el('span', { class: 'invite-code' }, `${state.me.username}#${state.me.discriminator}`),
        el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await copy(state.me.username); toast('Copied'); } }, [icon('copy')]),
      ]),
    ]);

    const currentPw = el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    const newPw = el('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
    const confirmPw = el('input', { type: 'password', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    const passwordCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Change password'),
      el('p', { class: 'hint' }, 'Changing your password signs out every other device.'),
      el('div', { class: 'field' }, [el('span', {}, 'Current password'), currentPw]),
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'field' }, [el('span', {}, 'New password'), newPw]),
        el('div', { class: 'field' }, [el('span', {}, 'Confirm'), confirmPw]),
      ]),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (newPw.value !== confirmPw.value) return toast('Passwords do not match', '', 'error');
          try {
            await api.changePassword({ current_password: currentPw.value, new_password: newPw.value });
            currentPw.value = ''; newPw.value = ''; confirmPw.value = '';
            toast('Password updated', 'Other sessions were signed out.');
          } catch { /* handled */ }
        },
      }, 'Update password'),
    ]);

    const sessionsCard = el('div', { class: 'card' }, [el('h3', {}, 'Sessions'), el('p', { class: 'hint' }, 'Loading…')]);
    api.sessions().then((data) => {
      clear(sessionsCard).append(el('h3', {}, 'Sessions'), el('p', { class: 'hint' }, 'Every device holding a signed-in cookie.'));
      for (const session of data.sessions) {
        sessionsCard.append(el('div', { class: 'row between role-row' }, [
          el('div', {}, [
            el('div', { style: { fontWeight: 600 } }, session.current ? 'This device' : (session.user_agent || 'Unknown device').slice(0, 60)),
            el('div', { class: 'faint', style: { fontSize: '12.5px' } },
              `Last active ${relative(session.last_used)}${session.ip ? ` · ${session.ip}` : ''}`),
          ]),
          el('button', {
            class: 'btn btn-sm btn-outline',
            onclick: async (event) => {
              await api.revokeSession(session.id);
              event.target.closest('.role-row').remove();
              toast('Session revoked');
            },
          }, 'Revoke'),
        ]));
      }
    }).catch(() => {});

    const dangerCard = el('div', { class: 'card danger' }, [
      el('h3', {}, 'Delete account'),
      el('p', { class: 'hint' }, 'Deletes your account, messages stay but lose their author. Owned servers are transferred to the next member.'),
      el('button', {
        class: 'btn btn-danger',
        onclick: () => M.prompt({
          title: 'Delete your account',
          label: 'Type your password to confirm',
          confirmLabel: 'Delete everything',
          onConfirm: async (password) => {
            try {
              await api.deleteAccount({ password });
              location.reload();
            } catch { /* handled */ }
          },
        }),
      }, 'Delete my account'),
    ]);

    return el('div', {}, [usernameRow, passwordCard, sessionsCard, dangerCard]);
  }

  function appearanceTab() {
    const toggle = (label, key, hint) => el('label', { class: 'switch' }, [
      el('span', {}, [el('span', { class: 'switch-label' }, label), hint ? el('small', {}, hint) : null]),
      el('input', {
        type: 'checkbox', checked: !!state.settings[key],
        onchange: (event) => { state.settings[key] = event.target.checked; S.saveSettings(); applyAppearance(); },
      }),
    ]);
    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Appearance'),
        el('p', { class: 'hint' }, 'Everything is stored locally in your browser.'),
        toggle('Compact message list', 'compact', 'Denser spacing, more messages per screen.'),
        toggle('Show member list', 'showMembers', 'The right-hand column of server members.'),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Message display'),
        el('div', { class: 'row wrap', style: { gap: '8px' } }, [
          el('button', { class: 'btn btn-outline', onclick: () => { document.documentElement.style.setProperty('--radius', '4px'); toast('Squared corners'); } }, 'Squared corners'),
          el('button', { class: 'btn btn-outline', onclick: () => { document.documentElement.style.setProperty('--radius', '8px'); toast('Rounded corners'); } }, 'Rounded corners'),
        ]),
      ]),
    ]);
  }

  function applyAppearance() {
    document.body.classList.toggle('compact', !!state.settings.compact);
    R.renderMemberList();
  }

  function notificationsTab() {
    const requestPermission = async () => {
      if (!('Notification' in window)) return toast('Not supported', 'This browser has no notifications API.', 'error');
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        state.settings.desktopNotifications = true;
        S.saveSettings();
        new Notification('Bla notifications are on', { body: 'You will hear about mentions right away.' });
        toast('Notifications enabled');
      } else {
        toast('Notifications blocked', 'Your browser said no. You can change that in site settings.', 'error');
      }
    };
    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Desktop notifications'),
        el('p', { class: 'hint' }, 'Bla only notifies you for mentions, DMs and calls — never for every message.'),
        el('label', { class: 'switch' }, [
          el('span', { class: 'switch-label' }, 'Enable desktop notifications'),
          el('input', {
            type: 'checkbox', checked: !!state.settings.desktopNotifications,
            onchange: (event) => {
              if (event.target.checked) requestPermission();
              else { state.settings.desktopNotifications = false; S.saveSettings(); }
            },
          }),
        ]),
        el('label', { class: 'switch' }, [
          el('span', {}, [el('span', { class: 'switch-label' }, 'Notification sounds'), el('small', {}, 'A quiet blip for mentions.')]),
          el('input', {
            type: 'checkbox', checked: !!state.settings.sounds,
            onchange: (event) => { state.settings.sounds = event.target.checked; S.saveSettings(); },
          }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Per-server overrides'),
        el('p', { class: 'hint' }, 'Mute noisy servers without leaving them.'),
        ...[...state.guilds.values()].map((guild) => {
          const muted = state.guildReadStates.get(String(guild.id))?.muted;
          return el('div', { class: 'row between role-row' }, [
            el('div', { class: 'row', style: { gap: '10px' } }, [R.guildIcon(guild, 26), guild.name]),
            el('button', {
              class: 'btn btn-sm btn-outline',
              onclick: async () => {
                await api.updateMember(guild.id, state.me.id, {}).catch(() => {});
                state.guildReadStates.set(String(guild.id), { muted: !muted });
                toast(muted ? 'Unmuted' : 'Muted', guild.name);
              },
            }, muted ? 'Unmute' : 'Mute'),
          ]);
        }),
      ]),
    ]);
  }

  function voiceTab() {
    const card = el('div', { class: 'card' }, [
      el('h3', {}, 'Voice & Video'),
      el('p', { class: 'hint' }, 'Peer-to-peer WebRTC. Audio and video go straight between members; the server only relays connection details.'),
    ]);
    const devices = el('div', {});
    card.append(devices);

    (async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const pick = (kind, label) => {
          const options = list.filter((d) => d.kind === kind);
          if (!options.length) return null;
          return el('div', { class: 'field' }, [
            el('span', {}, label),
            el('select', {
              onchange: (event) => { state.settings[kind === 'audioinput' ? 'inputDevice' : 'outputDevice'] = event.target.value; S.saveSettings(); },
            }, options.map((device) => el('option', {
              value: device.deviceId,
              selected: state.settings[kind === 'audioinput' ? 'inputDevice' : 'outputDevice'] === device.deviceId,
            }, device.label || `${label} ${device.deviceId.slice(0, 6)}`))),
          ]);
        };
        devices.append(pick('audioinput', 'Microphone'), pick('audiooutput', 'Speaker'));
      } catch { /* permission not granted yet */ }
    })();

    card.append(
      el('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } }, [
        el('button', {
          class: 'btn btn-outline',
          onclick: async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              const audio = new Audio();
              audio.srcObject = stream;
              audio.play();
              toast('Testing microphone', 'Speak and you should hear yourself. Click again to stop.');
              setTimeout(() => { stream.getTracks().forEach((t) => t.stop()); audio.pause(); }, 5000);
            } catch { toast('Microphone blocked', 'Allow microphone access first.', 'error'); }
          },
        }, [icon('mic'), 'Test microphone']),
        el('button', { class: 'btn btn-outline', onclick: () => toast('Voice works in every browser with WebRTC', `STUN: ${state.config?.stun_servers?.join(', ') || 'default'}`) }, [icon('globe'), 'Connection info']),
      ]),
      el('p', { class: 'hint', style: { marginTop: '12px' } },
        'Behind a strict NAT or a corporate firewall? Add a TURN server to the BLA_STUN_URLS environment variable and restart Bla.'),
    );
    return card;
  }

  function statusTab() {
    const statuses = [
      ['online', 'Online', 'var(--online)'],
      ['idle', 'Idle', 'var(--idle)'],
      ['dnd', 'Do Not Disturb', 'var(--dnd)'],
      ['invisible', 'Invisible', 'var(--text-faint)'],
    ];
    const text = el('input', { type: 'text', maxlength: 128, placeholder: 'What are you up to?', value: S.presence(state.me.id).custom_status?.text || '' });
    const emojiInput = el('input', { type: 'text', maxlength: 8, placeholder: '😴', value: S.presence(state.me.id).custom_status?.emoji || '' });
    const current = S.presence(state.me.id).status || 'online';

    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Status'),
        el('div', { class: 'chip-row' }, statuses.map(([key, label, color]) => el('button', {
          class: `chip ${current === key ? 'btn-primary' : ''}`,
          onclick: () => {
            window.BlaGateway.updatePresence({ status: key });
            R.renderUserPanel();
            toast('Status set', label);
          },
        }, [el('span', { class: 'dot', style: { background: color } }), label]))),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Custom status'),
        el('p', { class: 'hint' }, 'Shown next to your name everywhere on this instance.'),
        el('div', { class: 'row', style: { gap: '10px' } }, [
          el('div', { style: { width: '70px' } }, emojiInput),
          el('div', { style: { flex: 1 } }, text),
        ]),
        el('div', { class: 'row', style: { marginTop: '12px' } }, [
          el('button', {
            class: 'btn btn-primary',
            onclick: () => {
              window.BlaGateway.updatePresence({ custom_status: { text: text.value, emoji: emojiInput.value } });
              toast('Custom status set');
            },
          }, 'Set status'),
          el('button', {
            class: 'btn btn-ghost',
            onclick: () => {
              text.value = '';
              emojiInput.value = '';
              window.BlaGateway.updatePresence({ custom_status: null });
              toast('Custom status cleared');
            },
          }, 'Clear'),
        ]),
      ]),
    ]);
  }

  function aboutTab() {
    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('div', { class: 'row', style: { gap: '16px' } }, [
          el('img', { src: '/icons/logo.svg', style: { width: '64px', height: '64px' } }),
          el('div', {}, [
            el('h3', { style: { margin: 0 } }, 'Bla'),
            el('p', { class: 'hint', style: { margin: 0 } }, 'A chat platform you host yourself. No email, no subscriptions, no boost tiers.'),
          ]),
        ]),
        el('div', { class: 'profile-section' }, [
          el('h4', {}, 'This instance'),
          el('div', { class: 'chip-row' }, [
            el('span', { class: 'tag-pill' }, `Server: ${state.config?.server_name || 'Bla'}`),
            el('span', { class: 'tag-pill' }, `Accounts: ${state.config?.user_count ?? '?'}`),
            el('span', { class: 'tag-pill' }, `Uploads up to ${state.config?.max_upload_mb} MB`),
            el('span', { class: 'tag-pill' }, `Voice: ${state.config?.voice_enabled ? 'on' : 'off'}`),
          ]),
        ]),
        el('div', { class: 'profile-section' }, [
          el('h4', {}, 'Everything unlocked, for free'),
          el('div', { class: 'chip-row' }, [
            '384 kbps voice', 'HD screen share', 'Animated emoji', '500 emoji per server',
            'Server banner', 'Vanity URL', 'Soundboard', 'Unlimited stickers', 'Custom roles',
          ].map((feature) => el('span', { class: 'tag-pill' }, feature))),
        ]),
      ]),
      state.me?.admin ? el('div', { class: 'card' }, [
        el('h3', {}, 'Instance admin'),
        el('p', { class: 'hint' }, 'You own this Bla instance.'),
        el('button', { class: 'btn btn-primary', onclick: () => openAdmin() }, [icon('server'), 'Open admin panel']),
      ]) : null,
    ]);
  }

  /* ── guild notifications ───────────────────────────────────────── */
  function guildNotifications(guildId) {
    const guild = state.guilds.get(String(guildId));
    const read = state.guildReadStates.get(String(guildId)) || {};
    const controller = M.openModal({
      title: `${guild.name} — notifications`,
      size: 'sm',
      body: el('div', {}, [
        el('label', { class: 'switch' }, [
          el('span', {}, [el('span', { class: 'switch-label' }, 'Mute server'), el('small', {}, 'No notifications, no badges.')]),
          el('input', {
            type: 'checkbox', checked: !!read.muted,
            onchange: async (event) => {
              await api.request('PUT', `/channels/${guild.system_channel_id || ''}/mute`, { muted: event.target.checked }).catch(() => {});
              state.guildReadStates.set(String(guildId), { ...read, muted: event.target.checked });
              toast(event.target.checked ? 'Server muted' : 'Server unmuted');
            },
          }),
        ]),
        el('p', { class: 'hint' }, 'Bla notifies you about mentions, replies and DMs only. There is no per-message spam.'),
      ]),
    });
    return controller;
  }

  /* ── guild settings ────────────────────────────────────────────── */
  function openGuild(guildId) {
    const guild = state.guilds.get(String(guildId));
    if (!guild) return;
    const modal = M.openModal({ title: `${guild.name} — server settings`, size: 'wide', body: el('div', {}, 'Loading…') });
    const tabs = [
      { key: 'overview', label: 'Overview', icon: 'gear' },
      { key: 'roles', label: 'Roles', icon: 'shield' },
      { key: 'channels', label: 'Channels', icon: 'hash' },
      { key: 'emoji', label: 'Emoji & Stickers', icon: 'emoji' },
      { key: 'soundboard', label: 'Soundboard', icon: 'music' },
      { key: 'members', label: 'Members', icon: 'users' },
      { key: 'invites', label: 'Invites', icon: 'link' },
      { key: 'webhooks', label: 'Webhooks', icon: 'bolt' },
      { key: 'audit', label: 'Audit Log', icon: 'eye' },
      { key: 'bans', label: 'Bans', icon: 'ban' },
      { type: 'separator' },
      { key: 'danger', label: 'Danger Zone', icon: 'trash' },
    ];
    modal.setBody(tabsLayout(tabs, 'overview', (key) => {
      if (key === 'overview') return guildOverview(guildId);
      if (key === 'roles') return guildRoles(guildId);
      if (key === 'channels') return guildChannels(guildId);
      if (key === 'emoji') return guildEmoji(guildId);
      if (key === 'soundboard') return guildSoundboard(guildId);
      if (key === 'members') return guildMembers(guildId);
      if (key === 'invites') return guildInvites(guildId);
      if (key === 'webhooks') return guildWebhooks(guildId);
      if (key === 'audit') return guildAudit(guildId);
      if (key === 'bans') return guildBans(guildId);
      return guildDanger(guildId);
    }));
  }

  function guildOverview(guildId) {
    const guild = state.guilds.get(String(guildId));
    let iconUrl = guild.icon;
    let bannerUrl = guild.banner;
    const name = el('input', { type: 'text', value: guild.name, maxlength: 100 });
    const description = el('textarea', { maxlength: 300, style: { minHeight: '60px' } }, guild.description || '');
    const tags = el('input', { type: 'text', value: (guild.tags || []).join(', '), placeholder: 'gaming, music, friends' });
    const vanity = el('input', { type: 'text', value: guild.vanity_url || '', placeholder: 'my-server' });

    const uploader = (kind, label, current, onDone) => {
      const input = el('input', {
        type: 'file', accept: 'image/*', style: { display: 'none' },
        onchange: async (event) => {
          const file = event.target.files[0];
          if (!file) return;
          const data = await api.upload(file, kind);
          onDone(data.url);
          toast(`${label} uploaded`);
        },
      });
      return el('div', { class: 'row', style: { gap: '8px' } }, [
        el('button', { class: 'btn btn-outline', onclick: () => input.click() }, [icon('upload'), label]),
        input,
        current ? el('button', { class: 'btn btn-ghost', onclick: () => { onDone(null); toast(`${label} removed`); } }, 'Remove') : null,
      ]);
    };

    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Server identity'),
        el('p', { class: 'hint' }, 'Banners, animated icons and vanity URLs are free on Bla — no boost level needed.'),
        el('div', { class: 'field' }, [el('span', {}, 'Server name'), name]),
        el('div', { class: 'field' }, [el('span', {}, 'Description'), description]),
        el('div', { class: 'field' }, [el('span', {}, 'Discovery tags (comma separated)'), tags]),
        el('div', { class: 'grid-2' }, [
          el('div', { class: 'field' }, [el('span', {}, 'Icon'), uploader('guild_icon', 'Icon', iconUrl, (url) => { iconUrl = url; })]),
          el('div', { class: 'field' }, [el('span', {}, 'Banner'), uploader('guild_banner', 'Banner', bannerUrl, (url) => { bannerUrl = url; })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Vanity URL'),
        el('p', { class: 'hint' }, `${location.origin}/invite/your-name-here — free forever.`),
        el('div', { class: 'field' }, [el('span', {}, 'Vanity slug'), vanity]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Discovery'),
        el('p', { class: 'hint' }, 'Listed servers appear in Explore and can be joined without an invite.'),
        el('label', { class: 'switch' }, [
          el('span', { class: 'switch-label' }, 'Show in Explore'),
          el('input', { type: 'checkbox', checked: !!guild.discovery, id: 'discovery-toggle' }),
        ]),
      ]),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            const data = await api.updateGuild(guildId, {
              name: name.value, description: description.value, icon: iconUrl, banner: bannerUrl,
              vanity_url: vanity.value, discovery: document.getElementById('discovery-toggle').checked,
              tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
            });
            S.setGuild(data.guild);
            R.renderGuildRail();
            R.renderSidebar();
            toast('Server updated');
          } catch { /* handled */ }
        },
      }, 'Save changes'),
    ]);
  }

  function guildRoles(guildId) {
    const guild = state.guilds.get(String(guildId));
    const container = el('div', {});
    const list = el('div', {});
    const editor = el('div', {});

    const renderList = async () => {
      const data = await api.roles(guildId).catch(() => null);
      const roles = data?.roles || guild.roles;
      clear(list);
      for (const role of [...roles].sort((a, b) => b.position - a.position)) {
        const count = role.member_count ?? guild.members.filter((m) => (m.roles || []).map(String).includes(String(role.id))).length;
        list.append(el('div', { class: 'role-row' }, [
          el('span', { class: 'role-dot', style: { background: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'var(--text-faint)' } }),
          el('span', { class: 'name', style: { color: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : undefined } }, role.name),
          el('span', { class: 'faint' }, role.is_everyone ? 'default' : `${count} member${count === 1 ? '' : 's'}`),
          el('button', {
            class: 'btn btn-sm btn-outline',
            disabled: role.position >= (guild.is_owner ? 1000 : 1) && !guild.is_owner,
            onclick: () => renderEditor(role),
          }, 'Edit'),
          !role.is_everyone ? el('button', {
            class: 'btn btn-sm btn-outline',
            onclick: () => M.confirm({
              title: `Delete ${role.name}?`,
              body: 'Members keep their other roles.',
              confirmLabel: 'Delete role', danger: true,
              onConfirm: async () => { await api.deleteRole(guildId, role.id); await renderList(); },
            }),
          }, [icon('trash')]) : null,
        ]));
      }
    };

    const renderEditor = (role) => {
      const name = el('input', { type: 'text', value: role.name, disabled: !!role.is_everyone });
      const color = el('input', { type: 'color', value: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#000000' });
      const hoist = el('input', { type: 'checkbox', checked: !!role.hoist });
      const mentionable = el('input', { type: 'checkbox', checked: !!role.mentionable });
      const position = el('input', { type: 'number', value: role.position, min: 1, max: 1000 });
      const permList = el('div', {});
      const perms = BigInt(role.permissions || '0');

      const loadPermissions = async () => {
        const data = await api.roles(guildId).catch(() => null);
        const definitions = data?.permission_list || [];
        clear(permList);
        if (!definitions.length) return;
        permList.append(el('div', { class: 'row', style: { gap: '8px', marginBottom: '10px' } }, [
          el('button', { class: 'btn btn-sm btn-outline', onclick: () => permList.querySelectorAll('input').forEach((i) => { i.checked = true; }) }, 'Enable all'),
          el('button', { class: 'btn btn-sm btn-outline', onclick: () => permList.querySelectorAll('input').forEach((i) => { i.checked = false; }) }, 'Clear all'),
        ]));
        for (const definition of definitions) {
          if (definition.key === 'ADMINISTRATOR' && !state.me.admin) continue;
          const bit = BigInt(definition.bit);
          permList.append(el('label', { class: 'permission-row', style: { cursor: 'pointer' } }, [
            el('input', { type: 'checkbox', checked: (perms & bit) === bit, dataset: { bit } }),
            el('div', { class: 'perm-text' }, [
              el('div', { class: 'perm-name' }, definition.name),
              el('div', { class: 'perm-desc' }, definition.description),
            ]),
          ]));
        }
      };

      clear(editor).append(el('div', { class: 'card' }, [
        el('h3', {}, `Edit ${role.name}`),
        el('div', { class: 'grid-2' }, [
          el('div', { class: 'field' }, [el('span', {}, 'Name'), name]),
          el('div', { class: 'field' }, [el('span', {}, 'Colour'), color]),
          el('div', { class: 'field' }, [el('span', {}, 'Position'), position]),
        ]),
        el('div', { class: 'grid-2' }, [
          el('label', { class: 'switch' }, [el('span', { class: 'switch-label' }, 'Display separately'), hoist]),
          el('label', { class: 'switch' }, [el('span', { class: 'switch-label' }, 'Allow anyone to @mention'), mentionable]),
        ]),
        el('div', { class: 'profile-section' }, [el('h4', {}, 'Permissions'), permList]),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            let bits = 0n;
            for (const input of permList.querySelectorAll('input[data-bit]')) {
              if (input.checked) bits |= BigInt(input.dataset.bit);
            }
            try {
              await api.updateRole(guildId, role.id, {
                name: name.value, color: parseInt(color.value.slice(1), 16),
                hoist: hoist.checked, mentionable: mentionable.checked,
                permissions: bits.toString(), position: Number(position.value),
              });
              toast('Role saved');
              await renderList();
            } catch { /* handled */ }
          },
        }, 'Save role'),
      ]));
      loadPermissions();
    };

    container.append(el('div', { class: 'row between' }, [
      el('h3', { style: { margin: '0 0 12px' } }, 'Roles'),
      el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: async () => {
          const data = await api.createRole(guildId, { name: 'New role', permissions: '0' });
          await renderList();
          renderEditor(data.role);
        },
      }, [icon('plus'), 'Create role']),
    ]));
    container.append(list, editor);
    renderList();
    return container;
  }

  function guildChannels(guildId) {
    const guild = state.guilds.get(String(guildId));
    const container = el('div', {});
    const groups = { categories: [], text: [], voice: [] };
    for (const channel of guild.channels) {
      if (channel.type === 4) groups.categories.push(channel);
      else if (channel.type === 2 || channel.type === 13) groups.voice.push(channel);
      else groups.text.push(channel);
    }
    const section = (title, channels) => {
      if (!channels.length) return null;
      const card = el('div', { class: 'card' }, [el('h3', {}, title)]);
      for (const channel of channels) {
        card.append(el('div', { class: 'role-row' }, [
          icon(channel.type === 4 ? 'chevron' : channel.type === 2 ? 'volume' : 'hash', 'icon'),
          el('span', { class: 'name' }, channel.name),
          el('span', { class: 'faint' }, channel.type === 4 ? 'category' : (channel.type === 2 ? `${channel.bitrate / 1000} kbps` : (channel.slowmode ? `slowmode ${channel.slowmode}s` : ''))),
          el('button', { class: 'btn btn-sm btn-outline', onclick: () => openChannel(channel.id) }, 'Edit'),
        ]));
      }
      return card;
    };
    container.append(
      section('Text channels', groups.text),
      section('Voice channels', groups.voice),
      section('Categories', groups.categories),
      el('button', { class: 'btn btn-primary', onclick: () => M.createChannel(guildId) }, [icon('plus'), 'Create channel']),
    );
    return container;
  }

  function guildEmoji(guildId) {
    const guild = state.guilds.get(String(guildId));
    const grid = el('div', { class: 'emoji-grid' });
    const render = () => {
      clear(grid);
      for (const emoji of guild.emojis || []) {
        grid.append(el('div', { class: 'emoji-tile' }, [
          el('img', { src: emoji.url, alt: emoji.name }),
          el('span', { class: 'name' }, `:${emoji.name}:`),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: async () => { await api.deleteEmoji(guildId, emoji.id); guild.emojis = guild.emojis.filter((e) => e.id !== emoji.id); render(); },
          }, [icon('trash')]),
        ]));
      }
      if (!(guild.emojis || []).length) grid.append(el('p', { class: 'faint' }, 'No custom emoji yet.'));
      for (const sticker of guild.stickers || []) {
        grid.append(el('div', { class: 'emoji-tile' }, [
          el('img', { src: sticker.url, alt: sticker.name }),
          el('span', { class: 'name' }, sticker.name),
          el('span', { class: 'faint', style: { fontSize: '11px' } }, 'sticker'),
        ]));
      }
    };
    render();

    const nameInput = el('input', { type: 'text', placeholder: 'party_parrot' });
    const fileInput = el('input', {
      type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' },
      onchange: async (event) => {
        for (const file of [...event.target.files]) {
          try {
            const upload = await api.upload(file, 'emoji');
            const name = (nameInput.value || upload.suggestion || file.name).replace(/\.[a-z0-9]+$/i, '').replace(/\W/g, '_');
            const data = await api.createEmoji(guildId, { name, image: upload.url, animated: upload.animated });
            guild.emojis = [...(guild.emojis || []), data.emoji];
            toast('Emoji added', `:${data.emoji.name}:`);
            nameInput.value = '';
            render();
          } catch { /* handled */ }
        }
      },
    });

    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Emoji'),
        el('p', { class: 'hint' }, `Up to 500 custom emoji per server (static and animated) — included for free. ${(guild.emojis || []).length} used.`),
        el('div', { class: 'row' }, [
          el('div', { style: { width: '220px' } }, nameInput),
          el('button', { class: 'btn btn-primary', onclick: () => fileInput.click() }, [icon('upload'), 'Upload emoji']),
          fileInput,
        ]),
      ]),
      el('div', { class: 'card' }, [el('h3', {}, 'Your emoji'), grid]),
      el('div', { class: 'card' }, [
        el('h3', {}, 'Stickers'),
        el('p', { class: 'hint' }, `${(guild.stickers || []).length} of 120 stickers used.`),
        el('button', {
          class: 'btn btn-outline',
          onclick: () => {
            const input = el('input', {
              type: 'file', accept: 'image/*', style: { display: 'none' },
              onchange: async (event) => {
                const file = event.target.files[0];
                if (!file) return;
                const upload = await api.upload(file, 'sticker');
                const data = await api.createSticker(guildId, { name: file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 30), image: upload.url });
                guild.stickers = [...(guild.stickers || []), data.sticker];
                toast('Sticker added');
                render();
              },
            });
            input.click();
          },
        }, [icon('upload'), 'Upload sticker']),
      ]),
    ]);
  }

  function guildSoundboard(guildId) {
    const guild = state.guilds.get(String(guildId));
    const list = el('div', {});
    const render = () => {
      clear(list);
      for (const sound of guild.soundboard || []) {
        list.append(el('div', { class: 'role-row' }, [
          icon('music', 'icon'),
          el('span', { class: 'name' }, sound.name),
          el('audio', { controls: true, src: sound.url, style: { height: '30px' } }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: async () => { await api.deleteSound(guildId, sound.id); guild.soundboard = guild.soundboard.filter((s) => s.id !== sound.id); render(); },
          }, [icon('trash')]),
        ]));
      }
      if (!(guild.soundboard || []).length) list.append(el('p', { class: 'faint' }, 'No sounds yet.'));
    };
    render();
    const nameInput = el('input', { type: 'text', placeholder: 'airhorn' });
    const fileInput = el('input', {
      type: 'file', accept: 'audio/*', style: { display: 'none' },
      onchange: async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const upload = await api.upload(file, 'sound');
        const data = await api.createSound(guildId, { name: nameInput.value || file.name.replace(/\.[a-z0-9]+$/i, ''), file: upload.url });
        guild.soundboard = [...(guild.soundboard || []), data.sound];
        toast('Sound added');
        nameInput.value = '';
        render();
      },
    });
    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Soundboard'),
        el('p', { class: 'hint' }, 'Free for every server on Bla — play sounds into a voice channel without a boost.'),
        el('div', { class: 'row' }, [
          el('div', { style: { width: '220px' } }, nameInput),
          el('button', { class: 'btn btn-primary', onclick: () => fileInput.click() }, [icon('upload'), 'Upload sound']),
          fileInput,
        ]),
        list,
      ]),
    ]);
  }

  function guildMembers(guildId) {
    const guild = state.guilds.get(String(guildId));
    const container = el('div', {});
    const list = el('div', {});
    const search = el('input', { type: 'search', placeholder: 'Search members…' });
    const render = () => {
      const query = search.value.toLowerCase();
      clear(list);
      for (const member of guild.members) {
        const name = S.displayName(member.user, guildId);
        if (query && !name.toLowerCase().includes(query) && !member.user.username.toLowerCase().includes(query)) continue;
        list.append(el('div', { class: 'role-row' }, [
          R.avatar(member.user, { size: 30, status: R.presenceOf(member.user_id) }),
          el('div', { style: { flex: 1, minWidth: 0 } }, [
            el('div', { style: { fontWeight: 600 } }, name),
            el('div', { class: 'faint', style: { fontSize: '12px' } },
              S.rolesOf(guildId, member.user_id).map((r) => r.name).join(', ') || 'No roles'),
          ]),
          el('button', { class: 'btn btn-sm btn-outline', onclick: () => M.rolePicker(guildId, member.user_id) }, 'Roles'),
          el('button', { class: 'btn btn-sm btn-outline', onclick: (event) => M.memberMenu(event, guildId, member.user_id) }, [icon('more')]),
        ]));
      }
    };
    search.addEventListener('input', render);
    container.append(el('div', { class: 'row', style: { marginBottom: '12px' } }, [search]));
    container.append(list);
    render();
    return container;
  }

  function guildInvites(guildId) {
    const container = el('div', {});
    const render = async () => {
      clear(container);
      const data = await api.invites(guildId).catch(() => ({ invites: [] }));
      const card = el('div', { class: 'card' }, [
        el('h3', {}, `Active invites — ${data.invites.length}`),
        el('p', { class: 'hint' }, 'Invite links never expire unless you say so. No limit on how many you create.'),
      ]);
      for (const invite of data.invites) {
        const url = `${location.origin}/invite/${invite.code}`;
        card.append(el('div', { class: 'role-row' }, [
          el('span', { class: 'invite-code' }, invite.code),
          el('span', { class: 'faint', style: { flex: 1 } }, `${invite.uses} uses${invite.max_uses ? `/${invite.max_uses}` : ''}${invite.expires_at ? ` · expires ${relative(invite.expires_at)}` : ''}`),
          el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await copy(url); toast('Copied'); } }, [icon('copy')]),
          el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await api.revokeInvite(guildId, invite.code); render(); } }, [icon('trash')]),
        ]));
      }
      card.append(el('button', { class: 'btn btn-primary', onclick: () => M.invite(guildId) }, [icon('plus'), 'Create invite']));
      container.append(card);
    };
    render();
    return container;
  }

  function guildWebhooks(guildId) {
    const container = el('div', {});
    const render = async () => {
      clear(container);
      const data = await api.webhooks(guildId).catch(() => ({ webhooks: [] }));
      const card = el('div', { class: 'card' }, [
        el('h3', {}, 'Webhooks'),
        el('p', { class: 'hint' }, 'POST JSON to these URLs to post messages from scripts, cron jobs or CI. No bot framework needed.'),
      ]);
      for (const hook of data.webhooks) {
        const url = `${location.origin}${hook.url}`;
        card.append(el('div', { class: 'role-row' }, [
          icon('bolt', 'icon'),
          el('div', { style: { flex: 1, minWidth: 0 } }, [
            el('div', { style: { fontWeight: 600 } }, hook.name),
            el('div', { class: 'faint', style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' } }, `#${hook.channel_name} · ${url}`),
          ]),
          el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await copy(url); toast('Webhook URL copied'); } }, [icon('copy')]),
          el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await api.deleteWebhook(guildId, hook.id); render(); } }, [icon('trash')]),
        ]));
        card.append(el('div', { class: 'code-block', style: { marginBottom: '10px' } }, [
          el('code', {}, `curl -H 'Content-Type: application/json' \\\n  -d '{"content":"deploy finished ✅"}' \\\n  ${url}`),
        ]));
      }
      const nameInput = el('input', { type: 'text', placeholder: 'Deploy bot' });
      const channelSelect = el('select', {}, [...state.channels.values()]
        .filter((c) => String(c.guild_id) === String(guildId) && c.type === 0)
        .map((c) => el('option', { value: String(c.id) }, `#${c.name}`)));
      card.append(el('div', { class: 'row' }, [
        el('div', { style: { width: '200px' } }, nameInput),
        el('div', { style: { width: '200px' } }, channelSelect),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => { await api.createWebhook(guildId, { name: nameInput.value || 'Webhook', channel_id: channelSelect.value }); render(); },
        }, [icon('plus'), 'Create webhook']),
      ]));
      container.append(card);
    };
    render();
    return container;
  }

  function guildAudit(guildId) {
    const container = el('div', {}, el('p', { class: 'faint' }, 'Loading audit log…'));
    api.auditLog(guildId, '?limit=100').then((data) => {
      clear(container);
      const card = el('div', { class: 'card' }, [el('h3', {}, `Audit log — ${data.audit_log_entries.length} entries`)]);
      for (const entry of data.audit_log_entries) {
        card.append(el('div', { class: 'audit-row' }, [
          R.avatar(entry.user || { id: '0', display_name: 'System' }, { size: 26 }),
          el('div', { style: { flex: 1 } }, [
            el('div', {}, [el('span', { class: 'action' }, entry.action.replace(/_/g, ' ').toLowerCase()), ' ', S.displayName(entry.user || { display_name: 'System' })]),
            entry.reason ? el('div', { class: 'faint', style: { fontSize: '12.5px' } }, `Reason: ${entry.reason}`) : null,
          ]),
          el('span', { class: 'when' }, relative(entry.created_at)),
        ]));
      }
      if (!data.audit_log_entries.length) card.append(el('p', { class: 'faint' }, 'Nothing logged yet.'));
      container.append(card);
    }).catch((err) => { clear(container).append(el('p', { class: 'faint' }, err.message)); });
    return container;
  }

  function guildBans(guildId) {
    const container = el('div', {}, el('p', { class: 'faint' }, 'Loading bans…'));
    const render = async () => {
      try {
        const data = await api.bans(guildId);
        clear(container);
        const card = el('div', { class: 'card' }, [el('h3', {}, `Banned users — ${data.bans.length}`)]);
        for (const ban of data.bans) {
          card.append(el('div', { class: 'role-row' }, [
            R.avatar(ban.user, { size: 28 }),
            el('div', { style: { flex: 1 } }, [
              el('div', { style: { fontWeight: 600 } }, S.displayName(ban.user)),
              el('div', { class: 'faint', style: { fontSize: '12px' } }, ban.reason || 'No reason given'),
            ]),
            el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await api.unban(guildId, ban.user.id); render(); } }, 'Unban'),
          ]));
        }
        if (!data.bans.length) card.append(el('p', { class: 'faint' }, 'Nobody is banned. Nice.'));
        container.append(card);
      } catch (err) {
        clear(container).append(el('p', { class: 'faint' }, err.message));
      }
    };
    render();
    return container;
  }

  function guildDanger(guildId) {
    const guild = state.guilds.get(String(guildId));
    const isOwner = guild.is_owner;
    const card = el('div', { class: 'card danger' }, [
      el('h3', {}, 'Danger zone'),
      el('p', { class: 'hint' }, isOwner
        ? 'Transfer the server to someone else, or delete it permanently.'
        : 'Only the owner can do these things.'),
      el('div', { class: 'row', style: { gap: '10px' } }, [
        isOwner ? el('button', {
          class: 'btn btn-outline',
          onclick: () => M.prompt({
            title: 'Transfer ownership',
            label: 'Username of the new owner',
            confirmLabel: 'Transfer',
            onConfirm: async (username) => {
              const data = await api.users(username, 5);
              const target = data.users.find((u) => u.username.toLowerCase() === username.replace(/^@/, '').toLowerCase());
              if (!target) return toast('No such user', '', 'error');
              await api.transferOwnership(guildId, target.id);
              toast('Ownership transferred', S.displayName(target));
            },
          }),
        }, [icon('crown'), 'Transfer ownership']) : null,
        isOwner ? el('button', { class: 'btn btn-danger', onclick: () => M.confirmLeaveOrDelete(guild) }, [icon('trash'), 'Delete server']) : null,
        !isOwner ? el('button', { class: 'btn btn-danger', onclick: () => M.confirmLeaveOrDelete(guild) }, [icon('logout'), 'Leave server']) : null,
      ]),
    ]);
    return card;
  }

  /* ── channel settings ──────────────────────────────────────────── */
  function openChannel(channelId) {
    const channel = state.channels.get(String(channelId));
    if (!channel) return;
    const modal = M.openModal({ title: `#${channel.name}`, size: 'wide', body: el('div', {}, 'Loading…') });
    const tabs = [
      { key: 'overview', label: 'Overview', icon: 'gear' },
      { key: 'permissions', label: 'Permissions', icon: 'shield' },
    ];
    modal.setBody(tabsLayout(tabs, 'overview', (key) => (key === 'overview' ? channelOverview(channel) : channelPermissions(channel))));
  }

  function channelOverview(channel) {
    const name = el('input', { type: 'text', value: channel.name || '', maxlength: 100 });
    const topic = el('textarea', { maxlength: 1024, style: { minHeight: '60px' } }, channel.topic || '');
    const slowmode = el('input', { type: 'number', value: channel.slowmode || 0, min: 0, max: 21600 });
    const nsfw = el('input', { type: 'checkbox', checked: !!channel.nsfw });
    const bitrate = el('input', { type: 'range', min: 8000, max: 384000, step: 1000, value: channel.bitrate || 384000 });
    const bitrateLabel = el('span', { class: 'faint' }, `${Math.round((channel.bitrate || 384000) / 1000)} kbps — up to 384 kbps, free`);
    bitrate.addEventListener('input', () => { bitrateLabel.textContent = `${Math.round(Number(bitrate.value) / 1000)} kbps — up to 384 kbps, free`; });
    const userLimit = el('input', { type: 'number', value: channel.user_limit || 0, min: 0, max: 99 });

    return el('div', {}, [
      el('div', { class: 'card' }, [
        el('h3', {}, 'Channel overview'),
        el('div', { class: 'field' }, [el('span', {}, 'Name'), name]),
        el('div', { class: 'field' }, [el('span', {}, 'Topic'), topic]),
        el('div', { class: 'grid-3' }, [
          el('div', { class: 'field' }, [el('span', {}, 'Slowmode (seconds)'), slowmode]),
          channel.type === 2 ? el('div', { class: 'field' }, [el('span', {}, 'User limit (0 = unlimited)'), userLimit]) : null,
          el('label', { class: 'switch' }, [el('span', { class: 'switch-label' }, 'Age-restricted'), nsfw]),
        ]),
        channel.type === 2 ? el('div', { class: 'field' }, [el('span', {}, 'Bitrate'), bitrate, bitrateLabel]) : null,
      ]),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          await api.updateChannel(channel.guild_id, channel.id, {
            name: name.value, topic: topic.value, rate_limit_per_user: Number(slowmode.value),
            nsfw: nsfw.checked, bitrate: Number(bitrate.value), user_limit: Number(userLimit.value),
          });
          toast('Channel updated');
          R.renderSidebar();
        },
      }, 'Save changes'),
      el('div', { class: 'card danger' }, [
        el('h3', {}, 'Delete channel'),
        el('button', {
          class: 'btn btn-danger',
          onclick: () => M.confirm({
            title: `Delete #${channel.name}?`,
            body: 'Every message in this channel will be gone for good.',
            confirmLabel: 'Delete', danger: true,
            onConfirm: async () => { await api.deleteChannel(channel.guild_id, channel.id); toast('Channel deleted'); },
          }),
        }, 'Delete channel'),
      ]),
    ]);
  }

  function channelPermissions(channel) {
    const guild = state.guilds.get(String(channel.guild_id));
    const container = el('div', {});
    const roleList = el('div', {});
    const memberList = el('div', {});

    const overwriteEditor = (targetId, targetType, targetName) => {
      const existing = channel.permission_overwrites?.find((o) => String(o.id) === String(targetId) && (o.type === 0 ? 'role' : 'member') === targetType);
      const allow = BigInt(existing?.allow || '0');
      const deny = BigInt(existing?.deny || '0');
      const perms = el('div', {});
      const definitions = [
        ['VIEW_CHANNEL', 1n << 10n, 'View channel'],
        ['SEND_MESSAGES', 1n << 11n, 'Send messages'],
        ['READ_MESSAGE_HISTORY', 1n << 16n, 'Read history'],
        ['ATTACH_FILES', 1n << 15n, 'Attach files'],
        ['ADD_REACTIONS', 1n << 6n, 'Add reactions'],
        ['MANAGE_MESSAGES', 1n << 13n, 'Manage messages'],
        ['CONNECT', 1n << 20n, 'Connect (voice)'],
        ['SPEAK', 1n << 21n, 'Speak'],
        ['STREAM', 1n << 9n, 'Video & stream'],
        ['MANAGE_CHANNELS', 1n << 4n, 'Manage channel'],
      ];
      for (const [key, bit, label] of definitions) {
        const state = allow & bit ? 'allow' : deny & bit ? 'deny' : 'neutral';
        const select = el('select', {}, [
          el('option', { value: 'neutral', selected: state === 'neutral' }, 'Neutral'),
          el('option', { value: 'allow', selected: state === 'allow' }, 'Allow'),
          el('option', { value: 'deny', selected: state === 'deny' }, 'Deny'),
        ]);
        select.dataset.bit = bit.toString();
        perms.append(el('div', { class: 'row between', style: { padding: '6px 0' } }, [
          el('span', {}, label),
          el('div', { style: { width: '130px' } }, select),
        ]));
      }
      const controller = M.openModal({
        title: `Permissions — ${targetName}`,
        size: 'sm',
        body: perms,
        footer: [
          el('button', { class: 'btn btn-ghost', onclick: () => controller.close() }, 'Cancel'),
          el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              let allowBits = 0n;
              let denyBits = 0n;
              for (const select of perms.querySelectorAll('select')) {
                const bit = BigInt(select.dataset.bit);
                if (select.value === 'allow') allowBits |= bit;
                if (select.value === 'deny') denyBits |= bit;
              }
              await api.setOverwrite(channel.guild_id, channel.id, targetId, {
                type: targetType === 'member' ? 1 : 0,
                allow: allowBits.toString(), deny: denyBits.toString(),
              });
              toast('Permissions updated');
              controller.close();
            },
          }, 'Save'),
        ],
      });
    };

    container.append(el('div', { class: 'card' }, [
      el('h3', {}, 'Channel permissions'),
      el('p', { class: 'hint' }, 'Lock a channel down for a role, or let one person in. Changes apply the moment you save them.'),
    ]));

    const roleCard = el('div', { class: 'card' }, [el('h3', {}, 'Roles')]);
    for (const role of guild.roles) {
      const existing = channel.permission_overwrites?.find((o) => String(o.id) === String(role.id) && o.type === 0);
      roleCard.append(el('div', { class: 'role-row' }, [
        el('span', { class: 'role-dot', style: { background: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'var(--text-faint)' } }),
        el('span', { class: 'name' }, role.name),
        existing ? el('span', { class: 'badge' }, 'custom') : null,
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => overwriteEditor(role.id, 'role', role.name) }, 'Edit'),
      ]));
    }
    container.append(roleCard);

    const memberCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Members'),
      el('p', { class: 'hint' }, 'Pick a member to give them individual access.'),
    ]);
    for (const member of guild.members.slice(0, 60)) {
      const existing = channel.permission_overwrites?.find((o) => String(o.id) === String(member.user_id) && o.type === 1);
      memberCard.append(el('div', { class: 'role-row' }, [
        R.avatar(member.user, { size: 26 }),
        el('span', { class: 'name' }, S.displayName(member.user, guild.id)),
        existing ? el('span', { class: 'badge' }, 'custom') : null,
        el('button', { class: 'btn btn-sm btn-outline', onclick: () => overwriteEditor(member.user_id, 'member', S.displayName(member.user, guild.id)) }, 'Edit'),
      ]));
    }
    container.append(memberCard);
    return container;
  }

  /* ── admin panel ───────────────────────────────────────────────── */
  function openAdmin() {
    const modal = M.openModal({ title: 'Instance admin', size: 'wide', body: el('div', {}, 'Loading…') });
    modal.setBody(tabsLayout([
      { key: 'overview', label: 'Overview', icon: 'server' },
      { key: 'users', label: 'Accounts', icon: 'users' },
      { key: 'guilds', label: 'Servers', icon: 'hash' },
      { key: 'settings', label: 'Instance settings', icon: 'gear' },
      { key: 'invites', label: 'Sign-up invites', icon: 'link' },
      { key: 'maintenance', label: 'Maintenance', icon: 'hammer' },
    ], 'overview', (key) => {
      if (key === 'users') return adminUsers();
      if (key === 'guilds') return adminGuilds();
      if (key === 'settings') return adminSettings();
      if (key === 'invites') return adminInvites();
      if (key === 'maintenance') return adminMaintenance();
      return adminOverview();
    }));
  }

  function adminOverview() {
    const container = el('div', {}, el('p', { class: 'faint' }, 'Loading…'));
    api.adminStats().then((data) => {
      clear(container);
      const grid = el('div', { class: 'stat-grid' });
      const stats = [
        ['Accounts', data.counts.users], ['Servers', data.counts.guilds],
        ['Messages', data.counts.messages], ['Channels', data.counts.channels],
        ['Uploads', data.counts.attachments], ['In voice', data.counts.in_voice],
        ['Sessions', data.counts.sessions], ['Storage', formatBytes(data.storage.media_bytes + data.storage.database_bytes)],
      ];
      for (const [label, value] of stats) {
        grid.append(el('div', { class: 'stat' }, [el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label)]));
      }
      container.append(grid, el('div', { class: 'card', style: { marginTop: '16px' } }, [
        el('h3', {}, 'Process'),
        el('div', { class: 'chip-row' }, [
          el('span', { class: 'tag-pill' }, `Node ${data.process.node}`),
          el('span', { class: 'tag-pill' }, `Up ${Math.floor(data.process.uptime_seconds / 60)} min`),
          el('span', { class: 'tag-pill' }, `${data.process.memory_mb} MB RAM`),
          el('span', { class: 'tag-pill' }, `${data.process.cpus} CPUs`),
          el('span', { class: 'tag-pill' }, data.process.platform),
        ]),
        el('div', { class: 'profile-section' }, [
          el('h4', {}, 'Data location'),
          el('div', { class: 'faint', style: { fontFamily: 'var(--mono)', fontSize: '12.5px' } }, data.config.data_dir),
        ]),
      ]));
    }).catch((err) => clear(container).append(el('p', { class: 'faint' }, err.message)));
    return container;
  }

  function adminUsers() {
    const container = el('div', {});
    const search = el('input', { type: 'search', placeholder: 'Search accounts…' });
    const list = el('div', {});
    const render = async () => {
      const data = await api.adminUsers(search.value.trim());
      clear(list);
      for (const user of data.users) {
        list.append(el('div', { class: 'role-row' }, [
          R.avatar(user, { size: 30 }),
          el('div', { style: { flex: 1 } }, [
            el('div', { style: { fontWeight: 600 } }, `${user.username}#${user.discriminator}`),
            el('div', { class: 'faint', style: { fontSize: '12px' } },
              `${user.guild_count} servers · ${user.message_count} messages · joined ${relative(user.created_at)}`),
          ]),
          user.admin ? el('span', { class: 'badge admin' }, 'ADMIN') : null,
          user.disabled ? el('span', { class: 'badge locked' }, 'DISABLED') : null,
          el('button', {
            class: 'btn btn-sm btn-outline',
            onclick: (event) => showMenu(event, [
              { label: user.disabled ? 'Enable account' : 'Disable account', icon: user.disabled ? 'check' : 'ban', action: async () => { await api.adminUpdateUser(user.id, { disabled: !user.disabled }); render(); } },
              { label: user.admin ? 'Remove admin' : 'Make instance admin', icon: 'shield', action: async () => { await api.adminUpdateUser(user.id, { admin: !user.admin }); render(); } },
              { label: 'Reset password', icon: 'edit', action: () => M.prompt({
                title: 'Reset password', label: 'New password (8+ chars)',
                onConfirm: async (pw) => { await api.adminUpdateUser(user.id, { reset_password: pw }); toast('Password reset'); },
              }) },
              { type: 'separator' },
              { label: 'Delete account', icon: 'trash', danger: true, action: () => M.confirm({
                title: `Delete ${user.username}?`, body: 'Their servers transfer or get deleted.', confirmLabel: 'Delete', danger: true,
                onConfirm: async () => { await api.adminDeleteUser(user.id); render(); },
              }) },
            ]),
          }, [icon('more')]),
        ]));
      }
    };
    search.addEventListener('input', window.Bla.debounce(render, 300));
    container.append(el('div', { class: 'row', style: { marginBottom: '12px' } }, [search]));
    container.append(list);
    render();
    return container;
  }

  function adminGuilds() {
    const container = el('div', {});
    const list = el('div', {});
    const render = async () => {
      const data = await api.adminGuilds();
      clear(list);
      for (const guild of data.guilds) {
        list.append(el('div', { class: 'role-row' }, [
          R.avatar({ id: guild.id, avatar: guild.icon, display_name: guild.name }, { size: 30, square: true }),
          el('div', { style: { flex: 1 } }, [
            el('div', { style: { fontWeight: 600 } }, guild.name),
            el('div', { class: 'faint', style: { fontSize: '12px' } }, `${guild.member_count} members · ${guild.message_count} messages · owner ${guild.owner}`),
          ]),
          el('button', {
            class: 'btn btn-sm btn-outline',
            onclick: () => M.confirm({
              title: `Delete ${guild.name}?`, body: 'This removes the server and all its messages.',
              confirmLabel: 'Delete', danger: true, onConfirm: async () => { await api.adminDeleteGuild(guild.id); render(); },
            }),
          }, [icon('trash')]),
        ]));
      }
    };
    container.append(list);
    render();
    return container;
  }

  function adminSettings() {
    const container = el('div', {}, el('p', { class: 'faint' }, 'Loading…'));
    api.adminSettings().then((data) => {
      clear(container);
      const card = el('div', { class: 'card' }, [el('h3', {}, 'Instance settings')]);
      for (const definition of data.definitions) {
        if (definition.type === 'boolean') {
          card.append(el('label', { class: 'switch' }, [
            el('span', {}, [el('span', { class: 'switch-label' }, definition.label)]),
            el('input', {
              type: 'checkbox', checked: !!definition.value,
              onchange: async (event) => { await api.adminUpdateSettings({ [definition.key]: event.target.checked }); toast('Saved'); },
            }),
          ]));
        } else {
          const input = el('input', { type: definition.type === 'number' ? 'number' : 'text', value: definition.value });
          card.append(el('div', { class: 'field' }, [
            el('span', {}, definition.label),
            el('div', { class: 'row' }, [
              input,
              el('button', {
                class: 'btn btn-primary',
                onclick: async () => { await api.adminUpdateSettings({ [definition.key]: definition.type === 'number' ? Number(input.value) : input.value }); toast('Saved'); },
              }, 'Save'),
            ]),
          ]));
        }
      }
      container.append(card);
    });
    return container;
  }

  function adminInvites() {
    const container = el('div', {});
    const list = el('div', {});
    const render = async () => {
      const data = await api.adminInstanceInvites();
      clear(list);
      for (const invite of data.invites) {
        list.append(el('div', { class: 'role-row' }, [
          el('span', { class: 'invite-code' }, invite.code),
          el('span', { class: 'faint', style: { flex: 1 } }, `${invite.uses} uses${invite.max_uses ? `/${invite.max_uses}` : ''}`),
          el('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await copy(`${location.origin}/#/register?invite=${invite.code}`); toast('Copied'); } }, [icon('copy')]),
        ]));
      }
    };
    container.append(el('div', { class: 'card' }, [
      el('h3', {}, 'Sign-up invites'),
      el('p', { class: 'hint' }, 'Only needed if you turn on “require an invite to sign up” above.'),
      el('button', { class: 'btn btn-primary', onclick: async () => { await api.adminCreateInstanceInvite({}); render(); } }, [icon('plus'), 'Create invite code']),
      list,
    ]));
    render();
    return container;
  }

  function adminMaintenance() {
    return el('div', { class: 'card' }, [
      el('h3', {}, 'Maintenance'),
      el('p', { class: 'hint' }, 'Housekeeping for the SQLite database and upload folder.'),
      el('div', { class: 'row', style: { gap: '10px' } }, [
        el('button', {
          class: 'btn btn-outline',
          onclick: async () => { await api.adminMaintenance('vacuum'); toast('Database vacuumed'); },
        }, [icon('hammer'), 'Vacuum database']),
        el('button', {
          class: 'btn btn-outline',
          onclick: async () => {
            const result = await api.adminMaintenance('purge-orphan-uploads');
            toast('Orphan uploads removed', `${result.purged} files`);
          },
        }, [icon('trash'), 'Purge orphaned uploads']),
      ]),
      el('p', { class: 'hint', style: { marginTop: '12px' } },
        'Backups: stop Bla and copy the whole data/ folder (bla.db plus uploads/). That is the entire state of this instance.'),
    ]);
  }

  window.BlaSettings = { openUser, openGuild, openChannel, guildNotifications, openAdmin, applyAppearance };
}());
