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

  if (event.request.method !== 'GET') return
  if (url.origin !== self.location.origin) return

  // Bewusst eng: nur die Seite selbst und die gehashten Bundles. Alles
  // andere geht unangetastet ans Netz — /api/ ohnehin (ein gecachter
  // Stream wäre ein Standbild), aber auch cams.json und das Manifest.
  //
  // Grund: hinter authentik werden manche Anfragen ohne Cookies
  // gestellt, laufen in den Login-Redirect und scheitern. Fängt der
  // Worker sie ab, macht er aus einem Randproblem einen Fehler in der
  // App. Sein einziger Zweck ist, dass Chrome und Edge "Installieren"
  // anbieten — dafür genügt diese schmale Zuständigkeit.
  const mine =
    event.request.mode === 'navigate' || url.pathname.startsWith('/assets/')
  if (!mine) return

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
