import { escapeHtml } from '../pages.ts';
import type { Connection, HubEvent } from './hub.ts';
import type { Lang, Message, SessionInfo, User } from './store.ts';

export interface Assets {
  /** `/family/static/<name>?v=<hash>` for each static file. */
  readonly url: (name: string) => string;
}

/** The conversation's name, in the header and the home-screen title. */
export const GROUP_NAME = 'Family';

const STRINGS = {
  en: {
    placeholder: 'Message',
    send: 'Send',
    attach: 'Add a photo',
    signOut: 'Sign out',
    admin: 'Members',
    noScript: 'Without JavaScript, new messages appear when you reload the page.',
    empty: 'No messages yet. Say hello.',
  },
  zh: {
    placeholder: '信息',
    send: '发送',
    attach: '添加照片',
    signOut: '退出登录',
    admin: '成员',
    noScript: '未启用 JavaScript：刷新页面即可看到新消息。',
    empty: '还没有消息，打个招呼吧。',
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
<meta name="apple-mobile-web-app-title" content="${GROUP_NAME}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="format-detection" content="telephone=no">
<link rel="manifest" href="/family/manifest.webmanifest">
<link rel="apple-touch-icon" href="${assets.url('icon-180.png')}">
<link rel="icon" type="image/png" href="${assets.url('icon-180.png')}">
<link rel="stylesheet" href="${assets.url('family.css')}">
<title>${escapeHtml(title)}</title>
</head>`;
}

/** The sign-in screen. Bilingual, because it can't know yet who is signing in. */
export function renderLogin(assets: Assets, error: string | null, username = ''): string {
  return `${head(GROUP_NAME, assets, 'en')}
<body class="family-auth">
<main class="auth">
  <img class="auth-icon" src="${assets.url('icon-180.png')}" alt="" width="72" height="72">
  <h1 class="auth-title">${GROUP_NAME}</h1>
  <form class="auth-form" method="POST" action="/family/login">
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

function formatTime(at: number): string {
  // Server-rendered times are a fallback for a page without JavaScript;
  // the script replaces them with the viewer's own time zone.
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function renderStaticMessage(message: Message, users: ReadonlyMap<number, User>, me: User): string {
  const mine = message.userId === me.id;
  const author = users.get(message.userId)?.displayName ?? '';
  const image = message.image
    ? `<img class="bubble-image" src="/family/images/${message.image.id}" width="${String(message.image.width)}" height="${String(message.image.height)}" alt="" loading="lazy">`
    : '';
  const text =
    message.body === '' ? '' : `<span class="bubble-text">${escapeHtml(message.body)}</span>`;
  return `<li class="msg ${mine ? 'msg-out' : 'msg-in'}" data-static>
  ${mine ? '' : `<span class="msg-author">${escapeHtml(author)}</span>`}
  <div class="bubble">${image}${text}</div>
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
    me: { id: me.id, name: me.displayName, lang: me.lang, isAdmin: me.isAdmin },
  }).replace(/</g, '\\u003c');
  const others = members.filter((user) => user.id !== me.id && user.disabledAt === null);
  const subtitle = others.map((user) => user.displayName).join(', ');
  const avatars = others
    .slice(0, 3)
    .map(
      (user) =>
        `<span class="avatar" aria-hidden="true">${escapeHtml([...user.displayName][0] ?? '')}</span>`,
    )
    .join('');

  return `${head(GROUP_NAME, assets, me.lang)}
<body class="family-chat">
<div class="app" data-app>
  <header class="bar">
    <a class="bar-side bar-home" href="/exposures/" aria-label="randyliang.net">
      <svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>
    <div class="bar-title">
      <div class="avatars">${avatars}</div>
      <h1>${GROUP_NAME}</h1>
      <p class="bar-subtitle" data-subtitle>${escapeHtml(subtitle)}</p>
    </div>
    <details class="bar-side bar-menu">
      <summary aria-label="Menu">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      </summary>
      <div class="bar-menu-items">
        ${me.isAdmin ? `<a href="/family/admin">${t.admin}</a>` : ''}
        <form method="POST" action="/family/logout"><button type="submit">${t.signOut}</button></form>
      </div>
    </details>
  </header>
  <main class="scroller" data-scroller tabindex="-1">
    <div class="history-sentinel" data-sentinel aria-hidden="true"></div>
    <ol class="messages" data-messages aria-live="polite" aria-relevant="additions">
${recent.length === 0 ? `<li class="empty" data-static>${t.empty}</li>` : recent.map((message) => renderStaticMessage(message, users, me)).join('\n')}
    </ol>
    <noscript><p class="noscript">${t.noScript}</p></noscript>
  </main>
  <button class="jump" type="button" data-jump hidden></button>
  <form class="composer" method="POST" action="/family/send" data-composer>
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
          autocomplete="off" maxlength="4000" required></textarea>
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
  <form class="cell" method="POST" action="/family/admin/rename">
    <input type="hidden" name="id" value="${id}">
    <input name="displayName" value="${escapeHtml(user.displayName)}" aria-label="Display name" maxlength="40" required>
    ${langSelect(user.lang)}
    <button type="submit">Save</button>
  </form>
  <form class="cell" method="POST" action="/family/admin/password">
    <input type="hidden" name="id" value="${id}">
    <input name="password" type="text" placeholder="New password" aria-label="New password" autocomplete="off" minlength="8" required>
    <button type="submit">Reset password</button>
  </form>
  <div class="cell cell-actions">
    <form method="POST" action="/family/admin/revoke"><input type="hidden" name="id" value="${id}"><button type="submit">Sign out everywhere</button></form>
    ${
      self
        ? ''
        : user.disabledAt === null
          ? `<form method="POST" action="/family/admin/disable"><input type="hidden" name="id" value="${id}"><button type="submit">Disable</button></form>`
          : `<form method="POST" action="/family/admin/enable"><input type="hidden" name="id" value="${id}"><button type="submit">Enable</button></form>`
    }
  </div>
  ${
    self
      ? ''
      : `<form class="cell cell-danger" method="POST" action="/family/admin/delete">
    <input type="hidden" name="id" value="${id}">
    <input name="confirm" placeholder="Type ${escapeHtml(user.username)} to delete" aria-label="Type the username to confirm deletion" autocomplete="off" autocapitalize="none">
    <button type="submit">Delete account and messages</button>
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

  return `${head(`${GROUP_NAME} — Members`, assets, 'en')}
<body class="family-admin">
<main class="admin">
  <p><a class="back" href="/family/">‹ ${GROUP_NAME}</a></p>
  <h1>Members</h1>
  ${input.notice === null ? '' : `<p class="notice" role="status">${escapeHtml(input.notice)}</p>`}
  <section class="group">
    <h2 class="group-title">Add someone</h2>
    <form class="cell cell-stack" method="POST" action="/family/admin/create">
      <input name="displayName" placeholder="Display name (e.g. 妈妈)" aria-label="Display name" maxlength="40" required>
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
  <p class="foot">Backups: <code>pnpm family backup</code> on the server (docs/family.md).</p>
</main>
</body>
</html>
`;
}
