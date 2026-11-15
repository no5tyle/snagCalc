// Keeps Snag Calc working with poor or no signal. Every file the page asks
// for is fetched from the network first, so a new version or new prices show
// up straight away; a copy is saved, and used when the network doesn't answer
// in time. That covers the shared stylesheet and app switcher from
// no5tyle.github.io/shared too.

const CACHE = 'snagcalc-v1';
const SHELL = ['./', 'index.html', 'assets/app.js', 'assets/calc.js', 'assets/sheet.js', 'assets/share.js', 'assets/styles.css', 'data/catalogue.json', 'manifest.webmanifest'];
// How long to wait for the network before using the saved copy
const TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {
        /* saved as they're fetched instead */
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function fromNetwork(request) {
  const response = await fetch(request);
  // Opaque responses (the shared stylesheet, loaded without CORS) can't be checked, but are worth keeping
  if (response.ok || response.type === 'opaque') {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith('http')) return;
  event.respondWith(
    (async () => {
      const saved = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
      const network = fromNetwork(request);
      if (!saved) return network;
      network.catch(() => {}); // still saves the fresh copy if it arrives late
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
      return (await Promise.race([network.catch(() => null), timeout])) || saved;
    })()
  );
});
