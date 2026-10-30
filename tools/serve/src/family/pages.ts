import { escapeHtml } from '../pages.ts';
import type { ChatIdentity } from './chats.ts';
import type { Connection, HubEvent } from './hub.ts';
import { GLYPH } from './store.ts';
import type { Lang, LinkPreview, Message, SessionInfo, User } from './store.ts';

export interface Assets {
  /** `/family` or `/disc`: the chat's path, which every link and form on its pages starts with. */
  readonly base: string;
  readonly chat: ChatIdentity;
  /** `<base>/static/<name>?v=<hash>` for each static file. */
  readonly url: (name: string) => string;
  /** The modules chat.js imports, preloaded so they arrive with it rather than after it. */
  readonly modules: readonly string[];
}

const STRINGS = {
  en: {
    placeholder: 'Message',
    send: 'Send',
    attach: 'Add a photo',
    signOut: 'Sign Out',
    admin: 'Members',
    password: 'Change Password',
    search: 'Search',
    noScript: 'Without JavaScript, new messages appear when you reload the page.',
    empty: 'No messages yet. Say hello.',
    details: 'Details & Notifications',
    edited: 'Edited',
    kinds: {
      track: 'Song',
      album: 'Album',
      playlist: 'Playlist',
      artist: 'Artist',
      episode: 'Episode',
      show: 'Podcast',
    } as Record<string, string>,
    unsent: (name: string) => `${name} unsent a message.`,
    youUnsent: 'You unsent a message.',
  },
  zh: {
    placeholder: '信息',
    send: '发送',
    attach: '添加照片',
    signOut: '退出登录',
    admin: '成员',
    password: '修改密码',
    search: '搜索',
    noScript: '未启用 JavaScript：刷新页面即可看到新消息。',
    empty: '还没有消息，打个招呼吧。',
    details: '详细信息与通知',
    edited: '已编辑',
    kinds: {
      track: '歌曲',
      album: '专辑',
      playlist: '歌单',
      artist: '艺人',
      episode: '单集',
      show: '播客',
    } as Record<string, string>,
    unsent: (name: string) => `${name}撤回了一条信息。`,
    youUnsent: '你撤回了一条信息。',
  },
} as const;

