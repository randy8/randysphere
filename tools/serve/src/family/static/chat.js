// The family chat's page script: plain browser JavaScript, no framework, no
// build step. The server rendered the latest messages and a working form;
// this replaces them with the live conversation.

import { notificationSettings, registerWorker, syncSubscription } from './notifications.js';
import { group, openSheet, row } from './sheet.js';

const boot = JSON.parse(document.getElementById('family-boot')?.textContent ?? '{}');
const me = boot.me;
// This chat's path, /family or /disc (routes.ts): each is its own world,
// and every request here stays inside it.
const BASE = boot.base;
const zh = me.lang === 'zh';
const locale = zh ? 'zh-CN' : undefined;

const T = zh
  ? {
      today: '今天',
      yesterday: '昨天',
      delivered: '已送达',
      notDelivered: '未送达 · 轻点重试',
      connecting: '正在连接…',
      offline: '等待网络…',
      reply: '回复',
      copy: '拷贝',
      del: '删除',
      confirmDelete: '为所有人删除',
      replyingTo: (name) => `回复 ${name}`,
      newMessages: (n) => `${n} 条新消息`,
      photo: '照片',
      original: '原消息',
      you: '我',
      badPhoto: '无法读取这张照片。',
      tooBig: '这张照片太大了。',
      details: '详细信息',
      done: '完成',
      members: '成员',
      openDetails: '聊天详细信息',
    }
  : {
      today: 'Today',
      yesterday: 'Yesterday',
      delivered: 'Delivered',
      notDelivered: 'Not Delivered · Tap to try again',
      connecting: 'Connecting…',
      offline: 'Waiting for network…',
      reply: 'Reply',
      copy: 'Copy',
      del: 'Delete',
      confirmDelete: 'Delete for Everyone',
      replyingTo: (name) => `Replying to ${name}`,
      newMessages: (n) => (n === 1 ? '1 new message' : `${n} new messages`),
      photo: 'Photo',
      original: 'Original message',
      you: 'You',
      badPhoto: 'Couldn’t read that photo.',
      tooBig: 'That photo is too large.',
      details: 'Details',
      done: 'Done',
      members: 'Members',
      openDetails: 'Conversation details',
    };

const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const app = $('[data-app]');
const bar = $('.bar');
const scroller = $('[data-scroller]');
const list = $('[data-messages]');
const sentinel = $('[data-sentinel]');
const subtitle = $('[data-subtitle]');
const composer = $('[data-composer]');
const input = $('[data-input]');
const sendButton = $('[data-send]');
const attach = $('[data-attach]');
const fileInput = $('[data-file]');
const jump = $('[data-jump]');
const replyBar = $('[data-reply-bar]');
const replyText = $('[data-reply-text]');
const layer = $('[data-menu-layer]');
const finePointer = matchMedia('(pointer: fine)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const RUN_GAP_MS = 10 * 60 * 1000;
const SEPARATOR_GAP_MS = 60 * 60 * 1000;
// Both chats share this origin's storage, and their account ids overlap.
const OUTBOX_KEY = `${BASE.slice(1)}-outbox-${me.id}`;

/** @type {Map<number, any>} live messages by id */
const messages = new Map();
/** @type {Map<string, any>} unsent messages by clientId, in send order */
const pending = new Map();
/** @type {Map<string, HTMLElement>} rendered nodes by key */
const nodes = new Map();
const members = new Map();
const typers = new Map();
let rev = 0;
/** Which database the revs came from (a restore changes it; routes.ts). */
let epoch = null;
/** This tab's event stream, by the server's id for it: what presence pings name. */
let streamId = 0;
let presenceTimer = 0;
let hasMore = false;
let loadingOlder = false;
let replyTo = null;
let stick = true;
let unseen = 0;
let hiddenUnread = 0;
let source = null;
let connected = false;
let offlineTimer = 0;
let lastTypingSent = 0;
let lastReadRev = 0;
let readTimer = 0;

// ---- small helpers ----------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clientId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function nameOf(userId) {
  if (userId === me.id) return T.you;
  return members.get(userId)?.name ?? '';
}

const timeFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat(locale, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const fullFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' });

function startOfDay(at) {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** "Today 9:41", "Yesterday 21:03", "Monday 9:41", "Oct 12 9:41": the day in bold, as on a phone. */
function separatorLabel(at) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86_400_000);
  const day =
    days === 0
      ? T.today
      : days === 1
        ? T.yesterday
        : days < 7
          ? weekdayFormat.format(at)
          : new Date(at).getFullYear() === new Date().getFullYear()
            ? dateFormat.format(at)
            : yearFormat.format(at);
  const label = el('li', 'sep');
  label.setAttribute('role', 'separator');
  label.append(el('b', '', day), ` ${timeFormat.format(at)}`);
  return label;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'，。！？；：、（）「」『』【】《》]+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Text with its links made clickable — built as nodes, never as HTML. */
function linkify(text) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let raw = match[0];
    const trailing = TRAILING.exec(raw)?.[0] ?? '';
    raw = raw.slice(0, raw.length - trailing.length);
    let href;
    try {
      href = new URL(raw.startsWith('www.') ? `https://${raw}` : raw);
    } catch {
      continue;
    }
    if (href.protocol !== 'https:' && href.protocol !== 'http:') continue;
    fragment.append(text.slice(last, match.index));
    const a = el('a', '', raw);
    a.href = href.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    fragment.append(a);
    last = match.index + raw.length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

const EMOJI_ONLY =
  /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|\p{Emoji_Modifier}|‍(?:\p{Extended_Pictographic}))*\s*){1,3}$/u;

// ---- rendering --------------------------------------------------------

function excerpt(message) {
  if (!message) return T.original;
  if (message.body) return message.body.replace(/\s+/g, ' ').slice(0, 120);
  return message.image ? T.photo : T.original;
}

function messageNode(item) {
  const mine = item.userId === me.id;
  const li = el('li', `msg ${mine ? 'msg-out' : 'msg-in'}`);
  li.tabIndex = -1;
  const author = el('span', 'msg-author', nameOf(item.userId));
  author.hidden = true;
  li.append(author);

  if (item.replyTo !== null && item.replyTo !== undefined) {
    const original = messages.get(item.replyTo);
    const quote = el('div', 'quote');
    if (original) quote.append(el('b', '', nameOf(original.userId)), ` ${excerpt(original)}`);
    else quote.textContent = T.original;
    quote.dataset.replyTo = String(item.replyTo);
    li.append(quote);
  }

  const imageSrc = item.previewUrl ?? (item.image ? `${BASE}/images/${item.image.id}` : null);
  if (imageSrc) {
    const bubble = el('div', 'bubble photo');
    const img = el('img', 'bubble-image');
    img.src = imageSrc;
    img.alt = T.photo;
    img.decoding = 'async';
    img.loading = 'lazy';
    const width = item.image?.width ?? item.width;
    const height = item.image?.height ?? item.height;
    if (width > 1 && height > 1) {
      img.width = width;
      img.height = height;
      img.style.aspectRatio = `${width} / ${height}`;
    }
    bubble.append(img);
    li.append(bubble);
  }

  if (item.body) {
    const bubble = el('div', 'bubble');
    if (EMOJI_ONLY.test(item.body.trim())) {
      bubble.classList.add('jumbo');
      bubble.textContent = item.body.trim();
    } else {
      bubble.append(linkify(item.body));
    }
    li.append(bubble);
  }

  const time = el('span', 'msg-time', timeFormat.format(item.createdAt));
  time.setAttribute('aria-hidden', 'true');
  li.append(time);
  li.title = fullFormat.format(item.createdAt);
  li.setAttribute('aria-label', `${nameOf(item.userId)}, ${fullFormat.format(item.createdAt)}`);
  return li;
}

function typingNode() {
  const li = el('li', 'msg msg-in run-end typing');
  li.append(el('span', 'msg-author'));
  const bubble = el('div', 'bubble');
  bubble.setAttribute('aria-hidden', 'true');
  bubble.append(el('span', 'dot'), el('span', 'dot'), el('span', 'dot'));
  li.append(bubble);
  return li;
}

/** Every message to show, in order: stored ones by id, then this device's unsent ones. */
function sequence() {
  const stored = [...messages.values()].sort((a, b) => a.id - b.id);
  const unsent = [...pending.values()].map((p) => ({ ...p, userId: me.id, key: `p${p.clientId}` }));
  return [...stored.map((m) => ({ ...m, key: `m${m.id}` })), ...unsent];
}

/**
 * Brings the list in line with state, reusing every node it can, so a
 * bubble that's already on screen never re-animates, reloads its photo, or
 * loses its place.
 */
