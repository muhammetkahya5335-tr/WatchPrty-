/* ============================================================
   birlikte — Service Worker
   Sekme kapalıyken bile bildirim almak için bu dosya projenin
   kök dizininde (index.html ile aynı yerde) bulunmalıdır.
   HTTPS ortamında otomatik olarak kaydedilir.
   ============================================================ */

const CACHE_NAME = 'birlikte-v1';

/* Kurulum: temel dosyaları önbelleğe al (çevrimdışı destek) */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(['/', '/index.html', '/style.css', '/app.js', '/firebase-config.js'])
           .catch(() => {}) // dosya yoksa sessizce geç
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* Fetch: önce ağ, başarısız olursa önbellek */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

/* Push bildirimi — FCM entegrasyonu yapıldıysa burası tetiklenir */
self.addEventListener('push', (event) => {
  let data = { title: 'birlikte', body: 'Yeni bir mesaj var' };
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'birlikte', {
      body: data.body || '',
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'birlikte-chat',
      renotify: true,
    })
  );
});

/* Bildirime tıklanınca sekmeyi öne getir */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (clients.length > 0) { clients[0].focus(); return; }
      self.clients.openWindow('/');
    })
  );
});
