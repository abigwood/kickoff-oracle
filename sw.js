/* KickOff Oracle service worker.
   - App shell + static assets: cache-first (stale-while-revalidate) → instant launch.
   - data/matches.json + ALL Worker API calls: STRICT network-first → scores, picks
     and league tables are never stale; offline falls back to the last response
     tagged so the app can show an "offline" note.
   Bump VERSION on each deploy to roll the caches. */
const VERSION = "v51-2026-06-17";
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
  // Precache the shell. cache:"reload" BYPASSES the browser HTTP cache so a new
  // version stores the FRESH index.html, not a stale copy — this is what makes
  // an update actually contain new content. We DON'T skipWaiting here: the page
  // triggers it (via the message below) once its controllerchange listener is
  // wired, so the takeover never races the page and the one-launch reload sticks.
  e.waitUntil(
    caches.open(SHELL).then((c) =>
      Promise.allSettled(SHELL_ASSETS.map((a) => c.add(new Request(a, { cache: "reload" }))))
    )
  );
});

// clients that said "I'll reload myself safely" — don't force-navigate them
const ackedClients = new Set();

self.addEventListener("message", (e) => {
  if (!e.data) return;
  // the page asks us to take over the instant it's ready for the update
  if (e.data.type === "SKIP_WAITING") self.skipWaiting();
  // a cooperating page will handle its OWN guarded reload — exempt it from the fallback navigate
  if (e.data.type === "RELOAD_ACK" && e.source) ackedClients.add(e.source.id);
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => !k.startsWith(VERSION));
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();

    // FIRST install (no prior version cached) → the page already loaded fresh; reload no one.
    if (stale.length === 0) return;

    // This is an UPDATE → rescue open windows onto the fresh shell. Cooperating
    // (new-build) pages ACK and reload THEMSELVES at a safe moment (never mid-pick).
    // Pages that don't ACK (old stranded builds with no handler) are force-navigated
    // as a fallback — they only reach activate right after a fresh navigation/open,
    // so they are not mid-pick. (client.navigate is flaky on iOS WebKit; those PWAs
    // self-heal on the next cold relaunch, which serves the fresh shell.)
    let wins = await self.clients.matchAll({ type: "window" });
    wins.forEach((c) => c.postMessage({ type: "SW_UPDATED", version: VERSION }));
    await new Promise((r) => setTimeout(r, 3000)); // grace for cooperating pages to ACK / self-reload
    wins = await self.clients.matchAll({ type: "window" });
    for (const c of wins) {
      if (!ackedClients.has(c.id)) { try { await c.navigate(c.url); } catch {} }
    }
  })());
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
