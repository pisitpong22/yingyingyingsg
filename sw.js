// ════════════════════════════════════════════════════════════════════════════
//  sw.js — Service Worker for image caching
//
//  Strategy: stale-while-revalidate for Firebase Storage images.
//    1. Request a Firebase Storage image
//    2. SW checks cache → if found, serve immediately (0ms!)
//    3. In the background, SW also fetches a fresh copy + updates cache
//    4. Next visit gets the fresh copy
//
//  This makes repeat visits feel INSTANT even though the underlying images
//  are stored in a US region. Cache survives across tabs and reloads.
//
//  Cache size: limited to 80 entries (LRU-style trim) to avoid bloating
//  the browser storage on devices with many images.
// ════════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'yyy-images-v1';
const MAX_ENTRIES = 80;

// On install: skip waiting so the new SW takes over immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// On activate: clean up old cache versions + claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('yyy-images-') && n !== CACHE_NAME)
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// On fetch: only intercept image requests to Firebase Storage
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle Firebase Storage URLs
  const isFirebaseImage = (
    url.hostname === 'firebasestorage.googleapis.com' &&
    event.request.method === 'GET'
  );
  if(!isFirebaseImage) return;

  event.respondWith(handleImageRequest(event.request));
});

async function handleImageRequest(request){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Background revalidation — fetch fresh copy and update cache
  const networkFetch = fetch(request).then(response => {
    if(response && response.ok){
      // Clone before caching (response body can only be read once)
      cache.put(request, response.clone()).then(() => trimCache(cache));
    }
    return response;
  }).catch(() => null);  // Network failed — that's OK if we have cache

  // Return cached version immediately if available, else wait for network
  return cached || networkFetch;
}

// Limit cache size to avoid using too much disk on the user's device.
async function trimCache(cache){
  const keys = await cache.keys();
  if(keys.length <= MAX_ENTRIES) return;
  // Remove oldest entries (FIFO — keys() returns insertion order)
  const toDelete = keys.length - MAX_ENTRIES;
  for(let i = 0; i < toDelete; i++){
    await cache.delete(keys[i]);
  }
}