function head(title: string, assets: Assets, lang: string): string {
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-Hans' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(assets.chat.name)}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="format-detection" content="telephone=no">
<link rel="manifest" href="${assets.base}/manifest.webmanifest">
<link rel="apple-touch-icon" href="${assets.url('icon-180.png')}">
<link rel="icon" type="image/png" href="${assets.url('icon-180.png')}">
<link rel="stylesheet" href="${assets.url('family.css')}">
<title>${escapeHtml(title)}</title>
</head>`;
}

/** The sign-in screen. Bilingual, because it can't know yet who is signing in. */
export function renderLogin(assets: Assets, error: string | null, username = ''): string {
  return `${head(assets.chat.name, assets, 'en')}
<body class="family-auth">
<main class="auth">
  <img class="auth-icon" src="${assets.url('icon-180.png')}" alt="" width="72" height="72">
  <h1 class="auth-title">${escapeHtml(assets.chat.name)}</h1>
  <form class="auth-form" method="POST" action="${assets.base}/login">
    <div class="auth-fields">
      <label class="auth-field">
        <span class="visually-hidden">Username · 用户名</span>
        <input name="username" type="text" value="${escapeHtml(username)}" placeholder="Username · 用户名"
          autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
          inputmode="text" enterkeyhint="next" required ${username === '' ? 'autofocus' : ''}>
      </label>
      <label class="auth-field">
        <span class="visually-hidden">Password · 密码</span>
        <input name="password" type="password" placeholder="Password · 密码"
          autocomplete="current-password" enterkeyhint="go" required ${username === '' ? '' : 'autofocus'}>
      </label>
    </div>
    <p class="auth-error" role="alert">${error === null ? '' : escapeHtml(error)}</p>
    <button class="auth-submit" type="submit">Sign In · 登录</button>
  </form>
</main>
</body>
</html>
`;
}

const SEARCH_STRINGS = {
  en: {
    title: 'Search',
    placeholder: 'Search messages',
    none: 'No messages found.',
    more: 'Showing the most recent matches. Add a word to narrow it down.',
  },
  zh: {
    title: '搜索',
    placeholder: '搜索消息',
    none: '没有找到消息。',
    more: '仅显示最近的结果。可以多输入几个字缩小范围。',
  },
} as const;

/** `text` with each occurrence of `query` marked, escaped; long texts cut around the first match. */
function highlight(text: string, query: string): string {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const first = lower.indexOf(needle);
  const start = first > 60 ? first - 40 : 0;
  const shown = text.slice(start, start + 240);
  const shownLower = lower.slice(start, start + 240);
  let out = start > 0 ? '…' : '';
  let at = 0;
  for (let found = shownLower.indexOf(needle); found !== -1 && needle !== '';) {
    out += `${escapeHtml(shown.slice(at, found))}<mark>${escapeHtml(shown.slice(found, found + needle.length))}</mark>`;
    at = found + needle.length;
    found = shownLower.indexOf(needle, at);
  }
  return `${out}${escapeHtml(shown.slice(at))}${start + 240 < text.length ? '…' : ''}`;
}

/**
 * Searching this chat's messages: a plain GET form and a list of links, so
 * it works without JavaScript. A result opens the conversation at that
 * message (<base>/#m<id>, which chat.js scrolls back to).
 */
export function renderSearch(input: {
  assets: Assets;
  me: User;
  members: readonly User[];
  query: string;
  results: readonly Message[];
  hasMore: boolean;
}): string {
  const { assets, me, query, results } = input;
  const t = SEARCH_STRINGS[me.lang];
  const names = new Map(input.members.map((user) => [user.id, user.displayName]));
  const list =
    query === ''
      ? ''
      : results.length === 0
        ? `<p class="dim search-none">${t.none}</p>`
        : `<section class="group">
${results
  .map(
    (
      message,
    ) => `  <a class="cell cell-stack search-result" href="${assets.base}/#m${String(message.id)}">
    <span class="search-meta"><strong>${escapeHtml(names.get(message.userId) ?? '')}</strong><time class="dim" datetime="${new Date(message.createdAt).toISOString()}">${new Date(message.createdAt).toLocaleDateString(me.lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</time></span>
    <span class="search-text">${highlight(message.body.replaceAll(GLYPH, ''), query)}</span>
  </a>`,
  )
  .join('\n')}
</section>${input.hasMore ? `<p class="dim search-none">${t.more}</p>` : ''}`;
  return `${head(`${t.title} — ${assets.chat.name}`, assets, me.lang)}
<body class="family-admin">
<main class="admin">
  <p><a class="back" href="${assets.base}/">‹ ${escapeHtml(assets.chat.name)}</a></p>
  <h1>${t.title}</h1>
  <form class="search-form" method="GET" action="${assets.base}/search" role="search">
    <input type="search" name="q" value="${escapeHtml(query)}" placeholder="${t.placeholder}" aria-label="${t.placeholder}"
      maxlength="100" enterkeyhint="search" autocomplete="off" ${query === '' ? 'autofocus' : ''}>
  </form>
  ${list}
</main>
</body>
</html>
`;
}

const PASSWORD_STRINGS = {
  en: {
    title: 'Choose a Password',
    intro: 'You signed in with a starter password. You can choose your own now — or keep it.',
    change: 'Change Password',
    newPassword: 'New password (8+ characters)',
    save: 'Save',
    keep: 'Not Now',
    cancel: 'Cancel',
  },
  zh: {
    title: '设置密码',
    intro: '你使用的是初始密码。现在可以设置自己的密码，也可以继续使用。',
    change: '修改密码',
    newPassword: '新密码（至少 8 个字符）',
    save: '保存',
    keep: '暂不修改',
    cancel: '取消',
  },
} as const;

/**
 * Choosing your own password: offered once after signing in with a starter
 * password (`suggested`), and reachable from the menu any time. Never
 * required — "Not Now" keeps the old one.
 */
export function renderPassword(
  assets: Assets,
  me: User,
  suggested: boolean,
  error: string | null = null,
): string {
  const t = PASSWORD_STRINGS[me.lang];
  return `${head(t.change, assets, me.lang)}
<body class="family-auth">
<main class="auth">
  <img class="auth-icon" src="${assets.url('icon-180.png')}" alt="" width="72" height="72">
  <h1 class="auth-title">${suggested ? t.title : t.change}</h1>
  ${suggested ? `<p class="auth-intro">${t.intro}</p>` : ''}
  <form class="auth-form" method="POST" action="${assets.base}/password">
    <input type="text" name="username" value="${escapeHtml(me.username)}" autocomplete="username" hidden>
    <div class="auth-fields">
      <label class="auth-field">
        <span class="visually-hidden">${t.newPassword}</span>
        <input name="password" type="password" placeholder="${t.newPassword}"
          autocomplete="new-password" minlength="8" enterkeyhint="done" required autofocus>
      </label>
    </div>
    <p class="auth-error" role="alert">${error === null ? '' : escapeHtml(error)}</p>
    <button class="auth-submit" type="submit">${t.save}</button>
  </form>
  <form method="POST" action="${assets.base}/password/keep">
    <button class="auth-secondary" type="submit">${suggested ? t.keep : t.cancel}</button>
  </form>
</main>
</body>
</html>
`;
}

function formatTime(at: number): string {
  // Server-rendered times are a fallback for a page without JavaScript;
  // the script replaces them with the viewer's own time zone.
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** `text` escaped, with each of its links a link (href and words from the message's `links`). */
function linkedHtml(text: string, links: Message['links']): string {
  let out = '';
  let at = 0;
  for (const link of links) {
    const found = text.indexOf(link.raw, at);
    if (found === -1) continue;
    out += `${escapeHtml(text.slice(at, found))}<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.text)}</a>`;
    at = found + link.raw.length;
  }
  return out + escapeHtml(text.slice(at));
}

/** The previews to show as cards: each once, in order. */
function cardsOf(message: Message): LinkPreview[] {
  const seen = new Set<string>();
  const cards: LinkPreview[] = [];
  for (const link of message.links) {
    if (link.preview && !seen.has(link.preview.url)) {
      seen.add(link.preview.url);
      cards.push(link.preview);
    }
  }
  return cards;
}

/** Nothing but links with cards: the cards stand in for the text, as in iMessage. */
function onlyCards(message: Message): boolean {
  if (message.glyphs.length > 0) return false;
  let rest = message.body;
  for (const link of message.links) if (link.preview) rest = rest.replace(link.raw, '');
  return cardsOf(message).length > 0 && rest.trim() === '';
}

/** The Spotify mark, drawn here (nothing is loaded from Spotify). */
const SPOTIFY_LOGO =
  '<svg class="link-logo" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1ed760"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M6.2 9.2c3.8-1.2 8.3-.8 11.6 1.2" stroke-width="2"/><path d="M6.9 12.6c3.1-.9 6.7-.6 9.4 1" stroke-width="1.7"/><path d="M7.5 15.8c2.5-.7 5.2-.5 7.3.8" stroke-width="1.4"/></g></svg>';

const PROVIDER_NAMES: Readonly<Record<string, string>> = { spotify: 'Spotify' };

/**
 * A link's card (static/chat.js linkCard draws the same): artwork, title,
 * who it's by, and where it's from, the whole card one link to it.
 */
function cardHtml(base: string, preview: LinkPreview, lang: Lang): string {
  const kind = STRINGS[lang].kinds[preview.kind] ?? '';
  const source = [PROVIDER_NAMES[preview.provider] ?? preview.provider, kind]
    .filter(Boolean)
    .join(' · ');
  const art = preview.image
    ? `<img class="link-art" src="${base}/previews/${preview.image.id}" alt="" width="${String(preview.image.width)}" height="${String(preview.image.height)}" loading="lazy">`
    : `<span class="link-art link-art-empty">${preview.provider === 'spotify' ? SPOTIFY_LOGO : ''}</span>`;
  return `<a class="bubble link-card" data-provider="${escapeHtml(preview.provider)}" href="${escapeHtml(preview.url)}" target="_blank" rel="noopener noreferrer">${art}<span class="link-text"><span class="link-title">${escapeHtml(preview.title)}</span>${preview.subtitle ? `<span class="link-subtitle">${escapeHtml(preview.subtitle)}</span>` : ''}<span class="link-source">${preview.provider === 'spotify' ? SPOTIFY_LOGO : ''}${escapeHtml(source)}</span></span></a>`;
}

function renderStaticMessage(
  base: string,
  message: Message,
  users: ReadonlyMap<number, User>,
  me: User,
): string {
  const mine = message.userId === me.id;
  const author = users.get(message.userId)?.displayName ?? '';
  const t = STRINGS[me.lang];
  if (message.unsent) {
    return `<li class="msg unsent-note" data-static>${escapeHtml(mine ? t.youUnsent : t.unsent(author))}</li>`;
  }
  const image = message.image
    ? `<img class="bubble-image" src="${base}/images/${message.image.id}" width="${String(message.image.width)}" height="${String(message.image.height)}" alt="" loading="lazy">`
    : '';
  // Genmoji and stickers in their places in the text (each GLYPH is the next one).
  const parts = message.body.split(GLYPH);
  const sticker = message.glyphs.length > 0 && parts.every((part) => part.trim() === '');
  const text =
    message.body === '' || onlyCards(message)
      ? ''
      : `<span class="bubble-text">${parts
          .map((part, n) => {
            const glyph = message.glyphs[n - 1];
            return `${glyph ? `<img class="glyph" src="${base}/images/${glyph.id}" alt="" width="${String(glyph.width)}" height="${String(glyph.height)}">` : ''}${linkedHtml(part, message.links)}`;
          })
          .join('')}</span>`;
  const cards = cardsOf(message)
    .map((preview) => `\n  ${cardHtml(base, preview, me.lang)}`)
    .join('');
  return `<li class="msg ${mine ? 'msg-out' : 'msg-in'}" data-static>
  ${mine ? '' : `<span class="msg-author">${escapeHtml(author)}</span>`}
  ${image || text ? `<div class="bubble${sticker ? ' sticker' : ''}">${image}${text}</div>` : ''}${cards}${message.editedAt === null ? '' : `\n  <span class="edited-label">${t.edited}</span>`}
  <time class="msg-static-time" datetime="${new Date(message.createdAt).toISOString()}">${formatTime(message.createdAt)}</time>
