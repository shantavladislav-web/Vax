const CACHE = 'vax-v3';
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
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'NOTIFY') {
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

  // ── INCOMING CALL NOTIFICATION ──
  if (e.data.type === 'CALL_NOTIFY') {
    const { callerName, callerId } = e.data;
    self.registration.showNotification('📞 VAX — Вхідний дзвінок', {
      body: callerName + ' дзвонить...',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'vax-call',
      renotify: true,
      requireInteraction: true,
      vibrate: [500, 200, 500, 200, 500],
      actions: [
        { action: 'accept', title: '📞 Прийняти' },
        { action: 'reject', title: '📵 Відхилити' }
      ],
      data: { url: '/', callerId, callerName, type: 'call' }
    });
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const appClient = list.find(c => c.url.includes(self.location.origin));

      if (data.type === 'call') {
        const action = e.action; // 'accept' or 'reject'
        if (appClient) {
          appClient.focus();
          appClient.postMessage({ type: action === 'accept' ? 'CALL_ACCEPT' : 'CALL_REJECT', callerId: data.callerId });
        } else {
          clients.openWindow('/?call=' + (action === 'accept' ? 'accept' : 'reject') + '&from=' + data.callerId);
        }
      } else {
        if (appClient) return appClient.focus();
        if (clients.openWindow) return clients.openWindow('/');
      }
    })
  );
});
