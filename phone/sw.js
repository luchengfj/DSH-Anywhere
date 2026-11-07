/* DSH Anywhere - service worker.
 * Caches the static app shell for offline "add to home screen" use.
 * IMPORTANT: /api/* (REST + SSE + token query) is NEVER cached or intercepted —
 * serving a stale SSE stream or a cached auth response would break the bridge.
 * All event data / outbox persistence lives in localStorage inside app.js.
 */
const CACHE = "dsh-anywhere-shell-v1";

/* Resolve shell assets relative to the SW scope so / and /app/ both work. */
const BASE = new URL(self.registration.scope);
const SHELL = [
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icon.svg",
  "./",
].map((p) => new URL(p, BASE).href);

const shellSet = new Set(SHELL);
const INDEX_URL = new URL("index.html", BASE).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // addAll fails the whole install if any single asset 404s; add each independently.
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => undefined)
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  // REST + SSE endpoints. Also treat any ?token= stream URL as dynamic.
  return url.pathname.includes("/api/") || url.searchParams.has("token");
}

function isShell(url) {
  return shellSet.has(url.href) || url.pathname === new URL("./", BASE).pathname ||
    url.pathname === BASE.pathname;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // let POST /api/pair, /api/command etc. go straight through
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin
  if (isApi(url)) return; // network only: auth + EventSource + replay

  // Navigations: network-first, fall back to cached index.html when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(INDEX_URL, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => caches.match(INDEX_URL).then((r) => r || caches.match(new URL("./", BASE).href)))
    );
    return;
  }

  // Static shell assets: stale-while-revalidate cache-first.
  if (isShell(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
  // Everything else: default browser network behaviour.
});
