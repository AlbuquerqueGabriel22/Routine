const CACHE_NAME = "routiner-cache-v3";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/routiner.svg",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache API calls in service worker cache (handled by IndexedDB offline layer)
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Navigation requests (HTML page): Network first, fallback to cached index.html
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put("/", networkResponse.clone());
            cache.put("/index.html", networkResponse.clone());
          }
          return networkResponse;
        } catch (error) {
          const cached = (await caches.match("/")) || (await caches.match("/index.html"));
          if (cached) return cached;
          throw error;
        }
      })(),
    );
    return;
  }

  // Static Assets (JS, CSS, SVGs, Fonts)
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname === "/routiner.svg" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".svg")
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;

        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (error) {
          if (cached) return cached;
          throw error;
        }
      })(),
    );
    return;
  }

  // Uploaded images (/uploads/): Cache so previously viewed photos load offline
  if (url.pathname.startsWith("/uploads/") && request.method === "GET") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;

        try {
          const response = await fetch(request);
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          if (cached) return cached;
          return new Response("", { status: 404, statusText: "Offline photo not cached" });
        }
      })(),
    );
  }
});
