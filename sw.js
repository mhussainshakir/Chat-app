const CACHE_NAME = 'chatkaro-v3';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_FILES).catch(function() {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) {
        return k !== CACHE_NAME;
      }).map(function(k) {
        return caches.delete(k);
      }));
    })
  );
  self.clients.claim();
});

// Handle sync events for offline message queue
self.addEventListener('sync', function(event) {
  if (event.tag === 'sync-messages') {
    event.waitUntil(
      self.clients.matchAll().then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({type: 'SYNC_MESSAGES'});
        });
      })
    );
  }
});

// Only touch same-origin GET requests for our own app-shell files.
// Everything else (Firebase, Firestore streaming, Cloudinary uploads, Google Fonts)
// is left completely alone and goes straight to the network.
self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  var isShellFile = SHELL_FILES.some(function(f) {
    var clean = f.replace('./', '');
    return clean === '' ? url.pathname === '/' || url.pathname.endsWith('/index.html')
                         : url.pathname.endsWith('/' + clean);
  });
  if (!isShellFile) return;

  event.respondWith(
    fetch(req)
      .then(function(res) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(req, clone);
        });
        return res;
      })
      .catch(function() {
        return caches.match(req);
      })
  );
});