function render({ animate = new Set() } = {}) {
  const items = sequence();
  const wanted = [];
  let previous = null;
  items.forEach((item, index) => {
    const next = items[index + 1];
    const newDay = !previous || startOfDay(previous.createdAt) !== startOfDay(item.createdAt);
    const separated = newDay || item.createdAt - previous.createdAt > SEPARATOR_GAP_MS;
    if (separated) {
      const key = `s${item.key}`;
      if (!nodes.has(key)) nodes.set(key, separatorLabel(item.createdAt));
      wanted.push(nodes.get(key));
    }
    let node = nodes.get(item.key);
    if (!node) {
      node = messageNode(item);
      nodes.set(item.key, node);
      if (animate.has(item.key) && !reducedMotion.matches) {
        node.classList.add('enter');
        node.addEventListener('animationend', () => node.classList.remove('enter'), {
          once: true,
        });
      }
    }
    const runStart =
      separated ||
      previous.userId !== item.userId ||
      item.createdAt - previous.createdAt > RUN_GAP_MS;
    const nextSeparated =
      !next ||
      startOfDay(next.createdAt) !== startOfDay(item.createdAt) ||
      next.createdAt - item.createdAt > SEPARATOR_GAP_MS;
    const runEnd =
      nextSeparated || next.userId !== item.userId || next.createdAt - item.createdAt > RUN_GAP_MS;
    node.classList.toggle('run-start', runStart);
    node.classList.toggle('run-end', runEnd);
    node.classList.toggle('pending', item.key.startsWith('p') && item.state !== 'failed');
    node.classList.toggle('failed', item.state === 'failed');
    node.dataset.key = item.key;
    const author = node.querySelector('.msg-author');
    if (author) author.hidden = !(runStart && item.userId !== me.id);
    setFootnote(node, item, !next);
    wanted.push(node);
    previous = item;
  });

  const typingIds = [...typers.keys()].filter((id) => id !== me.id);
  if (typingIds.length > 0) {
    let node = nodes.get('typing');
    if (!node) {
      node = typingNode();
      nodes.set('typing', node);
    }
    const label = node.querySelector('.msg-author');
    label.textContent = typingIds.map(nameOf).join(', ');
    label.hidden = false;
    wanted.push(node);
  }

  const wantedSet = new Set(wanted);
  for (const child of [...list.children]) {
    if (!wantedSet.has(child)) child.remove();
  }
  wanted.forEach((node, index) => {
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
  });
  for (const [key, node] of nodes) {
    if (!wantedSet.has(node) && !node.isConnected) nodes.delete(key);
  }

  // One focusable message at a time (the newest), arrows move between them.
  const all = list.querySelectorAll('.msg:not(.typing)');
  const focused = document.activeElement;
  all.forEach((node) => (node.tabIndex = -1));
  if (focused instanceof HTMLElement && focused.matches('.msg')) focused.tabIndex = 0;
  else if (all.length > 0) all[all.length - 1].tabIndex = 0;
}

/** "Delivered" under your newest message while it's the last word; the failure note when it didn't go. */
function setFootnote(node, item, isLast) {
  node.querySelector('.receipt')?.remove();
  node.querySelector('.failed-note')?.remove();
  if (item.state === 'failed') {
    const note = el('button', 'failed-note', item.error ?? T.notDelivered);
    note.type = 'button';
    note.dataset.retry = item.clientId;
    node.append(note);
  } else if (isLast && item.userId === me.id && item.key.startsWith('m')) {
    node.append(el('div', 'receipt', T.delivered));
  }
}

// ---- scrolling --------------------------------------------------------

function nearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
}

function scrollToBottom(smooth) {
  scroller.scrollTo({
    top: scroller.scrollHeight,
    behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto',
  });
}

function updateJump() {
  jump.hidden = unseen === 0;
  jump.textContent = `↓ ${T.newMessages(unseen)}`;
}

scroller.addEventListener(
  'scroll',
  () => {
    stick = nearBottom();
    if (stick && unseen > 0) {
      unseen = 0;
      updateJump();
    }
    if (stick) markRead();
  },
  { passive: true },
);

jump.addEventListener('click', () => {
  unseen = 0;
  updateJump();
  scrollToBottom(true);
});

/** Renders, then keeps whoever was reading at the bottom there — and only them. */
function renderAndFollow(options = {}) {
  const wasAtBottom = stick || options.force;
  render(options);
  if (wasAtBottom) {
    scrollToBottom(options.smooth ?? true);
  } else if (options.incoming) {
    unseen += options.incoming;
    updateJump();
  }
}

// ---- the viewport: keyboard, toolbars, notch ---------------------------

function fitViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const wasAtBottom = stick;
  root.style.setProperty('--vvh', `${viewport.height}px`);
  root.style.setProperty('--vvt', `${viewport.offsetTop}px`);
  root.classList.toggle('keyboard-open', window.innerHeight - viewport.height > 120);
  if (wasAtBottom) scrollToBottom(false);
}

window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
fitViewport();

new ResizeObserver(() => {
  root.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
  root.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
}).observe(app);
root.style.setProperty('--bar-h', `${bar.offsetHeight}px`);

// ---- connection status ------------------------------------------------

// As iMessage: under the name, nothing while all is well — the line only
// appears to say the conversation isn't live.
function showSubtitle() {
  subtitle.hidden = connected;
  if (connected) {
    subtitle.textContent = '';
    subtitle.classList.remove('is-offline');
  } else {
    subtitle.textContent = navigator.onLine ? T.connecting : T.offline;
    subtitle.classList.toggle('is-offline', !navigator.onLine);
  }
}

