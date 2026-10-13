const CACHE_NAME = "routiner-shell-v1";
const SHELL_FILES = ["/", "/manifest.webmanifest", "/routiner.svg", "/icon-192.png", "/icon-512.png"];

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
  if (
    request.method !== "GET"
    || url.origin !== self.location.origin
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/uploads/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          await caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone()));
          return response;
        } catch (error) {
          const fallback = await caches.match("/");
          if (fallback) return fallback;
          throw error;
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname === "/routiner.svg" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
