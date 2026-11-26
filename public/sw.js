// Service worker: solo para los avisos en el móvil (no guarda la web sin conexión)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: e.data ? e.data.text() : 'Aviso' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Torneo', { body: d.body || '', tag: d.tag, renotify: true, icon: 'static/img/icon-192.png', badge: 'static/img/icon-192.png', data: { url: d.url || './' }, vibrate: [120, 60, 120] }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.includes(url) && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
