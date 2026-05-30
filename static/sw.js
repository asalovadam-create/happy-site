/**
 * Happy Toys — Service Worker v3
 * Стратегия: Cache First для статики, Network First для API
 */

const CACHE_NAME   = 'happytoys-v3';
const STATIC_CACHE = 'happytoys-static-v3';
const API_CACHE    = 'happytoys-api-v1';

// Файлы для предварительного кэширования (app shell)
const PRECACHE = [
  '/',
  '/static/style.css',
  '/static/app.js',
  '/static/manifest.json',
  '/static/icon.png',
  '/static/icon-192.png',
  '/static/icon-512.png',
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('[SW] Pre-caching app shell');
        return cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'no-cache' })));
      })
      .then(() => self.skipWaiting())
      .catch(err => console.log('[SW] Pre-cache error (non-fatal):', err))
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== API_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // ── API: Network First, fall back to cache ──────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  // ── JS/CSS: Network First (always fresh) ───────────────────────────────
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // ── Static files (icons, images): Cache First ──────────────────────────
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // ── HTML pages: Network First, fall back to cached index ───────────────
  event.respondWith(networkFirstHTML(request));
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function networkFirstAPI(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Offline', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function networkFirstHTML(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return cached index.html for any navigation (SPA fallback)
    const cached = await caches.match('/') || await caches.match(request);
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><html><body><h2>Нет подключения к интернету</h2><p>Проверьте соединение и обновите страницу</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// ── Push notifications (для будущего использования) ───────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Happy Toys', {
      body: data.body || '',
      icon: '/static/icon-192.png',
      badge: '/static/icon-32.png',
      tag: 'happytoys-notif',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
