/* Bla — message content renderer. Markdown subset + mentions + emoji, all
   built from DOM nodes (never innerHTML on user text, so injection is a
   non-issue). */
(function () {
  'use strict';
  const { el, escapeHtml, isCustomEmoji, customEmojiParts, emojiUrl } = window.Bla;

  const SAFE_LINK = /^(https?:|mailto:)/i;

  /** Render content into a DocumentFragment. */
  function render(content, context = {}) {
    const { guildId = null, channelId = null, mentions = [], channelNames = null, onChannelClick = null, onMentionClick = null } = context;
    const fragment = document.createDocumentFragment();
    if (!content) return fragment;

    const lines = String(content).split('\n');
    let codeBlock = null;
    let codeLines = [];
    let language = '';
    let quoteLines = [];

    const flushQuote = () => {
      if (!quoteLines.length) return;
      const quote = el('div', { class: 'quote' });
      for (const line of quoteLines) quote.append(el('div', {}, renderInline(line, context)));
      fragment.append(quote);
      quoteLines = [];
    };

    const flushCode = () => {
      if (codeBlock === null) return;
      const pre = el('div', { class: 'code-block' }, [
        el('code', {}, codeLines.join('\n')),
      ]);
      if (language) pre.append(el('span', { class: 'lang' }, language));
      fragment.append(pre);
      codeBlock = null;
      codeLines = [];
      language = '';
    };

    for (const line of lines) {
      const fence = /^```(\w+)?\s*$/.exec(line.trim());
      if (fence) {
        if (codeBlock === null) {
          flushQuote();
          codeBlock = true;
          language = fence[1] || '';
        } else {
          flushCode();
        }
        continue;
      }
      if (codeBlock !== null) { codeLines.push(line); continue; }

      if (line.startsWith('> ')) { quoteLines.push(line.slice(2)); continue; }
      if (line === '>') { quoteLines.push(''); continue; }
      flushQuote();
      if (line === '') { fragment.append(el('br')); continue; }
      fragment.append(el('div', {}, renderInline(line, context)));
    }
    flushQuote();
    flushCode();
    return fragment;
  }

  /** Inline markdown: **b**, *i*, __u__, ~~s~~, `code`, ||spoiler||, links. */
  function renderInline(text, context) {
    const fragment = document.createDocumentFragment();
    const pattern = new RegExp([
      '<a?:\\w+:\\d+>',                       // custom emoji
      '<@!?\\d+>',                            // user mention
      '<@&\\d+>',                             // role mention
      '<#\\d+>',                              // channel mention
      "https?://[^\\s<>\"']+",               // links
      '\\*\\*[^*]+\\*\\*', '\\*[^*]+\\*', '__[^_]+__', '~~[^~]+~~', '\\|[^|]+\\|', '`[^`]+`',
    ].join('|'), 'g');

    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
      lastIndex = pattern.lastIndex;
      fragment.append(renderToken(match[0], context));
    }
    if (lastIndex < text.length) fragment.append(document.createTextNode(text.slice(lastIndex)));
    return fragment;
  }

  function renderToken(token, context) {
    if (isCustomEmoji(token)) {
      const parts = customEmojiParts(token);
      return el('img', {
        class: 'emoji',
        src: emojiUrl(parts.id, parts.animated),
        alt: `:${parts.name}:`,
        title: `:${parts.name}:`,
        style: { width: '22px', height: '22px', verticalAlign: '-5px' },
        loading: 'lazy',
      });
    }
    if (/^<@!?\d+>$/.test(token)) {
      const id = token.replace(/\D/g, '');
      const user = window.BlaState.user(id);
      const name = window.BlaState.displayName(user, context.guildId);
      const isMe = String(window.BlaState.state.me?.id) === String(id);
      const node = el('span', { class: `mention ${isMe ? 'me' : ''}`, title: `@${user.username}` }, `@${name}`);
      if (context.onMentionClick) node.addEventListener('click', () => context.onMentionClick(user));
      return node;
    }
    if (/^<@&\d+>$/.test(token)) {
      const id = token.replace(/\D/g, '');
      const guild = window.BlaState.state.guilds.get(String(context.guildId));
      const role = guild?.roles.find((r) => String(r.id) === String(id));
      return el('span', {
        class: 'mention',
        style: role?.color ? { color: `#${role.color.toString(16).padStart(6, '0')}` } : {},
      }, `@${role ? role.name : 'role'}`);
    }
    if (/^<#\d+>$/.test(token)) {
      const id = token.replace(/\D/g, '');
      const channel = window.BlaState.state.channels.get(String(id));
      const node = el('span', { class: 'channel-ref' }, `#${channel?.name || 'channel'}`);
      if (context.onChannelClick) node.addEventListener('click', () => context.onChannelClick(id));
      return node;
    }
    if (/^https?:\/\//.test(token)) {
      const clean = token.replace(/[.,!?)]+$/, '');
      return el('a', { href: clean, target: '_blank', rel: 'noopener noreferrer' }, clean);
    }
    if (/^\*\*[^*]+\*\*$/.test(token)) return el('strong', {}, renderInline(token.slice(2, -2), context));
    if (/^\*[^*]+\*$/.test(token)) return el('em', {}, renderInline(token.slice(1, -1), context));
    if (/^__[^_]+__$/.test(token)) return el('u', {}, renderInline(token.slice(2, -2), context));
    if (/^~~[^~]+~~$/.test(token)) return el('s', {}, renderInline(token.slice(2, -2), context));
    if (/^`[^`]+`$/.test(token)) return el('span', { class: 'code-inline' }, token.slice(1, -1));
    if (/^\|[^|]+\|$/.test(token)) {
      const inner = el('span', { class: 'spoiler' }, token.slice(1, -1));
      inner.addEventListener('click', () => inner.classList.add('revealed'));
      return inner;
    }
    return document.createTextNode(token);
  }

  /** Text-only preview used for notifications and reply previews. */
  function plain(content, limit = 120) {
    const text = String(content || '')
      .replace(/<a?:(\w+):(\d+)>/g, ':$1:')
      .replace(/<@!?(\d+)>/g, (_, id) => `@${window.BlaState.user(id).username}`)
      .replace(/<@&(\d+)>/g, '@role')
      .replace(/<#(\d+)>/g, (_, id) => `#${window.BlaState.state.channels.get(String(id))?.name || 'channel'}`)
      .replace(/[`*_~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  /** True when the message is nothing but emoji (rendered bigger). */
  function isEmojiOnly(content) {
    const stripped = String(content || '')
      .replace(/<a?:\w+:\d+>/g, '')
      .replace(/[\p{Extended_Pictographic}\u200d\uFE0F]/gu, '')
      .trim();
    return stripped.length === 0 && String(content).trim().length > 0;
  }

  window.BlaMarkdown = { render, renderInline, plain, isEmojiOnly, escapeHtml, SAFE_LINK };
}());
