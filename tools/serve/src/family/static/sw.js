// A chat's service worker (the family's or Disc's): notifications, and nothing else.
//
// Deliberately no `fetch` handler: nothing the chat shows — pages, messages,
// photos — is ever cached by it, so signing out or deleting a message leaves
// no copy behind here, and a deploy never serves a stale page. Served at
// <base>/sw.js (routes.ts), which scopes it to that chat alone.

// /family/ or /disc/: the chat this worker belongs to, and the only one it opens.
const SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener('install', () => {
  // A new version takes over at once; it holds no state worth handing over.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      // Every push shows a notification: Safari withdraws the permission
      // from a site whose pushes show nothing. Whether one is wanted at all
      // (the conversation already on screen) is decided by the server.
      await self.registration.showNotification(data.title || '', {
        body: data.body || '',
        tag: data.tag || SCOPE,
        renotify: true,
        icon: `${SCOPE}static/icon-192.png`,
        badge: `${SCOPE}static/badge-96.png`,
        data: { messageId: data.messageId || 0 },
      });
      if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
        await (
          data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()
        ).catch(() => {});
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data?.messageId || 0;
  const target = id > 0 ? `${SCOPE}#m${id}` : SCOPE;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).pathname.startsWith(SCOPE));
      if (open) {
        // The page that's already open goes to the message itself.
        open.postMessage({ type: 'open-message', id });
        await open.focus();
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
