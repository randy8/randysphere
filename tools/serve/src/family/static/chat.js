// The family chat's page script: plain browser JavaScript, no framework, no
// build step. The server rendered the latest messages and a working form;
// this replaces them with the live conversation.

import { notificationSettings, registerWorker, syncSubscription } from './notifications.js';
import { CATEGORIES, isEmoji, QUICK, recent, remember } from './emoji.js';
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
      read: '已读',
      readOf: (names, n, total) => `${names.join('、')} 已读 · ${n}/${total}`,
      more: (k) => `+${k}`,
      readByAll: '全部已读',
      info: '信息',
      readHeading: '已读',
      notYet: '已送达，未读',
      readEarlier: '已读',
      nobodyYet: '还没有人读过。',
      everyone: '所有人都已读。',
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
      edit: '编辑',
      undoSend: '撤回',
      edited: '已编辑',
      hideEdits: '隐藏编辑记录',
      save: '保存',
      cancel: '取消',
      mention: '提到',
      youUnsent: '你撤回了一条信息。',
      unsent: (name) => `${name}撤回了一条信息。`,
      unsentQuote: '已撤回的信息',
      couldntEdit: '无法编辑这条信息。',
      couldntUnsend: '无法撤回这条信息。',
      reactions: '回应',
      addReaction: '添加回应',
      anyEmoji: '输入任意表情',
      recentEmoji: '最近使用',
      sticker: '贴纸',
      kinds: {
        track: '歌曲',
        album: '专辑',
        playlist: '歌单',
        artist: '艺人',
        episode: '单集',
        show: '播客',
      },
      categories: {
        smileys: '表情',
        people: '人物',
        hearts: '爱心与庆祝',
        animals: '动物与自然',
        food: '食物',
        activities: '活动与物品',
        symbols: '符号',
      },
    }
  : {
      today: 'Today',
      yesterday: 'Yesterday',
      delivered: 'Delivered',
      read: 'Read',
      readOf: (names, n, total) =>
        `Read by ${names.length === 2 ? names.join(' and ') : names.join(', ')} · ${n} of ${total}`,
      more: (k) => `+${k}`,
      readByAll: 'Read by All',
      info: 'Info',
      readHeading: 'Read By',
      notYet: 'Delivered To',
      readEarlier: 'Read',
      nobodyYet: 'No one has read it yet.',
      everyone: 'Everyone has read it.',
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
      edit: 'Edit',
      undoSend: 'Undo Send',
      edited: 'Edited',
      hideEdits: 'Hide Edits',
      save: 'Save',
      cancel: 'Cancel',
      mention: 'Mention',
      youUnsent: 'You unsent a message.',
      unsent: (name) => `${name} unsent a message.`,
      unsentQuote: 'Unsent message',
      couldntEdit: 'Couldn’t edit this message.',
      couldntUnsend: 'Couldn’t unsend this message.',
      reactions: 'Reactions',
      addReaction: 'Add Reaction',
      anyEmoji: 'Type any emoji',
      recentEmoji: 'Recently Used',
      sticker: 'Sticker',
      kinds: {
        track: 'Song',
        album: 'Album',
        playlist: 'Playlist',
        artist: 'Artist',
        episode: 'Episode',
        show: 'Podcast',
      },
      categories: {
        smileys: 'Smileys',
        people: 'People',
        hearts: 'Hearts & Celebration',
        animals: 'Animals & Nature',
        food: 'Food & Drink',
        activities: 'Activities & Objects',
        symbols: 'Symbols & Flags',
      },
    };

/** Where a Genmoji or sticker sits in a message's text (store.ts GLYPH). */
const GLYPH = '\uFFFC';

// iMessage's limits, as the server keeps them (store.ts).
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_EDITS = 5;
const UNSEND_WINDOW_MS = 2 * 60 * 1000;

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
/** The server's clock less this device's: Edit and Undo Send are timed by the server. */
let skew = 0;
const serverNow = () => Date.now() + skew;
/** Messages whose earlier versions are showing (tapped "Edited"). */
const showingEdits = new Set();
/** The message being edited in place, if any: { id, node, pending }. */
let editing = null;

// ---- small helpers ----------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A light tap of the phone's haptics. Android has vibrate(); Safari on
 * iPhone (iOS 18+) doesn't, but clicking a switch's label gives its own
 * native tick, so a hidden one stands in.
 */
let hapticSwitch = null;
function haptic() {
  if (navigator.vibrate) {
    navigator.vibrate(8);
    return;
  }
  if (finePointer) return;
  if (!hapticSwitch) {
    hapticSwitch = el('label', 'visually-hidden');
    hapticSwitch.setAttribute('aria-hidden', 'true');
    const box = el('input');
    box.type = 'checkbox';
    box.setAttribute('switch', '');
    box.tabIndex = -1;
    hapticSwitch.append(box);
    document.body.append(hapticSwitch);
  }
  hapticSwitch.click();
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
const readFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

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

/**
 * Text with its links made clickable — built as nodes, never as HTML. A
 * stored message's `links` (store.ts) give each its href and words without
 * tracking parameters; the text itself is never changed.
 */
function linkify(text, links = [], mentions = []) {
  const known = new Map(links.map((link) => [link.raw, link]));
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
    fragment.append(mentionify(text.slice(last, match.index), mentions));
    const link = known.get(raw);
    const a = el('a', '', link?.text ?? raw);
    a.href = link?.url ?? href.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    fragment.append(a);
    last = match.index + raw.length;
  }
  fragment.append(mentionify(text.slice(last), mentions));
  return fragment;
}

/** What may follow a name in a mention (store.ts endsName): not a letter or digit, unless Chinese. */
const endsName = (next) =>
  next === undefined || !/[\p{L}\p{N}_]/u.test(next) || /\p{Script=Han}/u.test(next);

/**
 * Text with the "@Name"s the server found in it (store.ts findMentions)
 * set in bold — yours in colour, as iMessage marks them.
 */
