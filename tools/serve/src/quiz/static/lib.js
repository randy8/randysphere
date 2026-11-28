// Shared by every quiz page: the socket, credentials, the theme and its
// words, and a small DOM helper. Plain browser JavaScript, no build step.
// Everything a user or an author wrote is put on the page as text
// (textContent), never as HTML.

/** Builds an element: el('div', { class: 'x', onclick }, child, 'text', …). */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);

/** replaceChildren, skipping null/undefined/false (the DOM's own would insert the text "null"). */
export function put(node, ...children) {
  node.replaceChildren(
    ...children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  );
  return node;
}

export const page = () => document.body.dataset;

/** A random id for a message (idempotency). getRandomValues works on plain-HTTP LAN pages too. */
export function messageId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Credentials: arrive in the URL fragment (never sent to the server), are
// kept in this browser for reconnecting, and leave the address bar at once.

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode: the fragment link still works for this tab.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing stored.
    }
  },
};
export { storage };

export function takeToken(code, role) {
  const key = `quiz:${code}:${role}`;
  const fragment = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{20,100}$/.test(fragment)) {
    storage.set(key, fragment);
    history.replaceState(null, '', location.pathname + location.search);
    return fragment;
  }
  return storage.get(key);
}

export function forgetToken(code, role) {
  storage.remove(`quiz:${code}:${role}`);
}

// ---------------------------------------------------------------------------
// The theme: its stylesheet and its words. Mechanics never depend on it.

const DEFAULT_TERMS = {
  game: 'Quiz',
  rounds: ['First Round', 'Second Round', 'Third Round'],
  final: 'Final Round',
  wager: 'Wager',
  wagerClue: 'Wager Clue',
  tiebreak: 'Sudden Death',
  currency: '$',
  host: 'Host',
  player: 'Contestant',
  roundEnd: 'End of the round',
  winner: 'Winner',
  noWinner: 'No winner today',
  questionForm: 'Phrase it as a question',
  boardControl: 'Your selection',
  buzz: 'Buzz',
};

export let terms = { ...DEFAULT_TERMS };
export let theme = { name: 'classic', audio: {}, narration: { rate: 1 } };

export async function loadTheme(name = 'classic') {
  const safe = /^[a-z0-9-]{1,40}$/.test(name) ? name : 'classic';
  const link = document.getElementById('theme-css');
  if (link && !link.getAttribute('href').includes(`/themes/${safe}/`))
    link.setAttribute('href', `/quiz/themes/${safe}/theme.css`);
  try {
    const response = await fetch(`/quiz/themes/${safe}/theme.json`);
    if (response.ok) {
      const loaded = await response.json();
      theme = { ...theme, ...loaded, name: safe };
      terms = { ...DEFAULT_TERMS, ...(loaded.terms ?? {}) };
    }
  } catch {
    // The defaults stand.
  }
  return theme;
}

export function money(amount) {
  const sign = amount < 0 ? '-' : '';
  return `${sign}${terms.currency}${Math.abs(amount).toLocaleString('en-US')}`;
}

export const roundName = (index, rounds) =>
  rounds?.[index]?.kind === 'final' ? terms.final : (terms.rounds[index] ?? `Round ${index + 1}`);

// ---------------------------------------------------------------------------
// The socket. Reconnects with backoff, answers pings, resends recent
// unacknowledged messages under the same id (the server applies each id
// once), and turns server-relative countdowns into local deadlines.

export function connect({ code, token, onWelcome, onState, onMessage, onStatus }) {
  let socket = null;
  let attempt = 0;
  let closedForGood = false;
  const pending = new Map();
  let lastStateAt = 0;

  const status = (value, detail) => onStatus?.(value, detail);

  function open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/quiz/ws`);
    status('connecting');
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', code, token }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', n: message.n }));
        return;
      }
      if (message.type === 'welcome') {
        attempt = 0;
        status('online');
        onWelcome?.(message);
        // Anything sent in the last few seconds that never got an answer goes again, same id.
        const now = performance.now();
        for (const [id, entry] of pending) {
          if (now - entry.at < 4000) socket.send(entry.payload);
          else {
            entry.resolve({ ok: false, error: 'connection lost' });
            pending.delete(id);
          }
        }
        return;
      }
      if (message.type === 'state') {
        lastStateAt = performance.now();
        const view = message.view;
        view.receivedAt = lastStateAt;
        onState?.(view, message);
        return;
      }
      if ((message.type === 'ack' || message.type === 'link') && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        entry.resolve(message);
      }
      onMessage?.(message);
    });
    socket.addEventListener('close', (event) => {
      if ([4003, 4004].includes(event.code)) {
        closedForGood = true;
        status(event.code === 4003 ? 'refused' : 'gone', event.reason);
        return;
      }
      if (closedForGood) return;
      status('offline');
      attempt += 1;
      const delay = Math.min(5000, 250 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() * 0.5);
      setTimeout(open, delay);
    });
  }

  function send(message) {
    const id = message.id ?? messageId();
    const payload = JSON.stringify({ ...message, id });
    return new Promise((resolve) => {
      pending.set(id, { payload, resolve, at: performance.now() });
      if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, error: 'no answer' });
        }
      }, 8000);
    });
  }

  open();
  document.addEventListener('visibilitychange', () => {
    // A phone that slept may hold a dead socket for a while; check on wake.
    if (
      document.visibilityState === 'visible' &&
      socket?.readyState !== WebSocket.OPEN &&
      !closedForGood
    ) {
      socket?.close();
    }
  });

  return {
    act: (action, expect = null) => send({ type: 'act', action, expect }),
    send,
    /** Fire-and-forget, no id (buzzes carry their own seq and are not resent). */
    raw: (message) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        return true;
      }
      return false;
    },
    get open() {
      return socket?.readyState === WebSocket.OPEN;
    },
    get lastStateAt() {
      return lastStateAt;
    },
  };
}

/** Milliseconds left on a view's countdown, by this device's clock. */
export function remaining(view, field = 'remainingMs') {
  const value = view?.[field];
  if (value === null || value === undefined) return null;
  if (view.paused) return value;
  return Math.max(0, value - (performance.now() - (view.receivedAt ?? performance.now())));
}

// ---------------------------------------------------------------------------
// The screen stays on while a game is played (where the browser allows).

export function keepAwake() {
  let lock = null;
  async function request() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible')
        lock = await navigator.wakeLock.request('screen');
    } catch {
      lock = null;
    }
  }
  request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!lock || lock.released)) request();
  });
}

export function statusText(status) {
  return (
    {
      connecting: 'Connecting…',
      online: 'Connected',
      offline: 'Reconnecting…',
      refused: 'This link is no longer valid.',
      gone: 'This game has ended or no longer exists.',
    }[status] ?? status
  );
}

/** The full name lookup for a view. */
export function nameOf(view, id) {
  return view?.players?.find((player) => player.id === id)?.name ?? '';
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) throw new Error(json?.error ?? `HTTP ${response.status}`);
  return json;
}
