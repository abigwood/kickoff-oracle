/* KickOff Oracle service worker.
   - App shell + static assets: cache-first (stale-while-revalidate) → instant launch.
   - data/matches.json + ALL Worker API calls: STRICT network-first → scores, picks
     and league tables are never stale; offline falls back to the last response
     tagged so the app can show an "offline" note.
   Bump VERSION on each deploy to roll the caches. */
const VERSION = "v8-2026-06-12";
const SHELL = VERSION + "-shell";
const RUNTIME = VERSION + "-runtime";
const API_HOST = "kickoff-oracle-window.abigwood.workers.dev";

const SHELL_ASSETS = [
  "./", "./index.html", "./album.html",
  "./manifest.webmanifest",
  "./data/squads.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(SHELL_ASSETS.map((a) => c.add(a)))) // tolerate any single miss
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network-first: always fresh online; offline → last cached, tagged X-From-Cache
function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(async () => {
      const cached = await caches.match(req);
      if (cached) {
        const h = new Headers(cached.headers);
        h.set("X-From-Cache", "1");
        const body = await cached.blob();
        return new Response(body, { status: cached.status, statusText: cached.statusText, headers: h });
      }
      return new Response(JSON.stringify({ offline: true }), {
        status: 503,
        headers: { "content-type": "application/json", "X-From-Cache": "1" },
      });
    });
}

// stale-while-revalidate: serve cache instantly, refresh in the background
function staleWhileRevalidate(req) {
  return caches.match(req).then((cached) => {
    const network = fetch(req)
      .then((res) => {
        if (res && res.status === 200 && (req.url.startsWith(self.location.origin) || res.type === "basic" || res.type === "cors")) {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => cached);
    return cached || network;
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // picks/joins/etc. → straight to network, never cached
  const url = new URL(req.url);

  // STRICT network-first for live data + every Worker API call
  if (url.hostname === API_HOST || url.pathname.endsWith("/data/matches.json")) {
    e.respondWith(networkFirst(req));
    return;
  }

  // cache-first (SWR) for the app shell, our static assets, and the web font
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com");
  if (sameOrigin || isFont) {
    e.respondWith(staleWhileRevalidate(req));
  }
  // anything else (e.g. youtube embeds): default network
});
