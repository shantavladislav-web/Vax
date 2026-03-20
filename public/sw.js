const CACHE = 'vax-v2';
const ASSETS = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// ── NOTIFICATIONS FROM MAIN PAGE ──────────────────────
// The main page sends messages to SW to show notifications
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'NOTIFY') {
    const { title, body, tag } = e.data;
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: tag || 'vax',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: '/' }
    });
  }
});

// ── CLICK ON NOTIFICATION → OPEN APP ──────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app is open — focus it
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
