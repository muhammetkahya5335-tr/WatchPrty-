/* ============================================================
   birlikte — Service Worker v3
   Her güncelleme için CACHE_VERSION'ı artır.
   Uygulama dosyaları (app.js, index.html vs.) NETWORK-FIRST:
   önce ağdan çek, ağ yoksa cache'ten sun.
   Bu sayede yeni kod deploy edilince tüm cihazlar anında güncellenir.
   ============================================================ */

const CACHE_VERSION = 3;
const CACHE_NAME    = `birlikte-v${CACHE_VERSION}`;

/* Kurulumda sadece font/ikon gibi statik şeyleri cache'le,
   uygulama dosyalarını değil — onlar her zaman ağdan gelecek */
self.addEventListener('install', (event) => {
  self.skipWaiting(); // hemen aktifleş, eski SW'yi bekletme
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* Aktifleşince eski tüm cache'leri temizle */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* NETWORK-FIRST: uygulama dosyaları daima tazeden yüklenir */
const APP_FILES = ['/app.js', '/index.html', '/style.css', '/firebase-config.js', '/'];

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isAppFile = APP_FILES.some((f) => url.pathname === f || url.pathname.endsWith(f));

  if (isAppFile) {
    /* Uygulama dosyaları: NETWORK-FIRST, offline fallback */
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((res) => {
          /* Başarılıysa cache'e yaz (offline fallback için) */
          caches.open(CACHE_NAME)
            .then((c) => c.put(event.request, res.clone()))
            .catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    /* Diğer kaynaklar (resimler, fontlar): CACHE-FIRST */
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          caches.open(CACHE_NAME)
            .then((c) => c.put(event.request, res.clone()))
            .catch(() => {});
          return res;
        });
      })
    );
  }
});

/* ── Push bildirimleri (FCM kuruluysa tetiklenir) ── */
self.addEventListener('push', (event) => {
  let data = { title: 'birlikte', body: 'Yeni bir mesaj var' };
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'birlikte', {
      body:      data.body  || '',
      icon:      '/favicon.ico',
      badge:     '/favicon.ico',
      tag:       'birlikte-chat',
      renotify:  true,
    })
  );
});

/* Bildirime tıklanınca sekmeyi öne getir */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const alive = clients.find((c) => c.url && 'focus' in c);
        if (alive) return alive.focus();
        return self.clients.openWindow('/');
      })
  );
});
