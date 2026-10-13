/* Bla — tiny DOM + formatting helpers. No framework, no build step. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** el('div', {class:'x', onclick:fn}, [children|string]) */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'open') node[key] = !!value;
      else node.setAttribute(key, value);
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function frag(children) {
    const f = document.createDocumentFragment();
    append(f, children);
    return f;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function svg(path, viewBox = '0 0 24 24') {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', viewBox);
    node.setAttribute('fill', 'currentColor');
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = path;
    return node;
  }

  /* ── icons (24x24, currentColor) ──────────────────────────────── */
  const I = {
    hash: '<path d="M10 3a1 1 0 0 1 .99.86L11.7 8h4.2l-.55-4.14a1 1 0 0 1 1.98-.26L17.9 8H21a1 1 0 0 1 0 2h-3.4l.6 4H21a1 1 0 0 1 0 2h-2.5l.55 4.14a1 1 0 1 1-1.98.26L16.6 16h-4.2l.55 4.14a1 1 0 1 1-1.98.26L10.5 16H7a1 1 0 0 1 0-2h3.8l-.6-4H7a1 1 0 0 1 0-2h2.9l-.55-4.14A1 1 0 0 1 10 3Zm3.6 7H9.4l.6 4h4.2l-.6-4Z"/>',
    volume: '<path d="M13 4.06a1 1 0 0 1 1.7.7v14.48a1 1 0 0 1-1.7.7L8.3 16H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3.3L13 4.06ZM18.4 8.2a1 1 0 0 1 1.4.2 6 6 0 0 1 0 7.2 1 1 0 0 1-1.6-1.2 4 4 0 0 0 0-4.8 1 1 0 0 1 .2-1.4Z"/>',
    mic: '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 0 1 2 0 7 7 0 0 1-6 6.93V20h2.5a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2H11v-2.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"/>',
    micOff: '<path d="M15 12V6a3 3 0 0 0-5.7-1.3L15 11.9V12Zm-4 .8L9 10.8V11a3 3 0 0 0 2 2.8ZM17 11a1 1 0 01 2 0 7 7 0 0 1-.6 2.8l-1.6-1.2A5 5 0 0 0 17 11Zm-5 5.9V19h2.5a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2H10v-2.1A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 0 0 9.6 2l1.5 1.2A7 7 0 0 1 12 16.9ZM3.3 2.3a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4l-17-17a1 1 0 0 1 0-1.4Z"/>',
    headphones: '<path d="M12 3a9 9 0 0 0-9 9v5a3 3 0 0 0 3 3h1.5a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 7.5 12H6a6 6 0 0 1 12 0h-1.5A1.5 1.5 0 0 0 15 13.5v5A1.5 1.5 0 0 0 16.5 20H18a3 3 0 0 0 3-3v-5a9 9 0 0 0-9-9Z"/>',
    deafened: '<path d="M12 3a9 9 0 0 0-9 9v5a3 3 0 0 0 3 3h1.5A1.5 1.5 0 0 0 9 18.5v-5A1.5 1.5 0 0 0 7.5 12H6a6 6 0 0 1 12 0h-1.5A1.5 1.5 0 0 0 15 13.5v5A1.5 1.5 0 0 0 16.5 20H18a3 3 0 0 0 3-3v-5a9 9 0 0 0-9-9ZM3.3 2.3a1 1 0 0 0 0 1.4l17 17a1 1 0 0 0 1.4-1.4l-17-17a1 1 0 0 0-1.4 0Z"/>',
    gear: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5a2 2 0 0 1 1.9 1.37l.1.32.33.05a7.6 7.6 0 0 1 1.5.62l.29.16.3-.16a2 2 0 0 1 2.71.72l.05.1a2 2 0 0 1-.36 2.5l-.23.24.13.31c.2.47.35.97.43 1.48l.05.34.3.16a2 2 0 0 1 .1 3.42l-.1.06-.3.16-.05.34a7.6 7.6 0 0 1-.43 1.48l-.13.31.23.24a2 2 0 0 1 .36 2.5l-.05.1a2 2 0 0 1-2.71.72l-.3-.16-.29.16a7.6 7.6 0 0 1-1.5.62l-.34.05-.09.32a2 2 0 0 1-3.8 0l-.1-.32-.33-.05a7.6 7.6 0 0 1-1.5-.62l-.29-.16-.3.16a2 2 0 0 1-2.71-.72l-.05-.1a2 2 0 0 1 .36-2.5l.23-.24-.13-.31a7.6 7.6 0 0 1-.43-1.48l-.05-.34-.3-.16a2 2 0 0 1-.1-3.42l.1-.06.3-.16.05-.34c.08-.51.23-1.01.43-1.48l.13-.31-.23-.24a2 2 0 0 1-.36-2.5l.05-.1a2 2 0 0 1 2.71-.72l.3.16.29-.16a7.6 7.6 0 0 1 1.5-.62l.34-.05.09-.32A2 2 0 0 1 12 3Z"/>',
    plus: '<path d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 0 1 0 2h-5v5a1 1 0 0 1-2 0v-5H6a1 1 0 0 1 0-2h5V6a1 1 0 0 1 1-1Z"/>',
    chevron: '<path d="M12.7 6.3a1 1 0 0 0-1.4 0l-5 5a1 1 0 0 0 1.4 1.4L12 8.4l4.3 4.3a1 1 0 0 0 1.4-1.4l-5-5Z"/>',
    chevronDown: '<path d="M5.3 8.3a1 1 0 0 1 1.4 0L12 13.6l5.3-5.3a1 1 0 1 1 1.4 1.4l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4Z"/>',
    users: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-7 2c-3.3 0-6 1.6-6 3.5V19h12v-2.5c0-1.9-2.7-3.5-6-3.5Zm8.5 2c-.9 0-1.7.1-2.4.3.9.8 1.4 1.7 1.4 2.7V19H22v-1.5c0-1.6-2-2.5-4.5-2.5Z"/>',
    search: '<path d="M10 3a7 7 0 1 0 4.2 12.6l4.1 4.1a1 1 0 0 0 1.4-1.4l-4.1-4.1A7 7 0 0 0 10 3Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z"/>',
    pin: '<path d="M14.5 2a1 1 0 0 1 .8 1.6l-1.6 2.1 4.6 4.6a1 1 0 0 1-.5 1.7l-3.3.5-3.6 3.6.6 2.4a1 1 0 0 1-1.7.9l-3.4-3.4-3.9 3.9a1 1 0 0 1-1.4-1.4l3.9-3.9L1.3 12a1 1 0 0 1 .9-1.7l2.4.6L8.2 7.3l.5-3.3a1 1 0 0 1 1.7-.5l4.6 4.6 2.1-1.6A1 1 0 0 1 14.5 2Z"/>',
    reply: '<path d="M10.7 4.3a1 1 0 0 1 .3.7v3.2c5 .3 8.9 3.6 8.9 8.4v1.9a1 1 0 0 1-1.8.6c-1.3-1.9-3.6-3-6.2-3.2v3.4a1 1 0 0 1-1.7.7l-7-6.3a1 1 0 0 1 0-1.4l7-6.6a1 1 0 0 1 1.5-.4Z"/>',
    edit: '<path d="M4 17.4 3.1 21l3.6-.9L19.4 7.4a2.5 2.5 0 0 0-3.5-3.5L4 17.4Z"/>',
    trash: '<path d="M9 3a1 1 0 0 0-.9.6L7.4 5H4a1 1 0 0 0 0 2h16a1 1 0 0 0 0-2h-3.4l-.7-1.4A1 1 0 0 0 15 3H9ZM5.5 8.6 6.3 19a2 2 0 0 0 2 1.9h7.4a2 2 0 0 0 2-1.9l.8-10.4-13-.0Z"/>',
    emoji: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm-8.2 6.6a1 1 0 0 1 1.4.1 4.6 4.6 0 0 0 7.1 0 1 1 0 0 1 1.5 1.3 6.6 6.6 0 0 1-10.1 0 1 1 0 0 1 .1-1.4Z"/>',
    paperclip: '<path d="M17.5 6.5 9.6 14.4a1.5 1.5 0 0 0 2.1 2.1l7.2-7.2a3.5 3.5 0 0 0-5-5L5 13.2a5.5 5.5 0 0 0 7.8 7.8l8.5-8.5a1 1 0 0 0-1.4-1.4l-8.5 8.5a3.5 3.5 0 0 1-5-5l8.9-8.9a1.5 1.5 0 0 1 2.1 2.1Z"/>',
    gif: '<path d="M3 5h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm3 4v6h2.4a2.4 2.4 0 0 0 2.4-2.4v-1.2A2.4 2.4 0 0 0 8.4 9H6Zm2 1.4h.4c.5 0 .9.4.9.9v1.4c0 .5-.4.9-.9.9H8v-3.2Zm4.6-1.4v6h1.6v-6h-1.6Zm3.2 0v6h1.7v-2h1.6v-1.4h-1.6v-1.2h2V9h-3.7Z"/>',
    sticker: '<path d="M12 2a10 10 0 1 0 10 10c0-.4-.05-.7-.14-1H17a4 4 0 0 1-4 4 1 1 0 0 0-1 1v4.86A10 10 0 0 0 12 2Zm-4.5 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm12.4 3.4 4.4-4.4c.5.9.9 2 1.1 3.1l-4.6 4.6c-.3-.6-.7-1.2-1.2-1.7-.6-.5-1.2-.9-1.8-1.2ZM14 22c1.1-.2 2.2-.6 3.1-1.1L22 16c-.2 1.1-.6 2.2-1.1 3.1L16 22h-2Z"/>',
    logout: '<path d="M10 3a1 1 0 0 1 1 1 1 1 0 0 1-1 1H6v14h4a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5Zm6.3 4.3 4.5 4.2a1 1 0 0 1 0 1.4l-4.5 4.2a1 1 0 0 1-1.4-1.4l2.6-2.4H9a1 1 0 0 1 0-2h8.5l-2.6-2.4a1 1 0 0 1 1.4-1.5Z"/>',
    check: '<path d="M20.7 6.3a1 1 0 0 1 0 1.4l-10 10a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4L10 15.6l9.3-9.3a1 1 0 0 1 1.4 0Z"/>',
    close: '<path d="M6.7 5.3 12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 1 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 1 1-1.4-1.4L10.6 12 5.3 6.7a1 1 0 1 1 1.4-1.4Z"/>',
    more: '<path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>',
    link: '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l1.4-1.4a1 1 0 0 1 1.4 1.4l-1.4 1.4a1 1 0 0 1-1.4 0Zm-2.8 4.2a5 5 0 0 1 0-7.1l2.1-2.1A5 5 0 0 1 17 8.3a1 1 0 1 1-1.4 1.4 3 3 0 0 0-4.3 0l-2.1 2.1a3 3 0 0 0 4.3 4.3l1.1-1.1a1 1 0 0 1 1.4 1.4l-1.1 1.1a5 5 0 0 1-7.1 0Zm11.3-11.3a5 5 0 0 1 0 7.1l-2.1 2.1a5 5 0 0 1-7.1-7.1 1 1 0 0 1 1.4 1.4 3 3 0 0 0 4.3 4.3l2.1-2.1a3 3 0 0 0-4.3-4.3l-1.1 1.1a1 1 0 0 1-1.4-1.4l1.1-1.1a5 5 0 0 1 7.1 0Z"/>',
    copy: '<path d="M9 2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H9Zm9 18H8a1 1 0 0 1-1-1H6a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-1a1 1 0 0 1-2 0v1Z"/>',
    video: '<path d="M4 5h11a2 2 0 0 1 2 2v3.2l4.3-2.6A1 1 0 0 1 23 8.4v7.2a1 1 0 0 1-1.7.8L17 13.8V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>',
    screen: '<path d="M3 4h18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7v2h3a1 1 0 0 1 0 2H7a1 1 0 0 1 0-2h3v-2H3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>',
    phoneOff: '<path d="M12 9c-1.6 0-3.1.3-4.5.8L5.2 7.5a19 19 0 0 1 6.8-1.3 19 19 0 0 1 6.8 1.3l-2.3 2.3c-1.4-.5-2.9-.8-4.5-.8Zm9.3 2.5-2.6 2.6c.2.6.3 1.2.3 1.9v2.3a2 2 0 0 1-2.7 1.9l-2.4-1a2 2 0 0 1-1.2-1.8v-1.5a11 11 0 0 0-1.4-.1h-1.6a11 11 0 0 0-1.4.1v1.5a2 2 0 0 1-1.2 1.8l-2.4 1A2 2 0 0 1 3 19.3V17c0-.7.1-1.3.3-1.9A15 15 0 0 1 1 13.6a1 1 0 0 1 .8-1.6c3.2 0 6.3-.6 9-1.6a16.7 16.7 0 0 1 10.2 1.5Z"/>',
    bell: '<path d="M12 2a6 6 0 0 0-6 6v3.6l-1.7 3a1 1 0 0 0 .9 1.4h13.6a1 1 0 0 0 .9-1.4l-1.7-3V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3Z"/>',
    bellOff: '<path d="M3.3 2.3a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4l-3.1-3.1H5.2a1 1 0 0 1-.9-1.4l1.7-3V8a6 6 0 0 1 8.6-5.4l1.5 1.5A6 6 0 0 0 6 8v3.6l-1.7 3c-.2.3-.2.7 0 1l12.6 3.5-13.6-13.5a1 1 0 0 1 0-1.4ZM15 19a3 3 0 0 1-6 0h6Z"/>',
    compass: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.2 5.8-2.3 6-6 2.3 2.3-6 6-2.3Z"/>',
    home: '<path d="M11.3 2.3a1 1 0 0 1 1.4 0l8 8a1 1 0 0 1-1.4 1.4l-.3-.3V20a2 2 0 0 1-2 2h-3v-6h-4v6H7a2 2 0 0 1-2-2v-8.6l-.3.3a1 1 0 0 1-1.4-1.4l8-8Z"/>',
    crown: '<path d="M3 7.5 7 11l5-6.5L17 11l4-3.5-1.4 10.5H4.4L3 7.5ZM5 19h14a1 1 0 0 1 0 2H5a1 1 0 0 1 0-2Z"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3Z"/>',
    eye: '<path d="M12 5C6.5 5 2.7 9.7 1.4 11.3a1.2 1.2 0 0 0 0 1.4C2.7 14.3 6.5 19 12 19s9.3-4.7 10.6-6.3a1.2 1.2 0 0 0 0-1.4C21.3 9.7 17.5 5 12 5Zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>',
    eyeOff: '<path d="M3.3 2.3a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4l-2.9-2.9A10.4 10.4 0 0 1 12 19c-5.5 0-9.3-4.7-10.6-6.3a1.2 1.2 0 0 1 0-1.4 17 17 0 0 1 3.9-4L3.3 3.7a1 1 0 0 1 0-1.4ZM12 8a4 4 0 0 1 4 4c0 .5-.1 1-.3 1.4l-5-5c.4-.3.9-.4 1.3-.4Z"/>',
    upload: '<path d="M12 3a1 1 0 0 1 .7.3l4 4a1 1 0 0 1-1.4 1.4L13 6.4V15a1 1 0 0 1-2 0V6.4L8.7 8.7a1 1 0 0 1-1.4-1.4l4-4A1 1 0 0 1 12 3ZM4 15a1 1 0 0 1 1 1v2h14v-2a1 1 0 0 1 2 0v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"/>',
    download: '<path d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 0 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4l2.3 2.3V4a1 1 0 0 1 1-1ZM4 15a1 1 0 0 1 1 1v2h14v-2a1 1 0 0 1 2 0v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"/>',
    bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
    server: '<path d="M4 3h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 11h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Zm3-7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>',
    clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5a1 1 0 1 0-2 0v5a1 1 0 0 0 .4.8l3 2.2a1 1 0 0 0 1.2-1.6L13 11.5V7Z"/>',
    hammer: '<path d="M14.4 2.2a1 1 0 0 1 1.4 0l1.3 1.3a1 1 0 0 1 0 1.4l-2.1 2.1 3.9 3.9a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0l-3.9-3.9-1.4 1.4a1 1 0 0 1-1.4 0l-1.4-1.4-6 6a1 1 0 0 1-1.4-1.4l6-6L2.5 9.7a1 1 0 0 1 0-1.4L4.6 6.2a1 1 0 0 1 1.4 0l1.4 1.5 1.4-1.5L14.4 2.2Z"/>',
    left: '<path d="M14.7 5.3a1 1 0 0 1 0 1.4L9.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 0Z"/>',
    right: '<path d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4L14.6 12 9.3 6.7a1 1 0 0 1 0-1.4Z"/>',
    smile: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM8.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm-8.2 6.6a1 1 0 0 1 1.4.1 4.6 4.6 0 0 0 7.1 0 1 1 0 0 1 1.5 1.3 6.6 6.6 0 0 1-10.1 0 1 1 0 0 1 .1-1.4Z"/>',
    poll: '<path d="M5 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm10 0h4a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>',
    mention: '<path d="M12 2a10 10 0 1 0 3.6 19.3 1 1 0 0 0-.7-1.9A8 8 0 1 1 20 12v1a1 1 0 0 1-2 0V8a1 1 0 0 0-2 0v.3A5 5 0 1 0 12 17a5 5 0 0 0 3.6-1.5c.6.9 1.6 1.5 2.4 1.5a3 3 0 0 0 3-3v-2a10 10 0 0 0-9-10Zm0 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>',
    edit2: '<path d="M4 17.4 3.1 21l3.6-.9L19.4 7.4a2.5 2.5 0 0 0-3.5-3.5L4 17.4Z"/>',
    ban: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A8 8 0 0 1 4 12Zm8 8a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20Z"/>',
    kick: '<path d="M13 2a3 3 0 0 1 3 3v3.1l5.3-2.6A1 1 0 0 1 23 6.4v11.2a1 1 0 0 1-1.7.9L16 15.9V19a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h8Z"/>',
    smilePlus: '<path d="M12 2a10 10 0 1 0 10 10 10 10 0 0 0-10-10Zm1 18.9a8 8 0 1 1-1-15.9v2a1 1 0 0 0 2 0v-2A8 8 0 0 1 13 20.9ZM8.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm-8.2 6.6a1 1 0 0 1 1.4.1 4.6 4.6 0 0 0 7.1 0 1 1 0 0 1 1.5 1.3 6.6 6.6 0 0 1-10.1 0 1 1 0 0 1 .1-1.4Z"/>',
    music: '<path d="M19 3a1 1 0 0 1 1.2 1v11.3a3.5 3.5 0 1 1-2-3.2V5.4l-8 1.8v9.1a3.5 3.5 0 1 1-2-3.2V6.2L19 3Z"/>',
    sticker2: '<path d="M12 2a10 10 0 1 0 10 10 10 10 0 0 0-10-10Zm4 16.9V15a1 1 0 0 1 1-1h3.9a8 8 0 0 1-4.9 4.9Z"/>',
    filter: '<path d="M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 .8 1.6L15 13.3V20a1 1 0 0 1-1.6.8l-3-2.4A1 1 0 0 1 10 17.6v-4.3L2.2 5.6A1 1 0 0 1 3 5Z"/>',
    globe: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2c1.2 0 2.6 2.3 3 6H9c.4-3.7 1.8-6 3-6ZM4.6 8h2.9a19 19 0 0 0 0 8H4.6a8 8 0 0 1 0-8Zm.9 10h2.4c.4 1.5 1 2.8 1.7 3.7A8 8 0 0 1 5.5 18Zm5.5 3c-1.2 0-2.6-2.3-3-6h6c-.4 3.7-1.8 6-3 6Zm3.9-1.3c.7-.9 1.3-2.2 1.7-3.7h2.4a8 8 0 0 1-4.1 3.7ZM16.5 16a19 19 0 0 0 0-8h2.9a8 8 0 0 1 0 8h-2.9Z"/>',
    flag: '<path d="M5 3a1 1 0 0 1 1 1v.4l3.5-.9A8 8 0 0 1 15 3.9l2.5.9a1 1 0 0 1 .7 1V14a1 1 0 0 1-1.3 1l-2.4-.8a6 6 0 0 0-4 .3L6 16.4V20a1 1 0 0 1-2 0V4a1 1 0 0 1 1-1Z"/>',
  };

  function icon(name, className) {
    const node = svg(I[name] || I.hash);
    if (className) node.setAttribute('class', className);
    return node;
  }

  /* ── formatting ────────────────────────────────────────────────── */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(ts) {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(date, today)) return `Today at ${formatTime(ts)}`;
    if (same(date, yesterday)) return `Yesterday at ${formatTime(ts)}`;
    return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) + ` at ${formatTime(ts)}`;
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function relative(ts) {
    if (!ts) return '';
    const diff = Date.now() - Number(ts);
    const units = [['y', 31536000000], ['mo', 2592000000], ['w', 604800000], ['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
    for (const [label, ms] of units) if (diff >= ms) return `${Math.floor(diff / ms)}${label} ago`;
    return 'just now';
  }

  function initials(name) {
    const clean = String(name || '?').replace(/[^\w\s-]/g, '').trim();
    if (!clean) return '?';
    const parts = clean.split(/[\s_-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.slice(0, 2).toUpperCase();
  }

  function colorFromId(id) {
    const palette = ['#2ec4a6', '#5aa9f5', '#a17bf5', '#f0b357', '#f2635f', '#5cc98a', '#e879c7', '#57d7be', '#f09b57', '#7b8ff5'];
    let hash = 0;
    for (const ch of String(id || '')) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
    return palette[hash % palette.length];
  }

  function debounce(fn, wait = 250) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function throttle(fn, wait = 1000) {
    let last = 0;
    let pending = null;
    return (...args) => {
      const now = Date.now();
      if (now - last >= wait) { last = now; fn(...args); }
      else {
        clearTimeout(pending);
        pending = setTimeout(() => { last = Date.now(); fn(...args); }, wait - (now - last));
      }
    };
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); return true; } catch { return false; } finally { ta.remove(); }
    }
  }

  function toast(title, message = '', kind = '') {
    const root = $('#toasts');
    const node = el('div', { class: `toast ${kind}` }, [
      el('div', {}, [el('b', {}, title), message ? el('div', { class: 'toast-msg' }, message) : null]),
    ]);
    root.append(node);
    setTimeout(() => {
      node.style.transition = 'opacity .2s ease';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, kind === 'error' ? 5200 : 3400);
  }

  const tooltip = {
    show(target, text) {
      const node = $('#tooltip');
      node.textContent = text;
      node.hidden = false;
      const rect = target.getBoundingClientRect();
      node.style.left = `${Math.min(Math.max(rect.left + rect.width / 2 - node.offsetWidth / 2, 6), window.innerWidth - node.offsetWidth - 6)}px`;
      node.style.top = `${rect.top - node.offsetHeight - 8 < 4 ? rect.bottom + 8 : rect.top - node.offsetHeight - 8}px`;
    },
    hide() { $('#tooltip').hidden = true; },
  };

  document.addEventListener('mouseover', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (target) tooltip.show(target, target.dataset.tip);
  });
  document.addEventListener('mouseout', (event) => {
    if (event.target.closest?.('[data-tip]')) tooltip.hide();
  });

  /* ── context menus ─────────────────────────────────────────────── */
  let openMenu = null;

  function closeMenu() {
    const root = $('#menu-root');
    if (openMenu) {
      root.classList.remove('open');
      root.innerHTML = '';
      openMenu = null;
    }
  }

  /**
   * showMenu(event, [ {label, icon, hint, danger, disabled, action} | {type:'separator'} ])
   */
  function showMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    const root = $('#menu-root');
    const menu = el('div', { class: 'menu' });
    for (const item of items.filter(Boolean)) {
      if (item.type === 'separator') { menu.append(el('div', { class: 'menu-sep' })); continue; }
      if (item.type === 'label') { menu.append(el('div', { class: 'menu-label' }, item.label)); continue; }
      const button = el('button', {
        class: `menu-item ${item.danger ? 'danger' : ''}`,
        disabled: item.disabled,
        onclick: (e) => { e.stopPropagation(); closeMenu(); item.action?.(e); },
      }, [
        item.icon ? icon(item.icon, 'icon') : null,
        el('span', {}, item.label),
        item.hint ? el('span', { class: 'menu-hint' }, item.hint) : null,
        item.checked ? icon('check', 'icon') : null,
      ]);
      menu.append(button);
    }
    root.innerHTML = '';
    root.append(el('div', { class: 'modal-backdrop', onclick: closeMenu }), menu);
    root.classList.add('open');
    const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 10);
    const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = `${Math.max(6, x)}px`;
    menu.style.top = `${Math.max(6, y)}px`;
    openMenu = menu;
  }

  document.addEventListener('click', closeMenu);
  document.addEventListener('contextmenu', (event) => {
    // Right-click anywhere that isn't a menu closes it, matching toolbars.
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);

  /* ── emoji helpers ─────────────────────────────────────────────── */
  const EMOJI_PICKER_CATEGORIES = {
    'Smileys': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👹 👺 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾',
    'People': '👋 🤚 🖐 ✋ 🖖 👌 🤏 ✌ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 👃 🧠 🦷 🦴 👀 👁 👅 👄 💋 🩸 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 🕵 💂 👷 🤴 👸 👳 👲 🧕 🤵 👰 🤰 🤱 👼 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💆 💇 🚶 🧍 🧎 🏃 💃 🕺 🕴 👯 🧖 🧗 🤺 🏇 ⛷ 🏂 🏌 🏄 🚣 🏊 ⛹ 🏋 🚴 🚵 🤸 🤼 🤽 🤾 🤹 🧘 🛀 🛌 👭 👫 👬 💏 💑 👪',
    'Animals': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🦟 🦗 🕷 🕸 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🐃 🐂 🐄 🐪 🐫 🦙 🦒 🐘 🦏 🐏 🐑 🐎 🐖 🐁 🐀 🐇 🐿 🦔 🐾 🐉 🐲 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘ 🍀 🎍 🎋 🍃 🍂 🍁 🍄 🐚 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌜 🌚 🌕 🌖 🌗 🌘 🌑 🌒 🌓 🌔 🌙 🌎 🌍 🌏 🪐 💫 ⭐ 🌟 ✨ ⚡ ☄ 💥 🔥 🌪 🌈 ☀ 🌤 ⛅ 🌥 ☁ 🌦 🌧 ⛈ 🌩 🌨 ❄ ☃ ⛄ 🌬 💨 💧 💦 ☔ ☂ 🌊 🌫',
    'Food': '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥬 🥒 🌶 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🦴 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🥫 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍴 🍽',
    'Activity': '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛴 🚲 🛵 🏍 🛺 🚗 🚕 🚙 🚌 🚎 🏎 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🦯 🦺 ⛑ 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈ 🛫 🛬 🛩 💺 🛰 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥 🛳 ⛴ 🚢 ⚓ ⛽ 🚧 🚦 🚥 🚏 🗺 🗿 🗽 🗼 🏰 🏯 🏟 🎡 🎢 🎠 ⛲ ⛱ 🏖 🏝 🏜 🌋 ⛰ 🏔 🗻 🏕 ⛺ 🏠 🏡 🏘 🏚 🏗 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛 ⛪ 🕌 🕍 🛕 🕋 ⛩ 🛤 🛣 🗾 🎑 🏞 🌅 🌄 🌠 🎇 🎆 🌇 🌆 🏙 🌃 🌌 🌉 🌁',
    'Objects': '⌚ 📱 💻 ⌨ 🖥 🖨 🖱 🖲 🕹 🗜 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽 🎞 📞 ☎ 📟 📠 📺 📻 🎙 🎚 🎛 🧭 ⏱ ⏲ ⏰ 🕰 ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯 🪔 🧯 🛢 💸 💵 💴 💶 💷 💰 💳 💎 ⚖ 🧰 🔧 🔨 ⚒ 🛠 ⛏ 🔩 ⚙ 🧱 ⛓ 🧲 🔫 💣 🧨 🪓 🔪 🗡 ⚔ 🛡 🚬 ⚰ ⚱ 🏺 🔮 📿 🧿 💈 ⚗ 🔭 🔬 🕳 🩹 🩺 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡 🧹 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪒 🧽 🧴 🛎 🔑 🗝 🚪 🪑 🛋 🛏 🛌 🧸 🖼 🛍 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🎎 🏮 🎐 🧧 ✉ 📩 📨 📧 💌 📥 📤 📦 🏷 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒 🗓 📆 📅 🗑 📇 🗃 🗳 🗄 📋 📁 📂 🗂 🗞 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇 📐 📏 🧮 📌 📍 ✂ 🖊 🖋 ✒ 🖌 🖍 📝 ✏ 🔍 🔎 🔏 🔐 🔒 🔓',
    'Symbols': '❤ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣ 💕 💞 💓 💗 💖 💘 💝 💟 ☮ ✝ ☪ 🕉 ☸ ✡ 🔯 🕎 ☯ ☦ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛ 🉑 ☢ ☣ 📴 📳 🈶 🈚 🈸 🈺 🈷 ✴ 🆚 💮 🉐 ㊙ ㊗ 🈴 🈵 🈹 🈲 🅰 🅱 🆎 🆑 🅾 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼ ⁉ 🔅 🔆 〽 ⚠ 🚸 🔱 ⚜ 🔰 ♻ ✅ 🈯 💹 ❇ ✳ ❎ 🌐 💠 Ⓜ 🌀 💤 🏧 🚾 ♿ 🅿 🈳 🈂 💲 🛂 🛃 🛄 🛅 🚹 🚺 🚼 🚻 🚮 🎦 📶 🈁 🔣 ℹ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ⏏ ▶ ⏸ ⏯ ⏹ ⏺ ⏭ ⏮ ⏩ ⏪ ⏫ ⏬ ◀ 🔼 🔽 ➡ ⬅ ⬆ ⬇ ↗ ↘ ↙ ↖ ↕ ↔ ↪ ↩ ↤ ↦ 🔀 🔁 🔂 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖ ♾ 💲 💱 ™ © ® 〰 ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✔ ☑ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪ ▫ ◾ ◽ ◼ ◻ ⬛ ⬜ 🟥 🟧 🟨 🟩 🟦 🟪 ⚑ 🏁 🚩 🎌 🏴 🏳 🏳️‍🌈',
    'Places': '🚩 🎌 🏴 🏳 🏳️‍🌈 🏳️‍⚧️ 🏁',
  };

  function emojiCategories() {
    return Object.entries(EMOJI_PICKER_CATEGORIES).map(([name, str]) => [name, str.split(/\s+/).filter(Boolean)]);
  }

  function isCustomEmoji(str) {
    return /^<a?:\w+:\d+>$/.test(String(str));
  }

  function customEmojiParts(str) {
    const match = /^<(a?):(\w+):(\d+)>$/.exec(String(str));
    if (!match) return null;
    return { animated: match[1] === 'a', name: match[2], id: match[3] };
  }

  function emojiUrl(id, animated) {
    const state = window.BlaState?.state;
    const emoji = state?.emojis?.get(String(id));
    if (emoji?.url) return emoji.url;
    return `/api/uploads/files/${id}`;
  }

  window.Bla = {
    $, $$, el, frag, clear, svg, icon, I,
    escapeHtml, formatTime, formatDate, dayKey, formatBytes, relative, initials, colorFromId,
    debounce, throttle, copy, toast, tooltip, showMenu, closeMenu,
    emojiCategories, isCustomEmoji, customEmojiParts, emojiUrl,
  };
}());