</li>`;
}

/**
 * The conversation. The newest messages are in the HTML and the composer
 * is a real form, so it works with JavaScript off (the site's promise);
 * chat.js then replaces the list with a live one.
 */
export function renderChat(input: {
  assets: Assets;
  me: User;
  members: readonly User[];
  recent: readonly Message[];
  notice?: string | null;
}): string {
  const { assets, me, members, recent } = input;
  const t = STRINGS[me.lang];
  const users = new Map(members.map((user) => [user.id, user]));
  const boot = JSON.stringify({
    base: assets.base,
    me: { id: me.id, name: me.displayName, lang: me.lang, isAdmin: me.isAdmin },
  }).replace(/</g, '\\u003c');
  const others = members.filter((user) => user.id !== me.id && user.disabledAt === null);
  const avatars = others
    .slice(0, 3)
    .map(
      (user) =>
        `<span class="avatar" aria-hidden="true">${escapeHtml([...user.displayName][0] ?? '')}</span>`,
    )
    .join('');

  return `${head(assets.chat.name, assets, me.lang)}
<body class="family-chat">
<div class="app" data-app>
  <header class="bar">
    <a class="bar-side bar-home" href="/exposures/" aria-label="randyliang.net">
      <svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
    <div class="bar-title">
      <div class="avatars">${avatars}</div>
      <h1><span>${escapeHtml(assets.chat.name)}</span><svg class="bar-title-chevron" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true"><path d="m1 1 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></h1>
      <p class="bar-subtitle" data-subtitle hidden></p>
    </div>
    <details class="bar-side bar-menu">
      <summary aria-label="Menu">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      </summary>
      <div class="bar-menu-items">
        <button type="button" data-open-details hidden>${t.details}</button>
        <a href="${assets.base}/search">${t.search}</a>
        <a href="${assets.base}/password">${t.password}</a>
        ${me.isAdmin ? `<a href="${assets.base}/admin">${t.admin}</a>` : ''}
        <form method="POST" action="${assets.base}/logout"><button type="submit">${t.signOut}</button></form>
      </div>
    </details>
  </header>
  <main class="scroller" data-scroller tabindex="-1">
    <div class="history-sentinel" data-sentinel aria-hidden="true"></div>
    <ol class="messages" data-messages aria-live="polite" aria-relevant="additions">
