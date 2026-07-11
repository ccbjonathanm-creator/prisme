/* Prisme — service worker.
   Le code de l'app est en réseau-d'abord (pour recevoir les MAJ), le reste (icônes,
   moteur OCR, données de langue) en cache-d'abord pour marcher hors-ligne.
   Les appels IA (Gemini/Groq) sont des POST : le SW ne les touche jamais. */
const CACHE = 'prisme-v1';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(()=>self.skipWaiting()));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return; // les appels IA (POST) filent au réseau
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // rien à faire des domaines externes

  const isCore = e.request.mode === 'navigate'
    || /\.(html|js|css|webmanifest)$/.test(url.pathname);

  if (isCore) {
    // Réseau d'abord (no-store) pour recevoir les mises à jour, cache en secours hors-ligne.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
  } else {
    // Cache d'abord (icônes, moteur OCR, langues) : figé, chargé une fois puis hors-ligne.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }))
    );
  }
});