function setConnected(value) {
  clearTimeout(offlineTimer);
  if (value) {
    connected = true;
    showSubtitle();
    return;
  }
  // A blip shorter than a second and a half isn't worth announcing.
  offlineTimer = setTimeout(() => {
    connected = false;
    showSubtitle();
  }, 1500);
}

// ---- server ------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.json ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.json ? JSON.stringify(options.json) : options.body,
  });
  if (response.status === 401) {
    // Signed out elsewhere (a reset, a revoke): the page shows the sign-in screen.
    location.reload();
    throw new Error('signed out');
  }
  return response;
}

function setMembers(list) {
  for (const member of list) members.set(member.id, member);
  showSubtitle();
}

function accept(message, { fromStream = false } = {}) {
  if (message.deleted) {
    removeMessage(message.id);
    return false;
  }
  if (messages.has(message.id)) return false;
  // Our own message coming back (from the response or the stream, whichever
  // is first): the unsent bubble becomes the stored one, same node.
  const unsent = message.userId === me.id ? pending.get(message.clientId) : undefined;
  if (unsent) {
    const node = nodes.get(`p${unsent.clientId}`);
    pending.delete(unsent.clientId);
    saveOutbox();
    if (node) {
      nodes.delete(`p${unsent.clientId}`);
      nodes.set(`m${message.id}`, node);
    }
    messages.set(message.id, message);
    return false;
  }
  messages.set(message.id, message);
  return fromStream;
}

function removeMessage(id) {
  messages.delete(id);
  const node = nodes.get(`m${id}`);
  if (node) {
    nodes.delete(`m${id}`);
    node.remove();
  }
}

async function loadLatest() {
  const response = await api(`${BASE}/api/history`);
  if (!response.ok) throw new Error(String(response.status));
  const page = await response.json();
  setMembers(page.members);
  for (const node of list.querySelectorAll('[data-static]')) node.remove();
  messages.clear();
  for (const message of page.messages) messages.set(message.id, message);
  rev = page.rev;
  epoch = page.epoch;
  hasMore = page.hasMore;
  render();
  scrollToBottom(false);
  stick = true;
}

async function loadOlder() {
  if (!hasMore || loadingOlder || messages.size === 0) return;
  loadingOlder = true;
  const spinner = el('div', 'history-spinner');
  sentinel.after(spinner);
  try {
    const oldest = Math.min(...messages.keys());
    const response = await api(`${BASE}/api/history?before=${oldest}`);
    if (!response.ok) return;
    const page = await response.json();
    hasMore = page.hasMore;
    const before = scroller.scrollHeight - scroller.scrollTop;
    spinner.remove();
    for (const message of page.messages) messages.set(message.id, message);
    render();
    // Whatever was on screen stays exactly where it was.
    scroller.scrollTop = scroller.scrollHeight - before;
  } catch {
    // Tried again on the next scroll up.
  } finally {
    spinner.remove();
    loadingOlder = false;
  }
}

new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadOlder();
  },
  { root: scroller, rootMargin: '600px 0px 0px 0px' },
).observe(sentinel);

function connect() {
  source?.close();
  source = new EventSource(
    `${BASE}/api/events?after=${rev}${epoch === null ? '' : `&epoch=${epoch}`}`,
  );
  const advance = (event) => {
    const id = Number(event.lastEventId);
    if (Number.isFinite(id) && id > rev) rev = id;
  };
  source.addEventListener('open', () => setConnected(true));
  source.addEventListener('hello', (event) => {
    const hello = JSON.parse(event.data);
    setConnected(true);
    setMembers(hello.members);
    streamId = hello.stream;
    sendPresence();
    flushOutbox();
  });
  source.addEventListener('message', (event) => {
    advance(event);
    const message = JSON.parse(event.data);
    typers.delete(message.userId);
    const incoming = accept(message, { fromStream: true }) && message.userId !== me.id;
    renderAndFollow({
      animate: new Set([`m${message.id}`]),
      incoming: incoming ? 1 : 0,
    });
    if (incoming && document.hidden) {
      hiddenUnread += 1;
      updateTitle();
    }
    markRead();
  });
  source.addEventListener('delete', (event) => {
    advance(event);
    removeMessage(JSON.parse(event.data).id);
    render();
  });
  source.addEventListener('typing', (event) => {
    const { userId } = JSON.parse(event.data);
    clearTimeout(typers.get(userId));
    typers.set(
      userId,
      setTimeout(() => {
        typers.delete(userId);
        render();
      }, 4500),
    );
    renderAndFollow({ smooth: true });
  });
  source.addEventListener('members', (event) => setMembers(JSON.parse(event.data).members));
  source.addEventListener('reset', () => {
    loadLatest().catch(() => {});
  });
  source.addEventListener('signed-out', () => location.reload());
  source.addEventListener('error', () => {
    setConnected(false);
    // The browser retries by itself unless the server refused outright;
    // then find out why (a 401 reloads to the sign-in screen).
    if (source.readyState === EventSource.CLOSED) {
      setTimeout(() => {
        api(`${BASE}/api/history?before=1`)
          .then(() => connect())
          .catch(() => setTimeout(connect, 4000));
      }, 2000);
    }
  });
}