function mentionify(text, mentions) {
  const fragment = document.createDocumentFragment();
  if (mentions.length === 0) {
    fragment.append(text);
    return fragment;
  }
  const longest = [...mentions].sort((a, b) => b.text.length - a.text.length);
  let last = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const mention = longest.find(
      (m) => text.startsWith(m.text, at) && endsName(text[at + m.text.length]),
    );
    if (!mention) continue;
    fragment.append(text.slice(last, at));
    fragment.append(el('span', mention.userId === me.id ? 'mention me' : 'mention', mention.text));
    last = at + mention.text.length;
    at = last - 1;
  }
  fragment.append(text.slice(last));
  return fragment;
}

const EMOJI_ONLY =
  /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|\p{Emoji_Modifier}|‍(?:\p{Extended_Pictographic}))*\s*){1,3}$/u;

// ---- rendering --------------------------------------------------------

function excerpt(message) {
  if (!message) return T.original;
  if (message.unsent) return T.unsentQuote;
  const text = message.body.replaceAll(GLYPH, ' ').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 120);
  if (message.glyphs?.length) return T.sticker;
  return message.image ? T.photo : T.original;
}

/** A reply's quote of what it answers: the original's words, or what became of them. */
function fillQuote(quote, id) {
  const original = messages.get(id);
  // The text in its own box, clipped to two lines; the quote itself isn't
  // clipped, so its thread line can reach down to the reply.
  const text = el('span', 'quote-text');
  if (original && !original.unsent) {
    text.append(el('b', '', nameOf(original.userId)), ` ${excerpt(original)}`);
  } else text.textContent = excerpt(original);
  quote.replaceChildren(text);
}

/** A Genmoji or sticker, from the server or (unsent) from this device. */
function glyphImage(glyph, large) {
  const img = el('img', 'glyph');
  img.src = glyph.previewUrl ?? `${BASE}/images/${glyph.id}`;
  img.alt = T.sticker;
  img.decoding = 'async';
  if (!large) img.setAttribute('aria-hidden', 'true');
  return img;
}

/** The Spotify mark (pages.ts SPOTIFY_LOGO): drawn here, nothing loaded from Spotify. */
const SPOTIFY_LOGO =
  '<svg class="link-logo" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1ed760"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M6.2 9.2c3.8-1.2 8.3-.8 11.6 1.2" stroke-width="2"/><path d="M6.9 12.6c3.1-.9 6.7-.6 9.4 1" stroke-width="1.7"/><path d="M7.5 15.8c2.5-.7 5.2-.5 7.3.8" stroke-width="1.4"/></g></svg>';
const PROVIDER_NAMES = { spotify: 'Spotify' };

/** A message's link previews, each once, in order. */
function cardsOf(item) {
  const seen = new Set();
  return (item.links ?? [])
    .map((link) => link.preview)
    .filter((preview) => preview && !seen.has(preview.url) && seen.add(preview.url));
}

/** Nothing but links with cards: the cards stand in for the text, as in iMessage. */
function onlyCards(item) {
  if (item.glyphs?.length) return false;
  let rest = item.body;
  for (const link of item.links ?? []) if (link.preview) rest = rest.replace(link.raw, '');
  return cardsOf(item).length > 0 && rest.trim() === '';
}

/**
 * A link's card (pages.ts cardHtml draws the same without JavaScript):
 * artwork, title, who it's by, where it's from — the whole card one link.
 * Every word is set as text; the artwork is this server's copy.
 */
function linkCard(preview) {
  const card = el('a', 'bubble link-card');
  card.href = preview.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.dataset.provider = preview.provider;
  const logo = preview.provider === 'spotify' ? SPOTIFY_LOGO : '';
  if (preview.image) {
    const art = el('img', 'link-art');
    art.src = `${BASE}/previews/${preview.image.id}`;
    art.alt = '';
    art.width = preview.image.width;
    art.height = preview.image.height;
    art.decoding = 'async';
    art.loading = 'lazy';
    card.append(art);
  } else {
    const art = el('span', 'link-art link-art-empty');
    art.innerHTML = logo;
    card.append(art);
  }
  const text = el('span', 'link-text');
  text.append(el('span', 'link-title', preview.title));
  if (preview.subtitle) text.append(el('span', 'link-subtitle', preview.subtitle));
  const source = el('span', 'link-source');
  source.innerHTML = logo;
  source.append(
    [PROVIDER_NAMES[preview.provider] ?? preview.provider, T.kinds[preview.kind]]
      .filter(Boolean)
      .join(' · '),
  );
  text.append(source);
  card.append(text);
  return card;
}

/**
 * A message's text, with its Genmoji and stickers in their places. Only
 * stickers (no words): large, without a bubble, as iMessage shows them.
 */
function textBubble(body, glyphs = [], links = [], mentions = []) {
  const bubble = el('div', 'bubble');
  if (glyphs.length > 0) {
    const parts = body.split(GLYPH);
    const alone = parts.every((part) => part.trim() === '');
    if (alone) bubble.classList.add('sticker', glyphs.length === 1 ? 'one' : 'few');
    parts.forEach((part, n) => {
      if (n > 0 && glyphs[n - 1]) bubble.append(glyphImage(glyphs[n - 1], alone));
      if (!alone) bubble.append(linkify(part, links, mentions));
    });
    return bubble;
  }
  if (EMOJI_ONLY.test(body.trim())) {
    bubble.classList.add('jumbo');
    bubble.textContent = body.trim();
  } else {
    bubble.append(linkify(body, links, mentions));
  }
  return bubble;
}

/**
 * Reactions under a message, as on Discord: one chip per emoji with how
 * many chose it, yours tinted. Tapping a chip adds or takes back yours;
 * holding it (or hovering, with a mouse) says who.
 */
