// Service Worker for D25 Teknologi Pendidikan PWA
const CACHE_NAME = 'd25-tdp-cache-v5';
const urlsToCache = [
    '/',
    '/css/style.css?v=7',
    '/js/main.js',
    '/manifest.json',
    '/images/icon-192.png',
    '/images/icon-512.png',
    '/images/placeholder-product.svg',
    '/images/product-pdh.svg',
    '/images/product-robotik.svg',
    '/images/product-multimedia.svg',
    '/images/product-matematika.svg',
    '/images/product-pemrograman.svg',
    '/images/product-tkj.svg',
    '/images/product-bundle.svg'
];

// Install: cache assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
    );
    self.skipWaiting();
});

// Activate: bersihkan cache lama & segera ambil-alih kontrol halaman
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => Promise.all(
            cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
        )).then(() => self.clients.claim())
    );
});

// Fetch:
// - Navigasi (halaman): network-first dengan fallback cache (hindari halaman basi/duplikat)
// - Aset statis: cache-first
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Hanya tangani GET & asal yang sama (hindari cross-origin/cache API)
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    // Navigasi dokumen -> network-first
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                    return response;
                })
                .catch(() => caches.match(request).then(cached => cached || caches.match('/')))
        );
        return;
    }

    // Aset statis -> cache-first, lalu isi cache saat pertama kali
    event.respondWith(
        caches.match(request).then(cached => {
            if (cached) return cached;
            return fetch(request).then(response => {
                if (response && response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                }
                return response;
            });
        })
    );
});