function markRead() {
  if (document.hidden || !stick) return;
  if (hiddenUnread > 0) {
    hiddenUnread = 0;
    updateTitle();
  }
  // At most every few seconds: a burst of messages is one "read".
  if (rev <= lastReadRev || readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = 0;
    lastReadRev = rev;
    api(`${BASE}/api/read`, { method: 'POST', json: { rev } }).catch(() => {});
    // Read here is read everywhere: the badge a notification set goes too.
    navigator.clearAppBadge?.().catch(() => {});
  }, 1500);
}

/**
 * Tells the server whether this tab is on screen, so someone reading the
 * conversation isn't also sent a notification for each message in it.
 * Renewed while visible; the server lets it lapse (hub.ts, PRESENCE_MS).
 */
function sendPresence() {
  clearTimeout(presenceTimer);
  if (!streamId) return;
  const visible = !document.hidden;
  api(`${BASE}/api/presence`, {
    method: 'POST',
    json: { stream: streamId, visible },
    keepalive: true,
  }).catch(() => {});
  if (visible) presenceTimer = setTimeout(sendPresence, 25_000);
}

function updateTitle() {
  document.title = hiddenUnread > 0 ? `(${hiddenUnread}) Family` : 'Family';
  if ('setAppBadge' in navigator) {
    (hiddenUnread > 0 ? navigator.setAppBadge(hiddenUnread) : navigator.clearAppBadge()).catch(
      () => {},
    );
  }
}

document.addEventListener('visibilitychange', () => {
  sendPresence();
  if (document.hidden) return;
  markRead();
  // A phone that slept may have dropped the stream without telling it.
  if (!source || source.readyState === EventSource.CLOSED) connect();
});
window.addEventListener('online', () => {
  showSubtitle();
  if (!source || source.readyState !== EventSource.OPEN) connect();
  flushOutbox();
});
window.addEventListener('offline', showSubtitle);
// Restored from the back-forward cache: the page is as it was, its stream isn't.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  connect();
  flushOutbox();
});

// ---- sending ------------------------------------------------------------

function saveOutbox() {
  try {
    const text = [...pending.values()]
      .filter((p) => !p.file)
      .map(({ clientId, body, replyTo, createdAt }) => ({ clientId, body, replyTo, createdAt }));
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(text));
  } catch {
    // Private browsing: the outbox lives only as long as the page.
  }
}

function restoreOutbox() {
  try {
    for (const p of JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')) {
      if (typeof p.clientId === 'string' && typeof p.body === 'string') {
        pending.set(p.clientId, { ...p, state: 'sending', attempts: 0 });
      }
    }
  } catch {
    // Nothing to restore.
  }
}

async function deliver(p) {
  if (p.inFlight) return;
  p.inFlight = true;
  p.state = 'sending';
  render();
  try {
    if (p.file && !p.imageId) {
      const response = await api(`${BASE}/api/images?w=${p.width}&h=${p.height}`, {
        method: 'POST',
        body: p.file,
        headers: { 'content-type': p.file.type || 'application/octet-stream' },
      });
      if (!response.ok)
        throw Object.assign(new Error('upload'), { status: response.status, response });
      p.imageId = (await response.json()).imageId;
    }
    const response = await api(`${BASE}/api/messages`, {
      method: 'POST',
      json: { clientId: p.clientId, body: p.body, imageId: p.imageId ?? null, replyTo: p.replyTo },
    });
    if (!response.ok) throw Object.assign(new Error('send'), { status: response.status, response });
    const { message } = await response.json();
    accept(message);
    render();
  } catch (error) {
    p.attempts = (p.attempts ?? 0) + 1;
    const status = error.status ?? 0;
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (permanent) {
      p.state = 'failed';
      try {
        p.error = (await error.response.json()).error;
      } catch {
        p.error = undefined;
      }
    } else if (p.attempts < 5) {
      // Network trouble: try again, backing off, until it goes through.
      setTimeout(() => deliver(p), Math.min(30_000, 1000 * 2 ** p.attempts));
    } else {
      p.state = 'failed';
    }
    render();
  } finally {
    p.inFlight = false;
  }
}

