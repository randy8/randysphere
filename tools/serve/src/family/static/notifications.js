// Notifications: the service worker, this device's push subscription, and
// the settings for it. Permission is only ever asked for from a tap on
// "Turn On Notifications" — never on page load.

import { action, group, toggle } from './sheet.js';

const STRINGS = {
  en: {
    heading: 'Notifications',
    turnOn: 'Turn On Notifications',
    turnOff: 'Turn Off on This Device',
    on: 'On for this device',
    preview: 'Show Name and Message',
    previewNote:
      'Off, a notification says only “New message”. On, it shows who wrote and the first line — on the lock screen too.',
    test: 'Send a Test Notification',
    testSent: 'Sent. It should arrive in a few seconds.',
    testFailed: 'It didn’t go through. Try turning notifications off and on again.',
    blocked:
      'Notifications are blocked for this site in the browser’s settings. Allow them there, then come back.',
    unsupported: 'This browser can’t show notifications from a website.',
    iosHint:
      'On iPhone and iPad, notifications work once Family is on your Home Screen: tap Share, then “Add to Home Screen”, and open Family from there.',
    failed: 'Couldn’t turn notifications on. Check your connection and try again.',
    working: 'One moment…',
  },
  zh: {
    heading: '通知',
    turnOn: '开启通知',
    turnOff: '在此设备上关闭',
    on: '此设备已开启',
    preview: '显示发送人和内容',
    previewNote: '关闭时，通知只显示“新消息”。开启后会显示是谁发的和第一行内容——锁屏上也会显示。',
    test: '发送测试通知',
    testSent: '已发送，几秒钟内会收到。',
    testFailed: '没有发送成功。请关闭通知后再重新开启。',
    blocked: '浏览器设置中已禁止此网站的通知。请在设置中允许后再回来。',
    unsupported: '此浏览器无法显示网站通知。',
    iosHint:
      '在 iPhone 和 iPad 上，需要先把“家人”添加到主屏幕：轻点“分享”，再选“添加到主屏幕”，然后从主屏幕打开。',
    failed: '无法开启通知。请检查网络后重试。',
    working: '请稍候…',
  },
};

const isIos =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone =
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const pushSupported =
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function sameKey(buffer, base64url) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = keyBytes(base64url);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// This chat's path, /family or /disc: the page is always at <base>/.
const BASE = `/${location.pathname.split('/')[1]}`;

let registration = null;

/** Registers the worker (notifications only; it caches nothing). Safe to call on every load. */
export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
    return registration;
  } catch {
    return null;
  }
}

async function ready() {
  return registration ?? (await registerWorker());
}

/**
 * Keeps the server's record in step with the browser's. A device stays
 * subscribed across a new sign-in (whose session the old record was tied
 * to), a server key change, or a browser that quietly renewed its
 * subscription — without asking anything, since permission was given.
 */
export async function syncSubscription(api) {
  if (!pushSupported || Notification.permission !== 'granted') return;
  const reg = await ready();
  if (!reg) return;
  const [server, subscription] = await Promise.all([
    api(`${BASE}/api/push`).then((r) => (r.ok ? r.json() : null)),
    reg.pushManager.getSubscription(),
  ]);
  if (!server || !subscription) return;
  if (!sameKey(subscription.options?.applicationServerKey, server.publicKey)) {
    await subscription.unsubscribe().catch(() => {});
    await subscribe(api, server.publicKey, server.preview);
    return;
  }
  if (!server.subscribed || server.endpoint !== subscription.endpoint) {
    await api(`${BASE}/api/push`, {
      method: 'POST',
      json: { ...subscription.toJSON(), preview: server.preview },
    });
  }
}

async function subscribe(api, publicKey, preview) {
  const reg = await ready();
  if (!reg) throw new Error('no worker');
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  const response = await api(`${BASE}/api/push`, {
    method: 'POST',
    json: { ...subscription.toJSON(), preview },
  });
  if (!response.ok) throw new Error(String(response.status));
}

/** Fills the Notifications group of the details sheet; redraws itself as things change. */
export function notificationSettings(parent, { api, lang }) {
  const t = STRINGS[lang] ?? STRINGS.en;
  const holder = document.createElement('div');
  parent.append(holder);

  const draw = async (message) => {
    holder.replaceChildren();
    if (!pushSupported) {
      group(holder, t.heading, isIos && !standalone ? t.iosHint : t.unsupported);
      return;
    }
    if (Notification.permission === 'denied') {
      group(holder, t.heading, t.blocked);
      return;
    }
    let server = null;
    try {
      server = await (await api(`${BASE}/api/push`)).json();
    } catch {
      server = null;
    }
    const reg = await ready();
    let subscription = null;
    try {
      subscription = (await reg?.pushManager.getSubscription()) ?? null;
    } catch {
      // No push service reachable from this browser (none in a test
      // browser; none on an Android phone in China without Google's).
      subscription = null;
    }
    const on = Boolean(server?.subscribed && subscription && Notification.permission === 'granted');

    if (!on) {
      const { rows } = group(holder, t.heading, message);
      action(rows, t.turnOn, async (button) => {
        button.disabled = true;
        button.textContent = t.working;
        try {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') return draw();
          await subscribe(api, server.publicKey, false);
          await draw();
        } catch {
          await draw(t.failed);
        }
      });
      return;
    }

    const { rows } = group(holder, t.heading, message ?? t.previewNote);
    toggle(rows, t.preview, server.preview, async (checked, input) => {
      input.disabled = true;
      await api(`${BASE}/api/push`, {
        method: 'POST',
        json: { ...subscription.toJSON(), preview: checked },
      }).catch(() => {});
      input.disabled = false;
    });
    action(rows, t.test, async (button) => {
      button.disabled = true;
      const response = await api(`${BASE}/api/push/test`, { method: 'POST' }).catch(() => null);
      await draw(response?.ok ? t.testSent : t.testFailed);
    });
    action(
      rows,
      t.turnOff,
      async (button) => {
        button.disabled = true;
        await api(`${BASE}/api/push/remove`, {
          method: 'POST',
          json: { endpoint: subscription.endpoint },
        }).catch(() => {});
        await subscription.unsubscribe().catch(() => {});
        await draw();
      },
      { danger: true },
    );
  };

  draw().catch(() => {
    holder.replaceChildren();
    group(holder, t.heading, t.failed);
  });
}
