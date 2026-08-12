/**
 * Service Worker — ausschließlich, damit Chrome und Edge die App als
 * installierbar erkennen. Ohne einen Fetch-Handler bieten sie unter
 * Windows und macOS gar kein "Installieren" an.
 *
 * Bewusst NETWORK-FIRST, nicht cache-first.
 *
 * Der übliche PWA-Ansatz cacht die App-Shell und liefert sie sofort aus.
 * Für eine Babycam ist das die falsche Abwägung: nach einem Deploy liefe
 * dann tagelang alter Code weiter — und in dieser App stecken die
 * Sicherheitsregeln (Watchdog, Ausgrauen, Alarm) genau in diesem Code.
 * Ein zwei Wochen alter Stand, der ein Standbild als Livebild anzeigt,
 * wäre schlimmer als eine Sekunde Ladezeit.
 *
 * Deshalb: immer erst das Netz fragen, der Cache ist nur der Fallback,
 * wenn gar nichts geht. Dann sieht man wenigstens die Oberfläche mit
 * roten Kacheln statt einer Browser-Fehlerseite.
 */

const CACHE = 'cam-viewer-v1'

// Sofort übernehmen statt auf das Schließen aller Tabs zu warten —
// sonst bliebe nach einem Deploy der alte Worker aktiv.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Streams und go2rtc-API niemals anfassen. Ein gecachter Stream wäre
  // ein Standbild — und WebSockets laufen ohnehin nicht über fetch.
  if (url.pathname.startsWith('/api/')) return
  if (event.request.method !== 'GET') return
  if (url.origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(event.request)
        // Nur brauchbare Antworten aufheben.
        if (fresh.ok) {
          const cache = await caches.open(CACHE)
          await cache.put(event.request, fresh.clone())
        }
        return fresh
      } catch (err) {
        const hit = await caches.match(event.request)
        if (hit) return hit
        throw err
      }
    })(),
  )
})