function flushOutbox() {
  for (const p of pending.values()) {
    if (!p.inFlight && p.state !== 'failed') deliver(p);
  }
}

function queue(p) {
  const entry = { clientId: clientId(), createdAt: Date.now(), replyTo, state: 'sending', ...p };
  pending.set(entry.clientId, entry);
  saveOutbox();
  setReply(null);
  stick = true;
  renderAndFollow({ animate: new Set([`p${entry.clientId}`]), force: true });
  if (entry.state !== 'failed') deliver(entry);
}

function sendText() {
  const body = input.value.replace(/\s+$/, '');
  if (body.trim() === '') return;
  input.value = '';
  autosize();
  queue({ body });
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendText();
});

// Keep the keyboard up: pressing Send mustn't take focus from the field.
sendButton.addEventListener('mousedown', (event) => event.preventDefault());

input.enterKeyHint = finePointer ? 'send' : 'enter';
input.addEventListener('keydown', (event) => {
  // isComposing / 229: Enter is confirming a pinyin candidate, not sending.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && !event.shiftKey && finePointer) {
    event.preventDefault();
    sendText();
  } else if (event.key === 'Escape' && replyTo !== null) {
    setReply(null);
  }
});

let minHeight = 0;
function autosize() {
  if (minHeight === 0) minHeight = parseFloat(getComputedStyle(input).height) || 34;
  const previous = input.style.height;
  input.style.transition = 'none';
  input.style.height = '0px';
  const target = Math.max(minHeight, Math.min(input.scrollHeight, 140));
  input.style.height = previous || `${minHeight}px`;
  void input.offsetHeight;
  input.style.transition = '';
  input.style.height = `${target}px`;
  sendButton.disabled = input.value.trim() === '';
}

input.addEventListener('input', () => {
  const wasAtBottom = stick;
  autosize();
  if (wasAtBottom) scrollToBottom(false);
  const now = Date.now();
  if (input.value.trim() !== '' && now - lastTypingSent > 2500) {
    lastTypingSent = now;
    api(`${BASE}/api/typing`, { method: 'POST' }).catch(() => {});
  }
});

/** A photo, made safe to send: re-encoded (which drops its location metadata) and at most 2048px. */
async function preparePhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  if (file.type === 'image/gif' && file.size < 15 * 1024 * 1024) {
    bitmap.close();
    return { file, width, height }; // Keeps its animation.
  }
  const scale = Math.min(1, 2048 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  return blob ? { file: blob, width: canvas.width, height: canvas.height } : null;
}

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  for (const original of files) {
    const photo = await preparePhoto(original);
    if (!photo) {
      queue({ body: '', state: 'failed', error: T.badPhoto });
      continue;
    }
    if (photo.file.size > 15 * 1024 * 1024) {
      queue({ body: '', state: 'failed', error: T.tooBig });
      continue;
    }
    queue({ body: '', ...photo, previewUrl: URL.createObjectURL(photo.file) });
  }
});

list.addEventListener('click', (event) => {
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    const p = pending.get(retry.dataset.retry);
    if (p && (p.body || p.file)) {
      p.attempts = 0;
      p.error = undefined;
      deliver(p);
    } else if (p) {
      pending.delete(p.clientId);
      render();
    }
    return;
  }
  const quote = event.target.closest('.quote');
  if (quote) {
    const target = nodes.get(`m${quote.dataset.replyTo}`);
    if (target) {
      target.scrollIntoView({
        block: 'center',
        behavior: reducedMotion.matches ? 'auto' : 'smooth',
      });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    }
    return;
  }
  const image = event.target.closest('.bubble-image');
  if (image && !suppressClick) openViewer(image.src);
});

// ---- replying --------------------------------------------------------------

function setReply(id) {
  replyTo = id;
  replyBar.hidden = id === null;
  if (id !== null) {
    const message = messages.get(id);
    replyText.textContent = `${T.replyingTo(nameOf(message?.userId))}: ${excerpt(message)}`;
    input.focus();
  }
}

$('[data-reply-cancel]').addEventListener('click', () => setReply(null));

// ---- the long-press menu --------------------------------------------------

let menuFor = null;
let menuOpenedAt = 0;
let suppressClick = false;

function itemFor(node) {
  const key = node.dataset.key ?? '';
  if (key.startsWith('m')) return messages.get(Number(key.slice(1)));
  return pending.get(key.slice(1));
}

