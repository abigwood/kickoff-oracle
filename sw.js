const VERSION = "retired-2026-07-25";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      try {
        await client.navigate(client.url);
      } catch {}
    }
  })());
});

self.addEventListener("fetch", () => {
  return;
});
