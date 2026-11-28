const V = 'v12';
const SHELL = ['./', 'index.html', 'app.js?v=2.4', 'scan.js?v=2.4', 'backup.js?v=2.4', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open('shell-' + V).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('shell-') && k !== 'shell-' + V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.hostname === 'cdn.rebrickable.com' || (u.hostname.endsWith('rebrickable.com') && u.pathname.startsWith('/media/'))) {
    e.respondWith(caches.open('img').then(async c => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try { const r = await fetch(req.url, { mode: 'no-cors' }); c.put(req.url, r.clone()); return r; }
      catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (u.origin === self.location.origin) {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const cl = r.clone(); caches.open('shell-' + V).then(c => c.put(req, cl)); }
      return r;
    }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || caches.match('index.html')));
  }
});
