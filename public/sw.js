// Service Worker for D25 Teknologi Pendidikan PWA
const CACHE_NAME = 'd25-tdp-cache-v2';
const urlsToCache = [
    '/',
    '/css/style.css',
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

// Install service worker and cache assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

// Activate service worker and clean up old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(cacheName => {
                    return cacheName !== CACHE_NAME;
                }).map(cacheName => {
                    return caches.delete(cacheName);
                })
            );
        })
    );
});

// Fetch assets from cache or network
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Return cached response if found, otherwise fetch from network
                return response || fetch(event.request);
            }
            )
    );
});