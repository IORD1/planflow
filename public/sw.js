'use strict';
// The service worker that makes Planflow installable (manifest.webmanifest, index.html) and
// keeps the shell on the phone. The API (boards, tasks, cover images) is never cached: live
// data. Everything else on this origin is network first, so a deploy shows on the next
// load, with the cached copy as the fallback when the server is away.
const CACHE = 'planflow-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const NEVER = (url) => url.pathname.startsWith('/api');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER(url)) return;
  const key = url.pathname === '/' ? '/index.html' : url.pathname;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});
