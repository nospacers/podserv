const SHELL_CACHE = "podcast-shell-v2";
const MEDIA_CACHE = "podcast-media-v2";
const APP_ASSETS = [
  "/",
  "/static/styles.css",
  "/static/app.js",
  "/static/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => ![SHELL_CACHE, MEDIA_CACHE].includes(key))
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "CACHE_URLS") {
    event.waitUntil(cacheUrls(data.urls || [], event.source));
  }
});

async function cacheUrls(urls, source) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    let count = 0;
    for (const url of urls) {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`Failed to fetch ${url}`);
      await cache.put(url, response.clone());
      count += 1;
    }
    source?.postMessage({ type: "CACHE_DONE", count });
  } catch (error) {
    source?.postMessage({ type: "CACHE_ERROR", message: error.message || "Offline caching failed." });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/media/")) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match("/"));
    })
  );
});