${recent.length === 0 ? `<li class="empty" data-static>${t.empty}</li>` : recent.map((message) => renderStaticMessage(assets.base, message, users, me)).join('\n')}
    </ol>
    <noscript><p class="noscript">${t.noScript}</p></noscript>
  </main>
  <button class="jump" type="button" data-jump hidden></button>
  <form class="composer" method="POST" action="${assets.base}/send" data-composer>
    <div class="reply-bar" data-reply-bar hidden>
      <span class="reply-bar-text" data-reply-text></span>
      <button type="button" class="reply-cancel" data-reply-cancel aria-label="Cancel reply">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="composer-row">
      <label class="attach" data-attach hidden>
        <span class="visually-hidden">${t.attach}</span>
        <input type="file" accept="image/*" multiple data-file>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </label>
      <div class="field">
        <textarea name="body" rows="1" placeholder="${t.placeholder}" aria-label="${t.placeholder}" data-input
          autocapitalize="sentences" autocorrect="on" spellcheck="true"
          maxlength="4000" required></textarea>
        <input type="hidden" name="clientId" value="nojs-${String(Date.now())}-${String(Math.random()).slice(2, 10)}">
        <button class="send" type="submit" data-send aria-label="${t.send}">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 20V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  </form>
</div>
<div class="menu-layer" data-menu-layer hidden></div>
<script type="application/json" id="family-boot">${boot}</script>
${assets.modules.map((name) => `<link rel="modulepreload" href="${assets.url(name)}">`).join('\n')}
<script type="module" src="${assets.url('chat.js')}"></script>
</body>
</html>
`;
}

// ---- admin ---------------------------------------------------------------

function ago(at: number | null, now: number): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)} h ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

function device(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Linux/.test(userAgent)) return 'Linux';
  return userAgent === '' ? 'Unknown device' : 'Other';
}

const bytes = (n: number): string =>
  n < 1024 * 1024 ? `${String(Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const langSelect = (current: Lang): string =>
  `<select name="lang"><option value="en"${current === 'en' ? ' selected' : ''}>English</option><option value="zh"${current === 'zh' ? ' selected' : ''}>中文</option></select>`;

export function renderAdmin(input: {
  assets: Assets;
  me: User;
  users: readonly User[];
  sessions: ReadonlyMap<number, readonly SessionInfo[]>;
  connections: readonly Connection[];
  stats: { messages: number; deleted: number; images: number; imageBytes: number; dbBytes: number };
  events: readonly HubEvent[];
  startedAt: number;
  notice: string | null;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const { assets, me } = input;
  const names = new Map(input.users.map((user) => [user.id, user.displayName || user.username]));
  const people = input.users.filter((user) => !user.username.startsWith('deleted-'));

  const rows = people
    .map((user) => {
      const live = input.connections.filter((c) => c.userId === user.id);
      const sessions = input.sessions.get(user.id) ?? [];
      const self = user.id === me.id;
      const status =
        user.disabledAt !== null
          ? '<span class="pill pill-off">Disabled</span>'
          : live.length > 0
            ? '<span class="pill pill-on">Connected</span>'
            : '';
      const devices = sessions
        .map(
          (s) =>
            `<li>${escapeHtml(device(s.userAgent))} · signed in ${ago(s.createdAt, now)} · last used ${ago(s.lastUsedAt, now)}</li>`,
        )
        .join('');
      const streams = live
        .map(
          (c) =>
            `<li>Live since ${ago(c.openedAt, now)} · ${escapeHtml(device(c.userAgent))}${c.country ? ` · from ${escapeHtml(c.country)}` : ''} · delivered up to #${String(c.lastRev)}</li>`,
        )
        .join('');
      const id = String(user.id);
      return `<section class="group">
  <h2 class="group-title">${escapeHtml(user.displayName)} ${status}</h2>
  <div class="cell"><span>Username</span><span class="dim">${escapeHtml(user.username)}${user.isAdmin ? ' · admin' : ''}</span></div>
  <div class="cell"><span>Last seen</span><span class="dim">${ago(user.lastSeenAt, now)}</span></div>
  ${devices || streams ? `<div class="cell cell-block"><ul class="diag">${streams}${devices}</ul></div>` : ''}
  <form class="cell" method="POST" action="${assets.base}/admin/rename">
    <input type="hidden" name="id" value="${id}">
    <input name="displayName" autocapitalize="words" value="${escapeHtml(user.displayName)}" aria-label="Display name" maxlength="40" required>
    ${langSelect(user.lang)}
    <button type="submit">Save</button>
  </form>
  <form class="cell" method="POST" action="${assets.base}/admin/password">
    <input type="hidden" name="id" value="${id}">
    <input name="password" type="text" placeholder="New password" aria-label="New password" autocomplete="off" minlength="8" required>
    <button type="submit">Reset Password</button>
  </form>
  <div class="cell cell-actions">
    <form method="POST" action="${assets.base}/admin/revoke"><input type="hidden" name="id" value="${id}"><button type="submit">Sign Out Everywhere</button></form>
    ${
      self
        ? ''
        : user.disabledAt === null
          ? `<form method="POST" action="${assets.base}/admin/disable"><input type="hidden" name="id" value="${id}"><button type="submit">Disable</button></form>`
          : `<form method="POST" action="${assets.base}/admin/enable"><input type="hidden" name="id" value="${id}"><button type="submit">Enable</button></form>`
    }
  </div>
  ${
    self
      ? ''
      : `<form class="cell cell-danger" method="POST" action="${assets.base}/admin/delete">
    <input type="hidden" name="id" value="${id}">
    <input name="confirm" placeholder="Type ${escapeHtml(user.username)} to delete" aria-label="Type the username to confirm deletion" autocomplete="off" autocapitalize="none">
    <button type="submit">Delete Account & Messages</button>
  </form>`
  }
</section>`;
    })
    .join('\n');

  const events = input.events
    .slice(-40)
    .reverse()
    .map(
      (event) =>
        `<li><time>${ago(event.at, now)}</time> ${escapeHtml(event.kind)}${event.userId === null ? '' : ` · ${escapeHtml(names.get(event.userId) ?? '?')}`}${event.detail ? ` · ${escapeHtml(event.detail)}` : ''}</li>`,
    )
    .join('');

  return `${head(`${escapeHtml(assets.chat.name)} — Members`, assets, 'en')}
<body class="family-admin">
<main class="admin">
  <p><a class="back" href="${assets.base}/">‹ ${escapeHtml(assets.chat.name)}</a></p>
  <h1>Members</h1>
  ${input.notice === null ? '' : `<p class="notice" role="status">${escapeHtml(input.notice)}</p>`}
  <section class="group">
    <h2 class="group-title">Add Someone</h2>
    <form class="cell cell-stack" method="POST" action="${assets.base}/admin/create">
      <input name="displayName" autocapitalize="words" placeholder="Display name (e.g. 妈妈)" aria-label="Display name" maxlength="40" required>
      <input name="username" placeholder="Username (letters and digits, e.g. mom)" aria-label="Username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
      <input name="password" type="text" placeholder="Password (8+ characters)" aria-label="Password" autocomplete="off" minlength="8" required>
      ${langSelect('zh')}
      <button type="submit">Add</button>
    </form>
  </section>
${rows}
  <section class="group">
    <h2 class="group-title">Diagnostics</h2>
    <div class="cell"><span>Messages</span><span class="dim">${String(input.stats.messages)} (${String(input.stats.deleted)} deleted)</span></div>
    <div class="cell"><span>Photos</span><span class="dim">${String(input.stats.images)} · ${bytes(input.stats.imageBytes)}</span></div>
    <div class="cell"><span>Database</span><span class="dim">${bytes(input.stats.dbBytes)}</span></div>
    <div class="cell"><span>Live connections</span><span class="dim">${String(input.connections.length)}</span></div>
    <div class="cell"><span>Server up</span><span class="dim">since ${ago(input.startedAt, now)}</span></div>
    <div class="cell cell-block"><ul class="diag">${events || '<li>Nothing recorded since the server started.</li>'}</ul></div>
  </section>
  <p class="foot">Backups: <code>pnpm ${assets.chat.slug} backup</code> on the server (docs/family.md).</p>
</main>
</body>
</html>
`;
}
