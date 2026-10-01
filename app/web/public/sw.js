const CACHE_VERSION = "assistant-pwa-v3";
const SHELL_CACHE = `${CACHE_VERSION}:shell`;
const ASSET_CACHE = `${CACHE_VERSION}:assets`;

const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("assistant-pwa-") &&
                !key.startsWith(CACHE_VERSION),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isDynamicPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, "/index.html"));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (isShellAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request, SHELL_CACHE));
  }
});

function isDynamicPath(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/ws" ||
    pathname.startsWith("/mcp/") ||
    pathname.startsWith("/api/session-artifacts/")
  );
}

function isShellAsset(pathname) {
  return SHELL_URLS.includes(pathname) || pathname === "/sw.js";
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (
      (await cache.match(request)) ||
      (fallbackUrl ? await cache.match(fallbackUrl) : undefined) ||
      new Response("Offline", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    );
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(event, request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached =
    (await cache.match(request)) ||
    (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }

  const response = await network;
  return (
    response ||
    new Response("Offline", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  );
}