function openMenu(node) {
  const item = itemFor(node);
  if (!item || node.classList.contains('typing')) return;
  closeMenu(true);
  menuFor = node;
  menuOpenedAt = Date.now();
  const stored = node.dataset.key.startsWith('m');
  const bubbles = [...node.querySelectorAll('.bubble')];
  if (bubbles.length === 0) return;
  const rect = bubbles[0].getBoundingClientRect();
  const lastRect = bubbles[bubbles.length - 1].getBoundingClientRect();

  layer.replaceChildren();
  layer.hidden = false;
  layer.classList.remove('closing');

  // The pressed message, lifted above the blur.
  const lifted = el(
    'div',
    `msg ${node.classList.contains('msg-out') ? 'msg-out' : 'msg-in'} menu-bubble`,
  );
  for (const bubble of bubbles) lifted.append(bubble.cloneNode(true));
  lifted.style.left = `${Math.min(rect.left, lastRect.left)}px`;
  lifted.style.top = `${rect.top}px`;
  lifted.style.width = `${Math.max(rect.right, lastRect.right) - Math.min(rect.left, lastRect.left)}px`;
  lifted.style.transformOrigin = node.classList.contains('msg-out') ? '100% 50%' : '0 50%';
  layer.append(lifted);
  node.style.visibility = 'hidden';

  const menu = el('ul', 'menu');
  menu.setAttribute('role', 'menu');
  const header = el('li', 'menu-time', fullFormat.format(item.createdAt));
  header.setAttribute('role', 'presentation');
  menu.append(header);
  const add = (label, icon, action, danger = false) => {
    const li = el('li');
    li.setAttribute('role', 'none');
    const button = el('button', danger ? 'danger' : '');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.append(el('span', '', label));
    button.insertAdjacentHTML('beforeend', icon);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      action(button);
    });
    li.append(button);
    menu.append(li);
  };
  const svg = (path) =>
    `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  if (stored) {
    add(T.reply, svg('M10 8 4 13l6 5M4 13h10a6 6 0 0 1 6 6v1'), () => {
      closeMenu();
      setReply(item.id);
    });
  }
  if (item.body) {
    add(T.copy, svg('M9 9h10v11H9zM5 15V4h10'), () => {
      navigator.clipboard?.writeText(item.body).catch(() => {});
      closeMenu();
    });
  }
  if (!stored || item.userId === me.id || me.isAdmin) {
    add(
      T.del,
      svg('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
      (button) => {
        if (!stored) {
          pending.delete(item.clientId);
          saveOutbox();
          closeMenu();
          render();
          return;
        }
        // A second tap confirms: the label says what will happen.
        if (!button.dataset.armed) {
          button.dataset.armed = 'true';
          button.firstChild.textContent = T.confirmDelete;
          button.style.fontWeight = '600';
          return;
        }
        closeMenu();
        api(`${BASE}/api/messages/${item.id}`, { method: 'DELETE' })
          .then((response) => {
            if (response.ok) {
              removeMessage(item.id);
              render();
            }
          })
          .catch(() => {});
      },
      true,
    );
  }
  layer.append(menu);

  const width = Math.max(220, menu.offsetWidth);
  const height = menu.offsetHeight;
  const viewportHeight = window.visualViewport?.height ?? innerHeight;
  const below = lastRect.bottom + 10;
  let top = below + height < viewportHeight - 12 ? below : rect.top - height - 10;
  top = Math.max(12, Math.min(top, viewportHeight - height - 12));
  const outgoing = node.classList.contains('msg-out');
  let left = outgoing
    ? Math.max(lastRect.right, rect.right) - width
    : Math.min(rect.left, lastRect.left);
  left = Math.max(12, Math.min(left, innerWidth - width - 12));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.transformOrigin = `${outgoing ? 'right' : 'left'} ${top > rect.top ? 'top' : 'bottom'}`;
  menu.querySelector('button')?.focus({ preventScroll: true });
}

function closeMenu(immediately = false) {
  if (layer.hidden) return;
  const node = menuFor;
  menuFor = null;
  const finish = () => {
    layer.hidden = true;
    layer.replaceChildren();
    if (node) node.style.visibility = '';
  };
  if (immediately || reducedMotion.matches) {
    finish();
  } else {
    layer.classList.add('closing');
    setTimeout(finish, 150);
  }
  node?.focus({ preventScroll: true });
}

layer.addEventListener('click', (event) => {
  // The finger lifting off a long press arrives as a click on the backdrop.
  if (Date.now() - menuOpenedAt < 500) return;
  if (!event.target.closest('.menu')) closeMenu();
});

layer.addEventListener('keydown', (event) => {
  const buttons = [...layer.querySelectorAll('.menu button')];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }
});

list.addEventListener('contextmenu', (event) => {
  const node = event.target.closest('.msg');
  if (!node || !event.target.closest('.bubble')) return;
  // A link keeps the browser's own menu (open in new tab, copy link).
  if (event.target.closest('a')) return;
  event.preventDefault();
  openMenu(node);
});

// Long press, for touch. Swipe left reveals the times.
let press = null;
list.addEventListener(
  'touchstart',
  (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const node = event.target.closest('.msg');
    press = { x: touch.clientX, y: touch.clientY, node, timer: 0, swiping: false, moved: false };
    if (node && event.target.closest('.bubble')) {
      press.timer = setTimeout(() => {
        if (!press || press.moved) return;
        suppressClick = true;
        navigator.vibrate?.(8);
        window.getSelection()?.removeAllRanges();
        openMenu(node);
      }, 420);
    }
  },
  { passive: true },
);

scroller.addEventListener(
  'touchmove',
  (event) => {
    if (!press) return;
    const touch = event.touches[0];
    const dx = touch.clientX - press.x;
    const dy = touch.clientY - press.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      press.moved = true;
      clearTimeout(press.timer);
    }
    if (!press.swiping && dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.4) press.swiping = true;
    if (press.swiping) {
      event.preventDefault();
      const pull = Math.max(0, -dx);
      const reveal = pull < 74 ? pull : 74 + (pull - 74) * 0.2;
      list.classList.add('revealing');
      list.style.setProperty('--reveal', `${reveal}px`);
    }
  },
  { passive: false },
);

const endPress = () => {
  if (!press) return;
  clearTimeout(press.timer);
  if (press.swiping) {
    list.classList.remove('revealing');
    list.style.setProperty('--reveal', '0px');
  }
  press = null;
  setTimeout(() => (suppressClick = false), 50);
};
scroller.addEventListener('touchend', endPress);
scroller.addEventListener('touchcancel', endPress);

// Keyboard: arrows move between messages; Enter or the menu key opens its menu.
list.addEventListener('keydown', (event) => {
  const node = event.target.closest?.('.msg');
  if (!node) return;
  const all = [...list.querySelectorAll('.msg:not(.typing)')];
  const index = all.indexOf(node);
  let target = null;
  if (event.key === 'ArrowUp') target = all[index - 1];
  else if (event.key === 'ArrowDown') target = all[index + 1];
  else if (event.key === 'Home') target = all[0];
  else if (event.key === 'End') target = all[all.length - 1];
  else if (
    event.key === 'Enter' ||
    event.key === 'ContextMenu' ||
    (event.key === 'F10' && event.shiftKey)
  ) {
    if (event.target.closest('a')) return;
    event.preventDefault();
    openMenu(node);
    return;
  }
  if (target) {
    event.preventDefault();
    node.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  }
});

// ---- photos, full screen ---------------------------------------------------

function openViewer(src) {
  const viewer = el('div', 'viewer');
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.tabIndex = -1;
  const img = el('img');
  img.src = src;
  img.alt = T.photo;
  viewer.append(img);
  const close = () => {
    viewer.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  viewer.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(viewer);
  viewer.focus();
}

// ---- details -------------------------------------------------------------

function openDetails() {
  document.querySelector('.bar-menu')?.removeAttribute('open');
  openSheet({
    title: T.details,
    closeLabel: T.done,
    build: (body) => {
      const { rows } = group(body, T.members);
      for (const [id, member] of members) {
        if (!member.active) continue;
        row(rows, id === me.id ? `${member.name} (${T.you})` : member.name);
      }
      notificationSettings(body, { api, lang: me.lang });
    },
  });
}

const barTitle = $('.bar-title');
barTitle.setAttribute('role', 'button');
barTitle.tabIndex = 0;
barTitle.setAttribute('aria-label', T.openDetails);
barTitle.addEventListener('click', openDetails);
barTitle.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openDetails();
  }
});
const detailsItem = $('[data-open-details]');
if (detailsItem) {
  detailsItem.hidden = false;
  detailsItem.addEventListener('click', openDetails);
}

/** Brings one message into view and marks it briefly, if it's loaded. */
function reveal(id) {
  const target = nodes.get(`m${id}`);
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
  return true;
}

// A notification tapped while the chat is already open (sw.js).
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'open-message' && event.data.id > 0) reveal(event.data.id);
});

// ---- start ---------------------------------------------------------------

attach.hidden = false;
composer.querySelector('input[name="clientId"]')?.remove();
input.removeAttribute('required');
autosize();
restoreOutbox();

async function start(attempt = 0) {
  try {
    await loadLatest();
    connect();
    // Opened from a notification: <base>/#m<id>.
    const linked = /^#m(\d+)$/.exec(location.hash);
    if (linked && reveal(Number(linked[1]))) history.replaceState(null, '', `${BASE}/`);
    if (attempt === 0) registerWorker().then(() => syncSubscription(api).catch(() => {}));
  } catch {
    setConnected(false);
    setTimeout(() => start(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
  }
}

start();
