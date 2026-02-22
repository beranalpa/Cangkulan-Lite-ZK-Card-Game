/// <reference lib="webworker" />
// @ts-nocheck

// ═══════════════════════════════════════════════════════════════════════════════
//  Service Worker — Cangkulan PWA
//  Caches app shell for offline access, game history stays accessible offline.
//  Uses stale-while-revalidate for API calls. Network-first for RPC.
// ═══════════════════════════════════════════════════════════════════════════════

const SW_VERSION = '1.0.0';
const CACHE_NAME = `cangkulan-v${SW_VERSION}`;

// App shell files to precache
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/cangkulan-logo.png',
];

// Install: precache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET, non-http(s), and cross-origin RPC calls (Soroban)
  if (event.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;
  if (url.hostname.includes('soroban') || url.hostname.includes('stellar')) return;

  // For navigation requests, try network first then cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html').then((r) => r || new Response('Offline', { status: 503 })),
      ),
    );
    return;
  }

  // For static assets: cache-first with network fallback
  if (
    url.pathname.match(/\.(js|css|png|jpg|svg|woff2?|ico)$/) ||
    url.pathname.startsWith('/assets/')
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          // Cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      }),
    );
    return;
  }
});
