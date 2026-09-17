globalThis.addEventListener("install", () => {
  void globalThis.skipWaiting();
});

globalThis.addEventListener("activate", (event) => {
  event.waitUntil(globalThis.clients.claim());
});

// Keep private job-search data network-only. This handler enables app installation
// without persisting authenticated pages or API responses in the browser cache.
globalThis.addEventListener("fetch", (event) => {
  if (event.request.method === "GET") event.respondWith(fetch(event.request));
});
