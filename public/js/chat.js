/* Bla — the chat view: message list, composer, attachments, reactions, polls. */
(function () {
  'use strict';
  const { el, clear, icon, $, formatTime, formatDate, dayKey, formatBytes, relative, showMenu, copy, toast, debounce } = window.Bla;
  const S = window.BlaState;
  const state = S.state;
  const api = window.BlaApi;
  const R = window.BlaRender;
  const M = window.BlaMarkdown;

  let replyTo = null;
  let editing = null;
  let pendingAttachments = [];
  let lastAuthorId = null;
  let lastTimestamp = 0;
  let lastDayKey = null;
  let atBottom = true;
  let loadingOlder = false;

  const messageNodeKey = (id) => `msg-${id}`;

  /* ── message list ──────────────────────────────────────────────── */
  async function open(channelId, { jumpTo = null } = {}) {
    replyTo = null;
    editing = null;
    pendingAttachments = [];
    lastAuthorId = null;
    lastTimestamp = 0;
    lastDayKey = null;

    const container = $('#messages');
    clear(container);
    const channel = S.currentChannel();
    if (!channel) return;

    if (channel.type === 2 || channel.type === 13) {
      renderVoicePlaceholder(container, channel);
      renderComposer();
      return;
    }

    container.append(el('div', { class: 'empty-state' }, [
      el('img', { src: '/icons/logo.svg', alt: '' }),
      el('h2', {}, channel.name ? `Welcome to #${channel.name}` : 'Start of the conversation'),
      el('p', {}, channel.topic || 'This is the beginning of this conversation.'),
    ]));

    try {
      const params = { limit: 50 };
      if (jumpTo) params.around = jumpTo;
      const data = await api.messages(channelId, params);
      S.setMessages(channelId, data.messages);
      state.hasMore.set(String(channelId), data.has_more);
      renderAll(channelId, jumpTo);
      window.BlaApp.markRead(channelId);
    } catch (err) {
      clear(container);
      container.append(el('div', { class: 'empty-state' }, [
        icon('ban'),
        el('h2', {}, 'Cannot load messages'),
        el('p', {}, err.message),
      ]));
    }
    renderComposer();
  }

  function renderAll(channelId, jumpTo = null) {
    const container = $('#messages');
    const scrollTop = container.scrollTop;
    clear(container);
    lastAuthorId = null;
    lastTimestamp = 0;
    lastDayKey = null;

    const messages = S.channelMessages(channelId);
    const read = state.readStates.get(String(channelId));
    const firstUnread = read?.unread && read.last_message_id
      ? messages.find((m) => BigInt(m.id) > BigInt(read.last_message_id))
      : null;

    if (state.hasMore.get(String(channelId))) {
      container.append(el('div', { class: 'empty-state', style: { padding: '20px', gap: '6px' } }, [
        el('button', { class: 'btn btn-outline btn-sm', onclick: () => loadOlder(channelId) }, 'Load earlier messages'),
      ]));
    }

    for (const message of messages) {
      if (firstUnread && String(firstUnread.id) === String(message.id)) {
        container.append(el('div', { class: 'new-divider' }, 'New messages'));
      }
      container.append(renderMessage(message, channelId));
    }

    if (jumpTo) {
      const target = document.getElementById(messageNodeKey(jumpTo));
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('mentioned');
        setTimeout(() => target.classList.remove('mentioned'), 1600);
      }
    } else {
      container.scrollTop = container.scrollHeight;
    }
    if (scrollTop > 0 && !jumpTo) container.scrollTop = container.scrollHeight;
  }

  function renderMessage(message, channelId) {
    const isSystem = message.system || message.type === 1;
    if (isSystem && message.interaction?.system) {
      const text = message.interaction.system === 'RECIPIENT_ADD'
        ? `${S.displayName(message.interaction.user)} added ${S.displayName(message.interaction.target)} to the group.`
        : 'System message';
      return el('div', { class: 'msg-system', id: messageNodeKey(message.id) }, [icon('bolt', 'icon'), el('span', {}, text)]);
    }
    if (isSystem) {
      return el('div', { class: 'msg-system', id: messageNodeKey(message.id) }, [
        icon('bolt', 'icon'),
        el('span', { html: '' }, ...contentNodes(message, channelId)),
      ]);
    }

    const container = $('#messages');
    const showHeader = lastAuthorId !== String(message.author.id) ||
      Number(message.id) - Number(lastTimestamp) > 7 * 60000 ||
      message.referenced_message;
    const dayChanged = dayKey(message.timestamp) !== lastDayKey;
    lastDayKey = dayKey(message.timestamp);
    lastAuthorId = String(message.author.id);
    lastTimestamp = message.timestamp;

    const mentioned = message.mention_everyone ||
      (message.mentions || []).some((u) => String(u.id) === String(state.me?.id));

    const row = el('div', {
      class: `msg ${mentioned ? 'mentioned' : ''}`,
      id: messageNodeKey(message.id),
      dataset: { messageId: String(message.id) },
      oncontextmenu: (event) => messageMenu(event, message),
    });

    if (showHeader) {
      row.append(R.avatar(message.author, { size: 40, status: R.presenceOf(message.author.id) }));
    } else {
      row.append(el('div', { class: 'msg-avatar-spacer' }));
    }

    const content = el('div', { class: 'msg-content' });
    if (message.referenced_message) {
      const ref = message.referenced_message;
      content.append(el('div', {
        class: 'msg-reply',
        onclick: () => scrollToMessage(ref.id),
        style: { cursor: 'pointer' },
      }, [
        el('div', { class: 'bar' }),
        el('span', { class: 'who' }, S.displayName(ref.author)),
        el('span', {}, M.plain(ref.content, 90) || 'attachment'),
      ]));
    }
    if (showHeader) {
      const color = S.currentGuild() ? S.topRoleColor(S.currentGuild().id, message.author.id) : null;
      content.append(el('div', { class: 'msg-head' }, [
        el('span', {
          class: 'msg-author',
          style: color ? { color: `#${color.toString(16).padStart(6, '0')}` } : {},
          onclick: () => window.BlaModals.userProfile(message.author.id, S.currentGuild()?.id),
        }, S.displayName(message.author, S.currentGuild()?.id)),
        message.author.bot ? el('span', { class: 'badge bot' }, 'BOT') : null,
        message.author.webhook ? el('span', { class: 'badge' }, 'WEBHOOK') : null,
        el('span', { class: 'msg-time', title: formatDate(message.timestamp) }, formatTime(message.timestamp)),
      ]));
    }

    const textWrap = el('div', { class: `msg-text ${M.isEmojiOnly(message.content) ? 'emoji-only' : ''}` });
    textWrap.append(M.render(message.content, {
      guildId: S.currentGuild()?.id,
      channelId,
      onChannelClick: (id) => window.BlaApp.openChannel(id, null),
      onMentionClick: (user) => window.BlaModals.userProfile(user.id, S.currentGuild()?.id),
    }));
    if (message.content) content.append(textWrap);

    if (message.edited_timestamp) content.append(el('span', { class: 'faint', style: { fontSize: '11px' } }, ' (edited)'));

    if (message.attachments?.length) content.append(attachmentsNode(message.attachments));
    if (message.embeds?.length) {
      for (const embed of message.embeds) content.append(embedNode(embed));
    }
    if (message.poll) content.append(pollNode(message));

    if (message.reactions?.length) content.append(reactionsNode(message));

    row.append(content);
    row.append(toolbar(message));

    const wrapper = el('div', { class: `msg-group ${showHeader ? 'first' : ''}` });
    if (dayChanged) wrapper.append(el('div', { class: 'day-divider' }, formatDate(message.timestamp).split(' at ')[0]));
    wrapper.append(row);
    return wrapper;
  }

  function contentNodes(message, channelId) {
    return [M.render(message.content.replace(/\*\*/g, ''), { guildId: S.currentGuild()?.id, channelId })];
  }

  function attachmentsNode(attachments) {
    const wrap = el('div', { class: 'msg-attachments' });
    for (const attachment of attachments) {
      const type = attachment.content_type || '';
      if (attachment.voice_message) {
        wrap.append(el('div', { class: 'voice-message' }, [
          icon('mic'),
          el('audio', { controls: true, src: attachment.url, preload: 'metadata' }),
          el('span', { class: 'faint', style: { fontSize: '12px' } }, attachment.duration ? `${Math.round(attachment.duration)}s` : ''),
        ]));
      } else if (type.startsWith('image/')) {
        wrap.append(el('img', {
          class: 'attachment-image',
          src: attachment.url,
          alt: attachment.filename,
          loading: 'lazy',
          onclick: () => window.BlaApp.lightbox(attachment),
        }));
      } else if (type.startsWith('video/')) {
        wrap.append(el('video', { class: 'attachment-video', controls: true, src: attachment.url, preload: 'metadata' }));
      } else if (type.startsWith('audio/')) {
        wrap.append(el('audio', { class: 'attachment-audio', controls: true, src: attachment.url, preload: 'metadata' }));
      } else {
        wrap.append(el('a', {
          class: 'attachment-file', href: attachment.url, target: '_blank', rel: 'noopener', download: attachment.filename,
        }, [
          icon('paperclip', 'icon'),
          el('div', { class: 'meta' }, [
            el('div', { class: 'fname' }, attachment.filename),
            el('div', { class: 'fsize' }, formatBytes(attachment.size)),
          ]),
          icon('download'),
        ]));
      }
    }
    return wrap;
  }

  function embedNode(embed) {
    if (embed.type === 'image') {
      return el('div', { class: 'embed-portrait' }, [
        el('div', { class: 'provider' }, embed.provider?.name || 'image'),
        el('img', { src: embed.url, alt: '', loading: 'lazy', style: { maxHeight: '320px' } }),
      ]);
    }
    if (embed.type === 'video') {
      return el('div', { class: 'embed-portrait' }, [
        el('div', { class: 'provider' }, embed.provider?.name || 'video'),
        el('video', { src: embed.url, controls: true, class: 'attachment-video' }),
      ]);
    }
    if (embed.type === 'audio') {
      return el('audio', { class: 'attachment-audio embed-audio', controls: true, src: embed.url });
    }
    return el('a', { class: 'embed-link', href: embed.url, target: '_blank', rel: 'noopener' }, [
      icon('link'), el('span', {}, embed.provider?.name || embed.url),
    ]);
  }

  function pollNode(message) {
    const poll = message.poll;
    if (!poll) return el('div');
    const total = poll.total_votes || 0;
    const node = el('div', { class: 'card', style: { maxWidth: '460px', marginTop: '8px' } });
    const rerender = (fresh) => {
      clear(node);
      renderPollInto(node, { ...poll, ...fresh });
    };
    rerender({});
    node.dataset.pollId = String(poll.id);
    return node;
  }

  function renderPollInto(node, poll) {
    const total = poll.total_votes || 0;
    node.append(el('div', { class: 'row between' }, [
      el('div', { style: { fontWeight: 700 } }, poll.question),
      el('span', { class: 'tag-pill' }, poll.allow_multiselect ? 'Multi-select' : 'Single choice'),
    ]));
    node.append(el('div', { class: 'faint', style: { fontSize: '12.5px', marginBottom: '8px' } },
      poll.ended ? `Poll ended · ${total} vote${total === 1 ? '' : 's'}`
        : `${total} vote${total === 1 ? '' : 's'}${poll.expires_at ? ` · ends ${relative(poll.expires_at)}` : ''}`));
    for (const answer of poll.answers) {
      const percent = total ? Math.round((answer.votes / total) * 100) : 0;
      node.append(el('button', {
        class: `btn ${answer.me_voted ? 'btn-primary' : 'btn-outline'}`,
        style: { width: '100%', justifyContent: 'space-between', marginBottom: '6px', position: 'relative', overflow: 'hidden' },
        disabled: poll.ended,
        onclick: async () => {
          try {
            const data = await api.votePoll(poll.id, [answer.id]);
            renderPollInto(clear(node), data.poll);
          } catch { /* handled */ }
        },
      }, [
        el('span', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: `${percent}%`, background: 'rgba(46,196,166,.18)' } }),
        el('span', { style: { position: 'relative' } }, answer.text),
        el('span', { style: { position: 'relative' } }, `${percent}%`),
      ]));
    }
  }

  function reactionsNode(message) {
    const wrap = el('div', { class: 'msg-reactions' });
    for (const reaction of message.reactions) {
      const isCustom = window.Bla.isCustomEmoji(reaction.emoji);
      const parts = isCustom ? window.Bla.customEmojiParts(reaction.emoji) : null;
      wrap.append(el('button', {
        class: `reaction ${reaction.me ? 'me' : ''}`,
        title: reaction.users.map((u) => S.displayName(u)).join(', '),
        onclick: async () => {
          try {
            if (reaction.me) await api.unreact(message.id, reaction.emoji);
            else await api.react(message.id, reaction.emoji);
          } catch { /* handled */ }
        },
      }, [
        isCustom
          ? el('img', { class: 'emoji', src: window.Bla.emojiUrl(parts.id, parts.animated), alt: reaction.emoji })
          : el('span', {}, reaction.emoji),
        el('span', {}, String(reaction.count)),
      ]));
    }
    wrap.append(el('button', {
      class: 'reaction',
      title: 'Add reaction',
      onclick: (event) => window.BlaModals.emojiPicker(event, async (emoji) => {
        try { await api.react(message.id, emoji); } catch { /* handled */ }
      }),
    }, [icon('emoji', 'icon')]));
    return wrap;
  }

  function toolbar(message) {
    const isMine = String(message.author?.id) === String(state.me?.id);
    const canManage = S.canInChannel(message.channel_id, S.PERM.MANAGE_MESSAGES);
    return el('div', { class: 'msg-toolbar' }, [
      el('button', {
        class: 'icon-btn', 'data-tip': 'Add reaction',
        onclick: (event) => window.BlaModals.emojiPicker(event, async (emoji) => {
          try { await api.react(message.id, emoji); } catch { /* handled */ }
        }),
      }, [icon('emoji')]),
      el('button', { class: 'icon-btn', 'data-tip': 'Reply', onclick: () => startReply(message) }, [icon('reply')]),
      el('button', { class: 'icon-btn', 'data-tip': 'More', onclick: (event) => messageMenu(event, message) }, [icon('more')]),
      isMine ? el('button', { class: 'icon-btn', 'data-tip': 'Edit', onclick: () => startEdit(message) }, [icon('edit')]) : null,
      isMine || canManage ? el('button', {
        class: 'icon-btn danger', 'data-tip': 'Delete',
        onclick: async () => {
          try { await api.deleteMessage(message.id); } catch { /* handled */ }
        },
      }, [icon('trash')]) : null,
    ]);
  }

  function messageMenu(event, message) {
    const isMine = String(message.author?.id) === String(state.me?.id);
    const canManage = S.canInChannel(message.channel_id, S.PERM.MANAGE_MESSAGES);
    showMenu(event, [
      { label: 'Add reaction', icon: 'emoji', action: (e) => window.BlaModals.emojiPicker(event, async (emoji) => {
        try { await api.react(message.id, emoji); } catch { /* handled */ }
      }) },
      { label: 'Reply', icon: 'reply', action: () => startReply(message) },
      { label: 'Mark unread', icon: 'bell', action: async () => {
        const previous = S.channelMessages(message.channel_id).find((m) => BigInt(m.id) < BigInt(message.id));
        await api.ack(message.channel_id, { message_id: previous ? previous.id : 0 });
        S.setReadState(message.channel_id, { last_message_id: previous ? previous.id : 0, unread: true });
        toast('Marked as unread');
      } },
      { type: 'separator' },
      { label: 'Copy text', icon: 'copy', disabled: !message.content, action: async () => { await copy(message.content); toast('Copied'); } },
      { label: 'Copy message id', icon: 'copy', action: async () => { await copy(message.id); toast('Copied'); } },
      { label: 'Copy link', icon: 'link', action: async () => {
        const link = `${location.origin}/#/guild/${message.guild_id}/channel/${message.channel_id}/${message.id}`;
        await copy(link); toast('Copied');
      } },
      { label: (message.pinned ? 'Unpin' : 'Pin'), icon: 'pin', disabled: !canManage, action: async () => {
        try {
          if (message.pinned) await api.unpin(message.channel_id, message.id);
          else await api.pin(message.channel_id, message.id);
          toast(message.pinned ? 'Unpinned' : 'Pinned');
        } catch { /* handled */ }
      } },
      { type: 'separator' },
      isMine ? { label: 'Edit message', icon: 'edit', action: () => startEdit(message) } : null,
      isMine || canManage ? {
        label: 'Delete message', icon: 'trash', danger: true,
        action: async () => { try { await api.deleteMessage(message.id); } catch { /* handled */ } },
      } : null,
    ].filter(Boolean));
  }

  function scrollToMessage(messageId) {
    const node = document.getElementById(messageNodeKey(messageId));
    if (node) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node.classList.add('mentioned');
      setTimeout(() => node.classList.remove('mentioned'), 1500);
      return;
    }
    if (S.currentChannel()) open(S.currentChannel().id, { jumpTo: messageId });
  }

  async function loadOlder(channelId) {
    if (loadingOlder) return;
    const messages = S.channelMessages(channelId);
    if (!messages.length) return;
    loadingOlder = true;
    const container = $('#messages');
    const previousHeight = container.scrollHeight;
    try {
      const data = await api.messages(channelId, { limit: 50, before: messages[0].id });
      if (data.messages.length) {
        S.setMessages(channelId, data.messages, { prepend: true });
        state.hasMore.set(String(channelId), data.has_more);
        renderAll(channelId);
        container.scrollTop = container.scrollHeight - previousHeight;
      } else {
        state.hasMore.set(String(channelId), false);
      }
    } finally {
      loadingOlder = false;
    }
  }

  /* ── incremental updates ───────────────────────────────────────── */
  function onNewMessage(message) {
    if (String(message.channel_id) !== String(state.view.channelId)) return;
    if (editing && String(editing.id) === String(message.id)) return;
    const container = $('#messages');
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    container.append(renderMessage(message, message.channel_id));
    if (nearBottom) container.scrollTop = container.scrollHeight;
    else showJumpButton();
  }

  function showJumpButton() {
    if ($('.jump-present')) return;
    const container = $('#messages');
    const node = el('button', {
      class: 'jump-present',
      onclick: () => { container.scrollTop = container.scrollHeight; node.remove(); },
    }, [icon('chevronDown'), 'Jump to present']);
    container.append(node);
  }

  function onMessageUpdate(message) {
    const node = document.getElementById(messageNodeKey(message.id));
    if (!node) return;
    const parent = node.closest('.msg-group');
    if (!parent) return;
    const fresh = renderMessage(message, message.channel_id);
    parent.replaceWith(fresh);
  }

  function onMessageRemove({ channelId, messageId }) {
    const node = document.getElementById(messageNodeKey(messageId));
    if (node) node.closest('.msg-group')?.remove();
  }

  function onReaction({ message_id, channel_id }) {
    const message = S.channelMessages(channel_id).find((m) => String(m.id) === String(message_id));
    if (!message) return;
    api.messages(channel_id, { around: message_id, limit: 1 }).then((data) => {
      if (data.messages[0]) S.updateMessage(data.messages[0]);
    }).catch(() => {});
  }

  /* ── composer ──────────────────────────────────────────────────── */
  function renderComposer() {
    const wrap = $('#composer-wrap');
    clear(wrap);
    const channel = S.currentChannel();
    if (!channel || channel.type === 2 || channel.type === 13) return;

    const isDm = !channel.guild_id;
    const canSend = isDm || S.canInChannel(channel.id, S.PERM.SEND_MESSAGES);

    if (!canSend) {
      wrap.append(el('div', { class: 'composer disabled' }, [
        el('div', { class: 'composer-row' }, [el('span', { class: 'faint' }, 'You do not have permission to send messages in this channel.')]),
      ]));
      return;
    }

    const textarea = el('textarea', {
      rows: 1,
      placeholder: `Message ${isDm ? '' : '#'}${channel.name || ''}`,
      maxLength: 4000,
      value: state.drafts.get(String(channel.id)) || '',
    });
    const attachmentsRow = el('div', { class: 'composer-attachments' });
    const replyBar = el('div', { class: 'composer-reply', hidden: true });

    const fileInput = el('input', {
      type: 'file', multiple: true, style: { display: 'none' },
      onchange: (event) => addFiles([...event.target.files]),
    });

    const sendButton = el('button', { class: 'btn btn-primary btn-sm', 'data-tip': 'Send' }, [icon('right')]);

    const composer = el('div', { class: 'composer' }, [
      replyBar,
      attachmentsRow,
      el('div', { class: 'composer-row' }, [
        el('div', { class: 'composer-buttons' }, [
          el('button', { class: 'icon-btn', 'data-tip': 'Upload a file', onclick: () => fileInput.click() }, [icon('paperclip')]),
          el('button', {
            class: 'icon-btn', 'data-tip': 'Emoji',
            onclick: (event) => window.BlaModals.emojiPicker(event, (emoji) => insertAtCursor(textarea, emoji)),
          }, [icon('emoji')]),
          el('button', {
            class: 'icon-btn', 'data-tip': 'Sticker',
            onclick: (event) => stickerPicker(event, textarea),
          }, [icon('sticker2')]),
          el('button', {
            class: 'icon-btn', 'data-tip': 'Poll',
            onclick: () => pollComposer(textarea, sendButton.click),
          }, [icon('poll')]),
          S.can(S.PERM.USE_SOUNDBOARD, channel.guild_id) && (S.currentGuild()?.soundboard?.length)
            ? el('button', {
              class: 'icon-btn', 'data-tip': 'Soundboard',
              onclick: () => window.BlaVoice.playSoundboard(),
            }, [icon('music')])
            : null,
        ]),
        textarea,
        sendButton,
        fileInput,
      ]),
      el('div', { class: 'composer-hint' }, [
        el('span', {}, 'Enter to send · Shift+Enter for a new line'),
        channel.slowmode ? el('span', {}, `Slowmode: ${channel.slowmode}s`) : null,
        el('span', { class: 'char-count' }, ''),
      ]),
    ]);

    const updateReplyBar = () => {
      clear(replyBar);
      if (!replyTo) { replyBar.hidden = true; return; }
      replyBar.hidden = false;
      replyBar.append(
        el('span', {}, 'Replying to '),
        el('span', { class: 'who' }, S.displayName(replyTo.author)),
        el('span', { class: 'faint' }, M.plain(replyTo.content, 80) || 'attachment'),
        el('button', { class: 'icon-btn', onclick: () => { replyTo = null; updateReplyBar(); } }, [icon('close')]),
      );
    };
    updateReplyBar();

    const updateCount = () => {
      const count = textarea.value.length;
      const node = composer.querySelector('.char-count');
      node.textContent = count > 3500 ? `${count}/4000` : '';
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.45)}px`;
    };
    textarea.addEventListener('input', () => {
      updateCount();
      S.setDraft(channel.id, textarea.value);
      if (textarea.value) window.BlaGateway.typing(channel.id);
      autocomplete(textarea);
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
        event.preventDefault();
        send();
      } else if (event.key === 'Escape') {
        if (editing) cancelEdit();
        replyTo = null;
        updateReplyBar();
      } else if (event.key === 'ArrowUp' && !textarea.value) {
        // Edit your last message, like every good chat client.
        const mine = [...S.channelMessages(channel.id)].reverse().find((m) => String(m.author?.id) === String(state.me?.id) && !m.system && m.content);
        if (mine) { event.preventDefault(); startEdit(mine); }
      }
    });
    textarea.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) { event.preventDefault(); addFiles(files); }
    });

    sendButton.addEventListener('click', () => send());

    composer.addEventListener('dragover', (event) => { event.preventDefault(); composer.style.outline = '2px dashed var(--accent)'; });
    composer.addEventListener('dragleave', () => { composer.style.outline = ''; });
    composer.addEventListener('drop', (event) => {
      event.preventDefault();
      composer.style.outline = '';
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) addFiles(files);
    });

    async function addFiles(files) {
      for (const file of files.slice(0, 10)) {
        if (file.size > (state.config?.max_upload_mb || 100) * 1024 * 1024) {
          toast('File too large', `${file.name} exceeds the ${state.config?.max_upload_mb || 100} MB limit.`, 'error');
          continue;
        }
        const placeholder = el('div', { class: 'attachment-file' }, [
          icon('upload', 'icon'),
          el('div', { class: 'meta' }, [
            el('div', { class: 'fname' }, file.name),
            el('div', { class: 'fsize' }, `${formatBytes(file.size)} · uploading…`),
          ]),
        ]);
        attachmentsRow.append(placeholder);
        try {
          const data = await api.upload(file, 'attachment', {
            voice_message: file.type.startsWith('audio/') && file.name.match(/voice|recording/i) ? '1' : undefined,
          });
          pendingAttachments.push(data.attachment);
          clear(placeholder);
          placeholder.append(
            icon('check', 'icon'),
            el('div', { class: 'meta' }, [
              el('div', { class: 'fname' }, file.name),
              el('div', { class: 'fsize' }, formatBytes(file.size)),
            ]),
            el('button', {
              class: 'icon-btn', onclick: () => {
                pendingAttachments = pendingAttachments.filter((a) => a.id !== data.attachment.id);
                placeholder.remove();
                api.del(`/attachments/${data.attachment.id}`, undefined, { silent: true }).catch(() => {});
              },
            }, [icon('close')]),
          );
        } catch (err) {
          placeholder.style.opacity = '.5';
        }
      }
    }

    async function send() {
      const content = textarea.value;
      if (!content.trim() && !pendingAttachments.length) return;
      const attachments = [...pendingAttachments];
      const reference = replyTo;
      textarea.value = '';
      pendingAttachments = [];
      replyTo = null;
      updateReplyBar();
      clear(attachmentsRow);
      clear(composer.querySelector('.char-count'));
      S.setDraft(channel.id, '');

      try {
        await api.sendMessage(channel.id, {
          content,
          attachment_ids: attachments.map((a) => Number(a.id)),
          nonce: String(Date.now()),
          message_reference: reference ? { message_id: reference.id } : undefined,
        });
      } catch (err) {
        textarea.value = content;
        pendingAttachments = attachments;
        if (err.code === 'SLOWMODE') {
          textarea.disabled = true;
          setTimeout(() => { textarea.disabled = false; textarea.focus(); }, (err.payload?.retry_after || 3) * 1000);
        }
      }
    }

    window.BlaChat._send = send;
    window.BlaChat._textarea = textarea;

    wrap.append(composer);
    if (isDm) {
      wrap.append(el('div', { class: 'composer-hint' }, [
        el('span', {}, 'Direct messages are end-to-end encrypted in transit to your own server. Nothing leaves this instance.'),
      ]));
    }
    setTimeout(() => textarea.focus(), 20);
    updateCount();
  }

  function startReply(message) {
    replyTo = message;
    renderComposer();
    window.BlaChat._textarea?.focus();
  }

  function startEdit(message) {
    editing = message;
    const node = document.getElementById(messageNodeKey(message.id));
    node?.classList.add('editing');
    renderComposer();
    const textarea = window.BlaChat._textarea;
    textarea.value = message.content;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const wrap = $('#composer-wrap');
    wrap.prepend(el('div', { class: 'composer-reply' }, [
      el('span', { class: 'who' }, 'Editing message'),
      el('span', { class: 'faint' }, M.plain(message.content, 80)),
      el('button', { class: 'icon-btn', onclick: () => cancelEdit() }, [icon('close')]),
    ]));

    const sendButton = wrap.querySelector('.btn-primary');
    const clone = sendButton.cloneNode(true);
    sendButton.replaceWith(clone);
    clone.addEventListener('click', submitEdit);
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitEdit(); }
    });

    async function submitEdit() {
      const content = textarea.value;
      try {
        const data = await api.editMessage(message.id, content);
        S.updateMessage(data.message);
        cancelEdit();
      } catch { /* handled */ }
    }
  }

  function cancelEdit() {
    editing = null;
    $('#composer-wrap').querySelector('.composer-reply')?.remove();
    document.querySelectorAll('.msg.editing').forEach((n) => n.classList.remove('editing'));
    renderComposer();
  }

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
    textarea.focus();
    textarea.setSelectionRange(start + text.length, start + text.length);
    textarea.dispatchEvent(new Event('input'));
  }

  function stickerPicker(event, textarea) {
    const guild = S.currentGuild();
    const stickers = guild?.stickers || [];
    if (!stickers.length) return toast('No stickers yet', 'Upload some in Server Settings → Emoji & Stickers.', 'error');
    showMenu(event, stickers.map((sticker) => ({
      label: sticker.name,
      action: () => {
        if (sticker.format_type === 3) insertAtCursor(textarea, `:${sticker.name}:`);
        else toast('Sticker picked', sticker.name);
      },
    })));
  }

  function pollComposer(textarea, onSend) {
    const question = el('input', { type: 'text', placeholder: 'Ask a question…' });
    const answerInputs = [el('input', { type: 'text', placeholder: 'Answer 1' }), el('input', { type: 'text', placeholder: 'Answer 2' })];
    const extra = el('div', {});
    const multi = el('input', { type: 'checkbox' });
    const duration = el('select', {}, [
      el('option', { value: '3600' }, '1 hour'),
      el('option', { value: '21600' }, '6 hours'),
      el('option', { value: '86400', selected: true }, '24 hours'),
      el('option', { value: '604800' }, '7 days'),
    ]);
    const controller = window.BlaModals.openModal({
      title: 'Create a poll',
      size: 'sm',
      body: el('div', {}, [
        el('div', { class: 'field' }, [el('span', {}, 'Question'), question]),
        el('div', { class: 'field' }, [el('span', {}, 'Answers'), ...answerInputs, extra]),
        el('button', {
          class: 'btn btn-outline btn-sm',
          onclick: () => {
            if (answerInputs.length + extra.children.length >= 10) return;
            const input = el('input', { type: 'text', placeholder: `Answer ${answerInputs.length + extra.children.length + 1}`, style: { marginTop: '8px' } });
            extra.append(input);
          },
        }, [icon('plus'), 'Add answer']),
        el('label', { class: 'switch' }, [el('span', { class: 'switch-label' }, 'Allow multiple answers'), multi]),
        el('div', { class: 'field' }, [el('span', {}, 'Duration'), duration]),
      ]),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => controller.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const answers = [...answerInputs, ...extra.children].map((input) => input.value.trim()).filter(Boolean);
            if (!question.value.trim() || answers.length < 2) return toast('Need a question and 2+ answers', '', 'error');
            controller.close();
            try {
              await api.sendMessage(S.currentChannel().id, {
                content: '',
                poll: {
                  question: question.value.trim(),
                  answers: answers.map((text) => ({ text })),
                  allow_multiselect: multi.checked,
                  duration: Number(duration.value),
                },
              });
            } catch { /* handled */ }
          },
        }, 'Post poll'),
      ],
    });
    setTimeout(() => question.focus(), 40);
  }

  /* ── @ / # / : autocomplete ────────────────────────────────────── */
  const autocompleteState = { active: false, items: [], index: 0, type: null, query: '', start: 0 };

  function autocomplete(textarea) {
    const value = textarea.value;
    const caret = textarea.selectionStart;
    const before = value.slice(0, caret);
    const match = /(^|\s)([@#:])([\w\u00C0-\u024F-]*)$/.exec(before);
    closeAutocomplete();
    if (!match) return;

    const [, , trigger, query] = match;
    const start = caret - query.length - 1;
    let items = [];

    if (trigger === '@') {
      const guild = S.currentGuild();
      const members = guild ? guild.members : [];
      items = members
        .filter((m) => S.displayName(m.user, guild.id).toLowerCase().includes(query.toLowerCase()) ||
          m.user.username.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8)
        .map((m) => ({ label: S.displayName(m.user, guild.id), insert: `<@${m.user_id}>`, sub: m.user.username, user: m.user }));
      if (query === '' || 'everyone'.includes(query)) {
        const canPing = S.can(S.PERM.MENTION_EVERYONE, S.currentGuild()?.id);
        if (canPing) items.unshift({ label: 'everyone', insert: '@everyone', sub: 'Notify the whole server', raw: true });
      }
      const roles = S.currentGuild()?.roles.filter((r) => !r.is_everyone && r.mentionable && r.name.toLowerCase().includes(query.toLowerCase())) || [];
      for (const role of roles.slice(0, 4)) {
        items.push({ label: `@${role.name}`, insert: `<@&${role.id}>`, sub: 'Role', color: role.color, raw: true });
      }
    } else if (trigger === '#') {
      const guild = S.currentGuild();
      const channels = guild ? guild.channels.filter((c) => c.type !== 4) : [];
      items = channels
        .filter((c) => (c.name || '').toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8)
        .map((c) => ({ label: `#${c.name}`, insert: `<#${c.id}>`, sub: 'Channel', raw: true }));
    } else {
      const guild = S.currentGuild();
      const emojis = (guild?.emojis || [])
        .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 6)
        .map((e) => ({ label: e.name, insert: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`, image: e.url, raw: true }));
      const unicode = [];
      for (const [, list] of window.Bla.emojiCategories()) {
        for (const emoji of list) {
          if (!query) break;
          unicode.push(emoji);
          if (unicode.length > 20) break;
        }
      }
      items = [...emojis, ...unicode.slice(0, 8).map((e) => ({ label: e, insert: e, emoji: e, raw: true }))];
    }

    if (!items.length) return;
    autocompleteState.active = true;
    autocompleteState.items = items;
    autocompleteState.index = 0;
    autocompleteState.type = trigger;
    autocompleteState.start = start;

    const box = el('div', {
      class: 'menu',
      style: { position: 'absolute', bottom: '100%', left: '50px', marginBottom: '8px' },
      id: 'autocomplete-box',
    });
    items.forEach((item, index) => {
      box.append(el('button', {
        class: 'menu-item',
        style: index === 0 ? { background: 'var(--accent)', color: 'var(--accent-text)' } : {},
        onclick: () => applyAutocomplete(item),
      }, [
        item.image ? el('img', { src: item.image, style: { width: '20px', height: '20px' } })
          : item.user ? R.avatar(item.user, { size: 20 })
            : item.emoji ? el('span', { style: { fontSize: '18px' } }, item.emoji)
              : icon(item.label.startsWith('@') ? 'mention' : 'hash', 'icon'),
        el('span', { style: item.color ? { color: `#${item.color.toString(16).padStart(6, '0')}` } : {} }, item.label),
        item.sub ? el('span', { class: 'menu-hint' }, item.sub) : null,
      ]));
    });
    const composer = textarea.closest('.composer');
    composer.style.position = 'relative';
    composer.append(box);

    function applyAutocomplete(item) {
      const value2 = textarea.value;
      const caret2 = textarea.selectionStart;
      textarea.value = `${value2.slice(0, autocompleteState.start)}${item.insert} ${value2.slice(caret2)}`;
      closeAutocomplete();
      textarea.focus();
      const newCaret = autocompleteState.start + item.insert.length + 1;
      textarea.setSelectionRange(newCaret, newCaret);
      textarea.dispatchEvent(new Event('input'));
    }

    textarea.addEventListener('keydown', handleKeys, { once: false });
    function handleKeys(event) {
      if (!autocompleteState.active) { textarea.removeEventListener('keydown', handleKeys); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...box.querySelectorAll('.menu-item')];
        buttons.forEach((b) => { b.style.background = ''; b.style.color = ''; });
        autocompleteState.index = (autocompleteState.index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        const active = buttons[autocompleteState.index];
        active.style.background = 'var(--accent)';
        active.style.color = 'var(--accent-text)';
      } else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        applyAutocomplete(items[autocompleteState.index]);
      } else if (event.key === 'Escape') {
        closeAutocomplete();
      }
    }
    window.BlaChat._autocompleteClose = closeAutocomplete;
  }

  function closeAutocomplete() {
    document.getElementById('autocomplete-box')?.remove();
    autocompleteState.active = false;
  }

  /* ── typing bar ────────────────────────────────────────────────── */
  function renderTyping(channelId) {
    const bar = $('#typing-bar');
    const names = S.typingNames(channelId).filter((n) => String(n.id) !== String(state.me?.id));
    if (!names.length) { if (bar) bar.remove(); return; }
    const text = names.length === 1
      ? `${names[0].name} is typing`
      : names.length === 2
        ? `${names[0].name} and ${names[1].name} are typing`
        : 'Several people are typing';
    const node = bar || el('div', { class: 'typing-bar', id: 'typing-bar' });
    clear(node).append(el('span', { class: 'typing-dots' }, [el('i'), el('i'), el('i')]), el('span', {}, text));
    if (!bar) $('#composer-wrap').prepend(node);
  }

  function renderVoicePlaceholder(container, channel) {
    const occupants = [...state.voiceStates.values()].filter((v) => String(v.channel_id) === String(channel.id));
    container.append(el('div', { class: 'empty-state' }, [
      icon('volume'),
      el('h2', {}, channel.name),
      el('p', {}, occupants.length ? `${occupants.length} people are in here right now.` : 'Nobody is in this voice channel yet.'),
      el('button', { class: 'btn btn-primary', onclick: () => window.BlaVoice.join(channel.id) }, [icon('volume'), 'Join voice']),
    ]));
  }

  window.BlaChat = {
    open, renderAll, onNewMessage, onMessageUpdate, onMessageRemove, onReaction, renderComposer,
    renderTyping, loadOlder, scrollToMessage, replyTo: () => replyTo, autocomplete,
  };
}());