function setReactions(li, item, pop = null) {
  li.querySelector('.reactions')?.remove();
  const reactions = item.reactions ?? [];
  if (reactions.length === 0) return;
  const holder = el('div', 'reactions');
  const byEmoji = new Map();
  for (const r of reactions) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.userId]);
  for (const [emoji, people] of byEmoji) {
    const mine = people.includes(me.id);
    const chip = el('button', `chip${mine ? ' mine' : ''}`);
    chip.type = 'button';
    chip.dataset.emoji = emoji;
    chip.append(el('span', 'chip-emoji', emoji), el('span', 'chip-count', String(people.length)));
    const names = people.map(nameOf).join(', ');
    chip.title = names;
    chip.setAttribute('aria-label', `${emoji} ${names}`);
    chip.setAttribute('aria-pressed', String(mine));
    if (emoji === pop && !reducedMotion.matches) chip.classList.add('pop');
    holder.append(chip);
  }
  const anchor =
    li.querySelector('.edited-label') ?? [...li.querySelectorAll('.bubble:not(.past)')].at(-1);
  anchor?.after(holder);
}

/** "Edited" under an edited message; tapped, its earlier versions above it. */
function setEdited(li, item) {
  li.querySelector('.edited-label')?.remove();
  li.querySelector('.edit-history')?.remove();
  if (!item.editedAt) return;
  const open = showingEdits.has(item.id);
  const label = el('button', 'edited-label', open ? T.hideEdits : T.edited);
  label.type = 'button';
  label.dataset.toggleEdits = String(item.id);
  label.setAttribute('aria-expanded', String(open));
  const current = li.querySelector('.bubble:not(.photo):not(.past):not(.link-card)');
  current?.after(label);
  if (open && current) {
    const history = el('div', 'edit-history');
    (item.edits ?? []).forEach((version, index) => {
      const past = textBubble(version.body);
      past.classList.add('past');
      const at = index === 0 ? item.createdAt : item.edits[index - 1].at;
      past.title = fullFormat.format(at);
      history.append(past);
    });
    current.before(history);
  }
}

function unsentNode(item) {
  const li = el(
    'li',
    'msg unsent-note',
    item.userId === me.id ? T.youUnsent : T.unsent(nameOf(item.userId)),
  );
  li.tabIndex = -1;
  return li;
}

