/* Purser in your pocket: notifications and a phone app that still opens on a bad connection. */
const CACHE = "purser-pocket-v2";
const SHELL = ["/pocket", "/fonts/geist.woff2", "/fonts/geist-mono.woff2", "/pocket/icon-192.png", "/pocket/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/v1/")) return; // live data is never cached
  if (req.mode === "navigate" && url.pathname.startsWith("/pocket")) {
    // the newest page when online; the last one seen when not
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/pocket", copy));
          return res;
        })
        .catch(() => caches.match("/pocket")),
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/pocket/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Purser", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Purser";
  // The number on the app icon: how many payments wait for the owner right now.
  const badge =
    typeof data.badge === "number" && "setAppBadge" in self.navigator
      ? (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined)
      : Promise.resolve();
  event.waitUntil(
    Promise.all([
      badge,
      self.registration.showNotification(title, {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: !!data.tag,
        icon: "/pocket/icon-192.png",
        badge: "/pocket/badge-96.png",
        data: { url: data.url || "/pocket" },
      }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/pocket", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).pathname.startsWith("/pocket") && "focus" in client) {
          client.postMessage({ type: "open", url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