function messageNode(item) {
  if (item.unsent) return unsentNode(item);
  const mine = item.userId === me.id;
  const li = el('li', `msg ${mine ? 'msg-out' : 'msg-in'}`);
  li.tabIndex = -1;
  const author = el('span', 'msg-author', nameOf(item.userId));
  author.hidden = true;
  li.append(author);

  if (item.replyTo !== null && item.replyTo !== undefined) {
    const quote = el('div', 'quote');
    fillQuote(quote, item.replyTo);
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
    const bubble = textBubble(item.body, item.glyphs, item.links, item.mentions);
    // Kept (Edit works on it), but not shown while cards say it all.
    if (onlyCards(item)) bubble.classList.add('links-only');
    li.append(bubble);
  }
  for (const preview of cardsOf(item)) li.append(linkCard(preview));
  setEdited(li, item);
  setReactions(li, item);

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
  receiptKey = items.findLast((i) => i.userId === me.id && i.key.startsWith('m') && !i.unsent)?.key;
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
    // An unsent message's note stands alone, between runs.
    const runStart =
      separated ||
      item.unsent ||
      previous.unsent ||
      previous.userId !== item.userId ||
      item.createdAt - previous.createdAt > RUN_GAP_MS;
    const nextSeparated =
      !next ||
      startOfDay(next.createdAt) !== startOfDay(item.createdAt) ||
      next.createdAt - item.createdAt > SEPARATOR_GAP_MS;
    const runEnd =
      nextSeparated ||
      item.unsent ||
      next.unsent ||
      next.userId !== item.userId ||
      next.createdAt - item.createdAt > RUN_GAP_MS;
    node.classList.toggle('run-start', runStart);
    node.classList.toggle('run-end', runEnd);
    node.classList.toggle('pending', item.key.startsWith('p') && item.state !== 'failed');
    node.classList.toggle('failed', item.state === 'failed');
    node.dataset.key = item.key;
    const author = node.querySelector('.msg-author');
    if (author) author.hidden = !(runStart && item.userId !== me.id);
    setFootnote(node, item, item.key === receiptKey);
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

/** The read line under your most recent message, wherever it is; the failure note when one didn't go. */
function setFootnote(node, item, isLast) {
  node.querySelector('.receipt')?.remove();
  node.querySelector('.failed-note')?.remove();
  if (item.state === 'failed') {
    const note = el('button', 'failed-note', item.error ?? T.notDelivered);
    note.type = 'button';
    note.dataset.retry = item.clientId;
    node.append(note);
  } else if (isLast && item.userId === me.id && item.key.startsWith('m') && !item.unsent) {
    const text = receiptText(item);
    // Tapped: Info, who read it and when.
    const receipt = el('button', 'receipt', text);
    receipt.type = 'button';
    receipt.dataset.info = String(item.id);
    // "Delivered" turning into "Read by…" fades across; the line never moves.
    if (lastReceipt.key === item.key && lastReceipt.text !== text) receipt.classList.add('changed');
    lastReceipt = { key: item.key, text };
    node.append(receipt);
  }
}

let lastReceipt = { key: '', text: '' };
/** Your most recent message: the one that carries the read line. */
let receiptKey;

/** The others in the conversation who have read `item`: their read mark has passed it. */
function readersOf(item) {
  return [...members.values()].filter(
    (member) =>
      member.id !== me.id &&
      member.id !== item.userId &&
      member.active &&
      member.lastReadRev >= (item.sentRev ?? item.rev),
  );
}

/**
 * The line under your most recent message: Delivered, then who has read
 * it and how many of the others that is — "Read by Harrison · 1 of 2",
 * "Read by All". With one other person it's iMessage's plain "Read".
 * Tapping it opens Info: who, and when.
 */
function receiptText(item) {
  const others = [...members.values()].filter((member) => member.id !== me.id && member.active);
  const readers = readersOf(item);
  if (readers.length === 0) return T.delivered;
  if (others.length === 1) return T.read;
  if (readers.length >= others.length) return T.readByAll;
  const names = readers.slice(0, 2).map((member) => member.name);
  if (readers.length > 2) names.push(T.more(readers.length - 2));
  return T.readOf(names, readers.length, others.length);
}

/** Someone read further: only the receipt line changes, in place. */
function refreshReceipt() {
  const node = receiptKey && nodes.get(receiptKey);
  const item = node && itemFor(node);
  if (item) setFootnote(node, { ...item, key: receiptKey }, true);
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

/**
 * Runs a change that may resize messages already on screen (an edit, an
 * unsend, Tapbacks) without moving what the reader is looking at: at the
 * bottom they stay at the bottom; scrolled up, the first message in view
 * keeps its place.
 */
function keepPlace(change) {
  if (stick) {
    change();
    scrollToBottom(false);
    return;
  }
  const top = scroller.getBoundingClientRect().top;
  const anchor = [...list.children].find((node) => node.getBoundingClientRect().bottom > top);
  const before = anchor?.getBoundingClientRect().top ?? 0;
  change();
  if (anchor?.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - before;
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
  if (messages.has(message.id)) {
    applyUpdate(message);
    return false;
  }
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
    // Drawn before the server said whom it mentions: drawn again, marked.
    if (message.mentions?.length) setTimeout(() => rebuild(message.id));
    return false;
  }
  messages.set(message.id, message);
  return fromStream && !message.unsent;
}

/**
 * A change to a message this page has — an edit, an unsend, a Tapback —
 * from the stream or a response. The newest version wins (its rev), and
 * only what changed is redrawn: an edit swaps the text, a Tapback the
 * badges, an unsend lets the bubble go and leaves the note.
 */
function applyUpdate(message) {
  const old = messages.get(message.id);
  if (!old || message.rev < old.rev) return;
  if (editing?.id === message.id) {
    editing.pending = message;
    return;
  }
  messages.set(message.id, message);
  const key = `m${message.id}`;
  const node = nodes.get(key);
  // Replies quoting it follow what it now says.
  for (const quote of list.querySelectorAll(`.quote[data-reply-to="${message.id}"]`)) {
    fillQuote(quote, message.id);
  }
  if (!node) return;
  if (message.unsent && !old.unsent) {
    if (menuFor === node) closeMenu(true);
    const swap = () =>
      keepPlace(() => {
        nodes.delete(key);
        node.remove();
        render({ animate: new Set([key]) });
      });
    if (reducedMotion.matches || !node.isConnected) swap();
    else {
      node.classList.add('vanish');
      setTimeout(swap, 320);
    }
    return;
  }
  if (message.unsent) return;
  // A card arrived (or an edit changed the links): drawn afresh.
  if (JSON.stringify(message.links ?? []) !== JSON.stringify(old.links ?? [])) {
    rebuild(message.id);
    return;
  }
  const item = { ...message, key };
  keepPlace(() => {
    if (message.body !== old.body) {
      const current = node.querySelector('.bubble:not(.photo):not(.past):not(.link-card)');
      const fresh = textBubble(message.body, message.glyphs, message.links, message.mentions);
      if (current) current.replaceWith(fresh);
      if (!reducedMotion.matches) fresh.classList.add('edited-in');
    }
    setEdited(node, item);
    const added = (message.reactions ?? []).find(
      (r) => !(old.reactions ?? []).some((o) => o.userId === r.userId && o.emoji === r.emoji),
    );
    setReactions(node, item, added?.emoji ?? null);
    render();
  });
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
  if (page.now) skew = page.now - Date.now();
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
    if (hello.now) skew = hello.now - Date.now();
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
  source.addEventListener('update', (event) => {
    advance(event);
    applyUpdate(JSON.parse(event.data));
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
  source.addEventListener('read', (event) => {
    const { userId, rev: readRev } = JSON.parse(event.data);
    const member = members.get(userId);
    if (!member || readRev <= (member.lastReadRev ?? 0)) return;
    member.lastReadRev = readRev;
    refreshReceipt();
  });
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
      .filter((p) => !p.file && !p.glyphs)
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
    if (p.glyphs && !p.glyphIds) {
      const ids = [];
      for (const glyph of p.glyphs) {
        const response = await api(`${BASE}/api/images?w=${glyph.width}&h=${glyph.height}`, {
          method: 'POST',
          body: glyph.file,
          headers: { 'content-type': 'image/png' },
        });
        if (!response.ok)
          throw Object.assign(new Error('upload'), { status: response.status, response });
        ids.push((await response.json()).imageId);
      }
      p.glyphIds = ids;
    }
    const response = await api(`${BASE}/api/messages`, {
      method: 'POST',
      json: {
        clientId: p.clientId,
        body: p.body,
        imageId: p.imageId ?? null,
        glyphs: p.glyphIds ?? [],
        replyTo: p.replyTo,
      },
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

// The composer is a rich text box over the form's plain textarea (which
// stays for a page without JavaScript): Safari offers Genmoji and stickers
// only where an image can go, and puts them into the text as images.
const editor = el('div', 'editor');
editor.contentEditable = 'true';
editor.setAttribute('role', 'textbox');
editor.setAttribute('aria-multiline', 'true');
editor.setAttribute('aria-label', input.getAttribute('aria-label') ?? '');
editor.dataset.placeholder = input.placeholder;
for (const name of ['autocapitalize', 'autocorrect', 'spellcheck']) {
  const value = input.getAttribute(name);
  if (value !== null) editor.setAttribute(name, value);
}
editor.enterKeyHint = finePointer ? 'send' : 'enter';
input.hidden = true;
input.after(editor);

/** What's in the composer: its text, with GLYPH where each image (Genmoji, sticker) is. */
function readEditor() {
  let text = '';
  const images = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeName === '#text') text += child.data;
      else if (child.nodeName === 'BR') text += '\n';
      else if (child.nodeName === 'IMG') {
        text += GLYPH;
        images.push(child);
      } else if (child.nodeType === 1 && child.nodeName !== 'SOURCE') {
        if (/^(DIV|P|LI)$/.test(child.nodeName) && text !== '' && !text.endsWith('\n')) {
          text += '\n';
        }
        walk(child);
      }
    }
  };
  walk(editor);
  return { text: text.replace(/\u00A0/g, ' ').replace(/\s+$/, ''), images };
}

/**
 * Keeps the composer plain: text, line breaks and images only. Whatever
 * else a paste or the keyboard brings (bold, links, colours) is unwrapped
 * to its text.
 */
const KEEP = new Set(['DIV', 'P', 'BR', 'IMG', 'PICTURE', 'SOURCE']);
function tidyEditor() {
  for (const node of editor.querySelectorAll('*')) {
    if (!KEEP.has(node.nodeName)) node.replaceWith(...node.childNodes);
    else if (node.nodeName !== 'IMG' && node.nodeName !== 'SOURCE') node.removeAttribute('style');
  }
}

/**
 * A Genmoji or sticker as a small transparent PNG for sending: drawn from
 * the image the browser shows (Safari's adaptive glyph has a PNG beside it
 * for exactly this), at most 320px.
 */
async function glyphFile(img) {
  try {
    await img.decode();
    const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? { file: blob, width: canvas.width, height: canvas.height } : null;
  } catch {
    return null;
  }
}

async function sendText() {
  const { text, images } = readEditor();
  if (text.trim() === '') return;
  // Taken out of the composer at once; the images are drawn from these copies.
  const copies = images.map((img) => img.cloneNode());
  editor.replaceChildren();
  autosize();
  updatePicker();
  if (copies.length === 0) {
    queue({ body: text });
    return;
  }
  const glyphs = [];
  let body = '';
  const parts = text.split(GLYPH);
  for (let n = 0; n < parts.length; n += 1) {
    body += parts[n];
    if (n === parts.length - 1) break;
    const glyph = await glyphFile(copies[n]);
    if (!glyph) continue; // Couldn't be read: left out, the words still go.
    glyphs.push({ ...glyph, previewUrl: URL.createObjectURL(glyph.file) });
    body += GLYPH;
  }
  if (body.trim() === '') return;
  queue(glyphs.length > 0 ? { body, glyphs } : { body });
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendText();
});

// Keep the keyboard up: pressing Send mustn't take focus from the field.
sendButton.addEventListener('mousedown', (event) => event.preventDefault());

editor.addEventListener('keydown', (event) => {
  // isComposing / 229: Enter is confirming a pinyin candidate, not sending.
  if (event.isComposing || event.keyCode === 229) return;
  if (pickerKey(event)) return;
  if (event.key === 'Enter' && !event.shiftKey && finePointer) {
    event.preventDefault();
    sendText();
  } else if (event.key === 'Escape' && replyTo !== null) {
    setReply(null);
  }
});

// Pasted photos are photos (sent as they are now); pasted text arrives
// plain. A pasted Genmoji is let in as one.
editor.addEventListener('paste', (event) => {
  const data = event.clipboardData;
  if (!data) return;
  if (/x-apple-adaptive-glyph/.test(data.getData('text/html'))) return;
  event.preventDefault();
  const files = [...data.files].filter((file) => file.type.startsWith('image/'));
  if (files.length > 0) {
    sendPhotos(files);
    return;
  }
  const text = data.getData('text/plain');
  if (text) document.execCommand('insertText', false, text);
});
editor.addEventListener('drop', (event) => {
  const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;
  event.preventDefault();
  sendPhotos(files);
});

/** The send button, and the placeholder: shown while there's nothing in the composer. */
function autosize() {
  const { text } = readEditor();
  const empty = text.trim() === '';
  editor.classList.toggle('is-empty', empty && editor.querySelector('img') === null);
  // A box emptied by deleting can keep a stray <br>; empty is empty.
  if (empty && editor.querySelector('img') === null && editor.childNodes.length > 0) {
    editor.replaceChildren();
  }
  sendButton.disabled = empty;
}

editor.addEventListener('input', () => {
  const wasAtBottom = stick;
  tidyEditor();
  autosize();
  if (wasAtBottom) scrollToBottom(false);
  const now = Date.now();
  if (!editor.classList.contains('is-empty') && now - lastTypingSent > 2500) {
    lastTypingSent = now;
    api(`${BASE}/api/typing`, { method: 'POST' }).catch(() => {});
  }
});

// ---- mentions ---------------------------------------------------------

/**
 * Typing "@" offers the others in the chat, filtered by what follows;
 * picking one writes "@Name " in its place. Only text: the server finds
 * mentions in what's sent (store.ts findMentions), so one typed out by
 * hand, or without JavaScript, is a mention all the same.
 */
const picker = el('ul', 'mention-picker');
picker.id = 'mention-picker';
picker.setAttribute('role', 'listbox');
picker.setAttribute('aria-label', T.mention);
picker.hidden = true;
composer.querySelector('.composer-row').before(picker);
/** What's being completed: the text node, where its "@" is, and the choices. */
let picking = null;

/** The "@query" just before the caret, if the caret is at the end of one. */
function mentionQuery() {
  const selection = document.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode) return null;
  const node = selection.anchorNode;
  if (node.nodeName !== '#text' || !editor.contains(node)) return null;
  const before = node.data.slice(0, selection.anchorOffset);
  const match = /(?:^|[\s(（“"'])@([^\s@]{0,24})$/u.exec(before);
  if (!match) return null;
  return {
    node,
    start: selection.anchorOffset - match[1].length - 1,
    end: selection.anchorOffset,
    query: match[1],
  };
}

function updatePicker() {
  const found = document.activeElement === editor ? mentionQuery() : null;
  const query = found?.query.toLowerCase() ?? '';
  const choices = found
    ? [...members.values()]
        .filter((m) => m.active && m.id !== me.id)
        // "@d" finds Dad, and "@may" finds Aunt May.
        .filter((m) =>
          [m.name, ...m.name.split(' ').slice(1)].some((part) =>
            part.toLowerCase().startsWith(query),
          ),
        )
        .slice(0, 6)
    : [];
  if (choices.length === 0) {
    picking = null;
    picker.hidden = true;
    editor.removeAttribute('aria-activedescendant');
    return;
  }
  const keep = picking?.choices[picking.index]?.id;
  const index = Math.max(
    0,
    choices.findIndex((m) => m.id === keep),
  );
  picking = { ...found, choices, index };
  picker.replaceChildren(
    ...choices.map((member, n) => {
      const option = el('li', 'mention-option', member.name);
      option.id = `mention-${member.id}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(n === index));
      // Keep the keyboard up: tapping a name mustn't take focus from the field.
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => pick(n));
      return option;
    }),
  );
  picker.hidden = false;
  editor.setAttribute('aria-activedescendant', `mention-${choices[index].id}`);
}

function pick(n) {
  const member = picking?.choices[n];
  if (!member) return;
  const range = document.createRange();
  range.setStart(picking.node, picking.start);
  range.setEnd(picking.node, Math.min(picking.end, picking.node.length));
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  // As if typed: one step of Undo, and the input event that follows.
  document.execCommand('insertText', false, `@${member.name} `);
  haptic();
  updatePicker();
}

/** Arrows, Enter or Tab and Escape while names are offered. True if it was the picker's. */
function pickerKey(event) {
  if (!picking) return false;
  const count = picking.choices.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    picking.index = (picking.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    const chosen = picking.choices[picking.index].id;
    for (const option of picker.children) {
      option.setAttribute('aria-selected', String(option.id === `mention-${chosen}`));
    }
    editor.setAttribute('aria-activedescendant', `mention-${chosen}`);
  } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
    pick(picking.index);
  } else if (event.key === 'Escape') {
    picking = null;
    picker.hidden = true;
  } else {
    return false;
  }
  event.preventDefault();
  return true;
}

document.addEventListener('selectionchange', updatePicker);
editor.addEventListener('blur', updatePicker);

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

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  sendPhotos(files);
});

async function sendPhotos(files) {
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
}

list.addEventListener('click', (event) => {
  // A long press opened the menu: lifting the finger mustn't also follow a link.
  if (suppressClick && event.target.closest('a')) {
    event.preventDefault();
    return;
  }
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
  const info = event.target.closest('.receipt[data-info]');
  if (info) {
    const item = messages.get(Number(info.dataset.info));
    if (item) openInfo(item);
    return;
  }
  const toggleEdits = event.target.closest('[data-toggle-edits]');
  if (toggleEdits) {
    const id = Number(toggleEdits.dataset.toggleEdits);
    if (showingEdits.has(id)) showingEdits.delete(id);
    else showingEdits.add(id);
    const node = nodes.get(`m${id}`);
    const item = messages.get(id);
    if (node && item) keepPlace(() => setEdited(node, { ...item, key: `m${id}` }));
    return;
  }
  const chip = event.target.closest('.chip');
  if (chip) {
    if (suppressClick) return;
    const node = chip.closest('.msg');
    const item = node && itemFor(node);
    if (item) {
      haptic();
      react(item.id, chip.dataset.emoji, !chip.classList.contains('mine'));
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
    editor.focus();
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
  // Those on screen: a text hidden behind its link cards isn't.
  const bubbles = [...node.querySelectorAll('.bubble')].filter((b) => b.getClientRects().length);
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

  const age = serverNow() - item.createdAt;
  const own = stored && item.userId === me.id;
  if (stored) {
    add(T.reply, svg('M10 8 4 13l6 5M4 13h10a6 6 0 0 1 6 6v1'), () => {
      closeMenu();
      setReply(item.id);
    });
  }
  const editable = item.body && !(item.glyphs ?? []).length;
  if (own && editable && age < EDIT_WINDOW_MS && (item.edits ?? []).length < MAX_EDITS) {
    add(T.edit, svg('M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4'), () => {
      closeMenu(true);
      startEdit(item.id);
    });
  }
  if (own && age < UNSEND_WINDOW_MS) {
    add(T.undoSend, svg('M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11'), () => {
      closeMenu(true);
      unsend(item.id);
    });
  }
  if (own) {
    add(T.info, svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5v.5'), () => {
      closeMenu();
      openInfo(item);
    });
  }
  if (item.body) {
    add(T.copy, svg('M9 9h10v11H9zM5 15V4h10'), () => {
      navigator.clipboard?.writeText(item.body.replaceAll(GLYPH, '')).catch(() => {});
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

  // The reaction bar, above the lifted message: iMessage's six, then a
  // face for any emoji at all.
  let tapbar = null;
  if (stored && !item.unsent) {
    const mine = new Set(
      (item.reactions ?? []).filter((r) => r.userId === me.id).map((r) => r.emoji),
    );
    tapbar = el('div', 'tapback-bar');
    tapbar.setAttribute('role', 'group');
    tapbar.setAttribute('aria-label', T.reactions);
    for (const emoji of QUICK) {
      const chosen = mine.has(emoji);
      const button = el('button', chosen ? 'chosen' : '', emoji);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(chosen));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        haptic();
        closeMenu();
        react(item.id, emoji, !chosen);
      });
      tapbar.append(button);
    }
    const more = el('button', 'more');
    more.type = 'button';
    more.setAttribute('aria-label', T.addReaction);
    more.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu(true);
      openEmojiPicker(item.id);
    });
    tapbar.append(more);
    layer.append(tapbar);
  }

  const width = Math.max(220, menu.offsetWidth);
  const height = menu.offsetHeight;
  const viewportHeight = window.visualViewport?.height ?? innerHeight;
  const below = lastRect.bottom + 10;
  // Above the message: the Tapback bar, and the menu over it when there's
  // no room for the menu below.
  let above = rect.top - 10;
  if (tapbar) {
    const barHeight = tapbar.offsetHeight;
    const barWidth = tapbar.offsetWidth;
    const out = node.classList.contains('msg-out');
    let barTop = rect.top - barHeight - 10;
    if (barTop < 12) barTop = 12;
    above = barTop - 10;
    let barLeft = out ? Math.max(rect.right, lastRect.right) - barWidth : rect.left;
    barLeft = Math.max(12, Math.min(barLeft, innerWidth - barWidth - 12));
    tapbar.style.top = `${Math.max(12, barTop)}px`;
    tapbar.style.left = `${barLeft}px`;
    tapbar.style.transformOrigin = out ? '100% 100%' : '0 100%';
  }
  let top = below + height < viewportHeight - 12 ? below : above - height;
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
  const buttons = [...layer.querySelectorAll('.tapback-bar button, .menu button')];
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
    press = {
      x: touch.clientX,
      y: touch.clientY,
      node,
      timer: 0,
      swiping: false,
      replying: false,
      moved: false,
    };
    const chip = event.target.closest('.chip');
    if (node && chip) {
      press.timer = setTimeout(() => {
        if (!press || press.moved) return;
        suppressClick = true;
        haptic();
        const item = itemFor(node);
        if (item) openReactions(item);
      }, 420);
    } else if (node && event.target.closest('.bubble')) {
      press.timer = setTimeout(() => {
        if (!press || press.moved) return;
        suppressClick = true;
        haptic();
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
    const sideways = Math.abs(dx) > Math.abs(dy) * 1.4;
    if (!press.swiping && !press.replying && dx < -12 && sideways) press.swiping = true;
    // Swipe a message right to reply to it, as in iMessage.
    if (!press.swiping && !press.replying && dx > 12 && sideways && replyable(press.node)) {
      press.replying = true;
      press.node.classList.add('pulling');
    }
    if (press.replying) {
      event.preventDefault();
      const pull = Math.max(0, dx - 12);
      const shown = pull < 64 ? pull : 64 + (pull - 64) * 0.2;
      press.node.style.setProperty('--pull', `${shown}px`);
      const armed = pull >= 56;
      if (armed !== press.node.classList.contains('armed')) {
        press.node.classList.toggle('armed', armed);
        if (armed) haptic();
      }
    } else if (press.swiping) {
      event.preventDefault();
      const pull = Math.max(0, -dx);
      const reveal = pull < 74 ? pull : 74 + (pull - 74) * 0.2;
      list.classList.add('revealing');
      list.style.setProperty('--reveal', `${reveal}px`);
    }
  },
  { passive: false },
);

function replyable(node) {
  const key = node?.dataset.key ?? '';
  return key.startsWith('m') && !messages.get(Number(key.slice(1)))?.unsent;
}

const endPress = () => {
  if (!press) return;
  clearTimeout(press.timer);
  if (press.replying) {
    const node = press.node;
    if (node.classList.contains('armed')) setReply(Number(node.dataset.key.slice(1)));
    node.classList.remove('pulling', 'armed');
    node.style.setProperty('--pull', '0px');
  }
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

// ---- edit, undo send, tapbacks ---------------------------------------------

/** A short note under a message when a change to it didn't go through. */
function noteFailure(id, text) {
  const node = nodes.get(`m${id}`);
  if (!node) return;
  node.querySelector('.change-failed')?.remove();
  const note = el('div', 'change-failed', text);
  note.setAttribute('role', 'status');
  node.append(note);
  setTimeout(() => note.remove(), 4000);
}

/** Puts a change's result in place, or puts back what was there and says so. */
async function change(id, request, before, failure) {
  try {
    const response = await request();
    if (!response.ok) throw new Error(String(response.status));
    applyUpdate((await response.json()).message);
  } catch {
    const now = messages.get(id);
    if (now) applyUpdate({ ...before, rev: now.rev + 1e-6 });
    noteFailure(id, failure);
  }
}

/** Adds (`on`) or takes back your reaction with `emoji`. */
function react(id, emoji, on) {
  const before = messages.get(id);
  if (!before || !isEmoji(emoji)) return;
  const reactions = before.reactions ?? [];
  const had = reactions.some((r) => r.userId === me.id && r.emoji === emoji);
  if (had === on) return;
  if (on) remember(emoji);
  // Shown at once; the server's answer (and everyone else's stream) follows.
  applyUpdate({
    ...before,
    rev: before.rev + 1e-6,
    reactions: on
      ? [...reactions, { userId: me.id, emoji }]
      : reactions.filter((r) => !(r.userId === me.id && r.emoji === emoji)),
  });
  change(
    id,
    () => api(`${BASE}/api/messages/${id}/reaction`, { method: 'POST', json: { emoji, on } }),
    before,
    T.couldntEdit,
  );
}

/**
 * Any emoji: the keyboard's own (type one into the field — the emoji key
 * has them all), what this device used lately, and a grid of the usual
 * ones by category.
 */
function openEmojiPicker(id) {
  let close = () => {};
  const pick = (emoji) => {
    haptic();
    close();
    const mine = (messages.get(id)?.reactions ?? []).some(
      (r) => r.userId === me.id && r.emoji === emoji,
    );
    react(id, emoji, !mine);
  };
  const grid = (parent, title, list) => {
    if (list.length === 0) return;
    const section = el('section', 'emoji-section');
    section.append(el('h3', 'group-title', title));
    const cells = el('div', 'emoji-grid');
    for (const emoji of list) {
      const button = el('button', '', emoji);
      button.type = 'button';
      button.addEventListener('click', () => pick(emoji));
      cells.append(button);
    }
    section.append(cells);
    parent.append(section);
  };
  close = openSheet({
    title: T.addReaction,
    closeLabel: T.done,
    build: (body) => {
      const field = el('input', 'emoji-field');
      field.type = 'text';
      field.placeholder = T.anyEmoji;
      field.setAttribute('aria-label', T.anyEmoji);
      field.autocomplete = 'off';
      field.enterKeyHint = 'done';
      field.addEventListener('input', () => {
        const typed = [...new Intl.Segmenter().segment(field.value.trim())].map((g) => g.segment);
        const last = typed.at(-1);
        if (last && isEmoji(last)) pick(last);
      });
      body.append(field);
      grid(body, T.recentEmoji, recent());
      for (const [name, list] of CATEGORIES) grid(body, T.categories[name], list);
    },
  });
}

function unsend(id) {
  const before = messages.get(id);
  if (!before) return;
  haptic();
  applyUpdate({
    ...before,
    rev: before.rev + 1e-6,
    unsent: true,
    body: '',
    image: null,
    edits: [],
    reactions: [],
    editedAt: null,
  });
  if (replyTo === id) setReply(null);
  change(
    id,
    () => api(`${BASE}/api/messages/${id}/unsend`, { method: 'POST', json: {} }),
    before,
    T.couldntUnsend,
  ).then(() => {
    // Put back as it was: the bubble needs drawing afresh, not patching.
    if (!messages.get(id)?.unsent) rebuild(id);
  });
}

/** Draws one message again from scratch, in place. */
function rebuild(id) {
  const key = `m${id}`;
  const old = nodes.get(key);
  const item = messages.get(id);
  if (!old || !item) return;
  const fresh = messageNode({ ...item, key });
  keepPlace(() => {
    old.replaceWith(fresh);
    nodes.set(key, fresh);
    render();
  });
}

/** iMessage's Edit: the bubble becomes a field, in place, with Cancel and Save. */
function startEdit(id) {
  const item = messages.get(id);
  const node = nodes.get(`m${id}`);
  const bubble = node?.querySelector('.bubble:not(.photo):not(.past):not(.link-card)');
  if (!item || !bubble || editing) return;
  const form = el('form', 'edit-field');
  const field = el('textarea');
  field.value = item.body;
  field.rows = 1;
  field.maxLength = 4000;
  field.setAttribute('aria-label', T.edit);
  field.setAttribute('autocapitalize', 'sentences');
  const cancel = el('button', 'edit-cancel');
  cancel.type = 'button';
  cancel.setAttribute('aria-label', T.cancel);
  cancel.innerHTML =
    '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const save = el('button', 'edit-save');
  save.type = 'submit';
  save.setAttribute('aria-label', T.save);
  save.innerHTML =
    '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  form.append(cancel, field, save);
  editing = { id, node, pending: null };
  node.classList.add('editing');
  bubble.hidden = true;
  bubble.after(form);

  const size = () => {
    field.style.height = '0px';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  };
  const finish = () => {
    const pending = editing?.pending;
    editing = null;
    node.classList.remove('editing');
    form.remove();
    bubble.hidden = false;
    if (pending) applyUpdate(pending);
  };
  cancel.addEventListener('click', finish);
  // Keep the keyboard up: tapping Save or Cancel mustn't blur the field first.
  for (const button of [cancel, save]) {
    button.addEventListener('mousedown', (event) => event.preventDefault());
  }
  field.addEventListener('input', size);
  field.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finish();
    } else if (event.key === 'Enter' && !event.shiftKey && finePointer) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = field.value.trim();
    const before = messages.get(id);
    finish();
    if (!before || body === '' || body === before.body.trim()) return;
    const now = serverNow();
    applyUpdate({
      ...before,
      rev: before.rev + 1e-6,
      body,
      editedAt: now,
      edits: [...(before.edits ?? []), { body: before.body, at: now }],
    });
    change(
      id,
      () => api(`${BASE}/api/messages/${id}`, { method: 'PATCH', json: { body } }),
      before,
      T.couldntEdit,
    );
  });
  keepPlace(size);
  field.focus({ preventScroll: true });
  field.setSelectionRange(field.value.length, field.value.length);
  node.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

/** Who reacted with what: holding a reaction chip. */
function openReactions(item) {
  openSheet({
    title: T.reactions,
    closeLabel: T.done,
    build: (body) => {
      const { rows } = group(body);
      for (const reaction of item.reactions ?? []) {
        row(rows, nameOf(reaction.userId), reaction.emoji);
      }
    },
  });
}

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

// ---- info: who read a message ---------------------------------------------

/** WhatsApp's Message Info, in the details sheet's dress: read by whom and when. */
function openInfo(item) {
  openSheet({
    title: T.info,
    closeLabel: T.done,
    build: (body) => {
      const loading = el('p', 'group-note', '…');
      body.append(loading);
      api(`${BASE}/api/messages/${item.id}/receipts`)
        .then((response) => (response.ok ? response.json() : null))
        .then((receipts) => {
          loading.remove();
          if (!receipts) return;
          const name = (id) => members.get(id)?.name ?? '';
          const read = group(
            body,
            T.readHeading,
            receipts.read.length === 0 ? T.nobodyYet : undefined,
          );
          for (const reader of receipts.read) {
            row(
              read.rows,
              name(reader.userId),
              reader.at ? readFormat.format(reader.at) : T.readEarlier,
            );
          }
          if (receipts.unread.length > 0) {
            const waiting = group(body, T.notYet);
            for (const id of receipts.unread) row(waiting.rows, name(id), '');
          } else if (receipts.read.length > 0) {
            read.section.append(el('p', 'group-note', T.everyone));
          }
        })
        .catch(() => loading.remove());
    },
  });
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
input.removeAttribute('name');
autosize();
restoreOutbox();

async function start(attempt = 0) {
  try {
    await loadLatest();
    connect();
    // Opened from a notification or a search result: <base>/#m<id>. An
    // older message is fetched back to, a page at a time.
    const linked = /^#m(\d+)$/.exec(location.hash);
    if (linked) {
      const id = Number(linked[1]);
      for (let pages = 0; !nodes.has(`m${id}`) && hasMore && pages < 40; pages += 1) {
        await loadOlder();
      }
      if (reveal(id)) history.replaceState(null, '', `${BASE}/`);
    }
    if (attempt === 0) registerWorker().then(() => syncSubscription(api).catch(() => {}));
  } catch {
    setConnected(false);
    setTimeout(() => start(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
  }
}

start();
