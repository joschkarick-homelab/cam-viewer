import { CamTile, type CamConfig } from './tile'
import type { Transport } from './transport'
import { mseSupported } from './transport'
import { keepScreenOn, wakeLockSupported, unlockAudio, stopAlarm } from './keepalive'
import './style.css'

interface AppConfig {
  /** Basis-URL von go2rtc. Leer = gleicher Origin (Reverse Proxy reicht /api durch). */
  go2rtc: string
  cams: CamConfig[]
}

const app = document.getElementById('app')!
const bar = document.getElementById('bar')!
let tiles: CamTile[] = []

// ── Umgebung erkennen ───────────────────────────────────────────────

/**
 * WebRTC im LAN, MSE von außen.
 *
 * Grund: die WebRTC-Medien laufen direkt auf go2rtc:8555 und damit am
 * Reverse Proxy — und an authentik — vorbei. Von außen wäre das ein
 * ungeschützter Port. MSE läuft komplett über die bestehende
 * WSS-Verbindung, kostet dafür ~0,7 s mehr Latenz.
 *
 * Die Heuristik lässt sich per ?transport=webrtc|mse überstimmen; die
 * Wahl bleibt dann gespeichert.
 */
function pickTransport(): Transport {
  const forced = new URLSearchParams(location.search).get('transport')
  if (forced === 'webrtc' || forced === 'mse') {
    localStorage.setItem('transport', forced)
    return forced
  }
  const saved = localStorage.getItem('transport')
  if (saved === 'webrtc' || saved === 'mse') return saved

  const h = location.hostname
  const local =
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(h) ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    !h.includes('.') // blanker Hostname → eigenes Netz

  if (local) return 'webrtc'
  return mseSupported ? 'mse' : 'webrtc'
}

/**
 * Schwache Geräte bekommen den VGA-Substream.
 *
 * Das Fire Tablet 7 dekodiert 3× 1080p nicht flüssig — und ein ruckelnder
 * Stream ist bei einer Babycam schlimmer als ein niedrig aufgelöster.
 * Per ?sd=1 / ?sd=0 erzwingbar.
 */
function useSubstream(): boolean {
  const forced = new URLSearchParams(location.search).get('sd')
  if (forced === '1' || forced === '0') {
    localStorage.setItem('sd', forced)
    return forced === '1'
  }
  const saved = localStorage.getItem('sd')
  if (saved) return saved === '1'

  const mem = (navigator as any).deviceMemory
  const cores = navigator.hardwareConcurrency ?? 8
  return (mem !== undefined && mem <= 2) || cores <= 4
}

/**
 * Diagnoseanzeige an oder aus, `?debug=1` / `?debug=0`.
 *
 * Wie die anderen Parameter gemerkt — beim Einrichten will man sie nicht
 * bei jedem Reload neu anhängen, auf dem Handy schon gar nicht.
 */
function debugEnabled(): boolean {
  const forced = new URLSearchParams(location.search).get('debug')
  if (forced === '1' || forced === '0') {
    localStorage.setItem('debug', forced)
    return forced === '1'
  }
  return localStorage.getItem('debug') === '1'
}

// ── Start ───────────────────────────────────────────────────────────

async function main() {
  const cfg: AppConfig = await fetch('cams.json', { cache: 'no-cache' }).then((r) => r.json())
  const transport = pickTransport()
  const sd = useSubstream()
  const base = cfg.go2rtc || ''

  tiles = cfg.cams.map((cam) => new CamTile(cam, base, transport, sd))
  tiles.forEach((t) => {
    app.append(t.el)
    t.el.addEventListener('click', () => toggleFullscreen(t))
  })

  buildBar(transport, sd)
  // Nur bei Bedarf nachladen: die Diagnose kostet gut 1,5 kB, die im
  // Normalbetrieb niemand braucht.
  if (debugEnabled()) {
    void import('./diagnostics').then((d) => d.mountDebugPanel(bar, tiles))
  }

  // Alarm zentral verwalten: er verstummt erst, wenn KEINE Kachel mehr
  // im Zustand "lost" ist. Einzelne Kacheln können das nicht entscheiden.
  app.addEventListener('tilestate', () => {
    if (!tiles.some((t) => t.isLost())) stopAlarm()
  })

  await Promise.all(tiles.map((t) => t.connect()))

  // Ton sofort versuchen. Klappt das (Desktop mit Media Engagement,
  // teils auch die installierte PWA), spart es den Tap; klappt es nicht,
  // bleibt alles stumm und der Knopf in der Leiste erledigt es später.
  await Promise.all(tiles.map((t) => t.tryUnmute()))
  showPicker()

  // Nach einem Suspend (Deckel zu, Tab weg) sind die Streams meist tot,
  // ohne dass ein Event feuert. Beim Zurückkommen prüfen wir aktiv nach.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    tiles.filter((t) => t.isLost()).forEach((t) => void t.connect())
  })
}

// ── Bedienleiste ────────────────────────────────────────────────────

let startButton: HTMLButtonElement | null = null

function buildBar(transport: Transport, sd: boolean) {
  // Ein einziger Tap, der drei Dinge gleichzeitig erledigt: AudioContext
  // entsperren (sonst kein Alarm), Wake Lock anfordern (Browser verlangen
  // dafür teils eine Geste) und den Ton freigeben.
  //
  // Der Knopf bleibt auch dann nötig, wenn der Ton schon von selbst
  // läuft — Wake Lock gibt es ohne Geste nirgends.
  const start = button('🔊 Ton & Bildschirm an', async () => {
    unlockAudio()

    // Reihenfolge ist hier entscheidend. Safari erklärt die Nutzergeste
    // nach dem ersten `await` für verbraucht — stünde `keepScreenOn()`
    // davor, käme das entscheidende `play()` zu spät und der Ton bliebe
    // aus, obwohl getippt wurde. Deshalb erst anstoßen, dann warten.
    const unmuting = Promise.all(tiles.map((t) => t.tryUnmute()))
    await keepScreenOn()
    await unmuting

    showPicker()
    start.remove()
    startButton = null
  })
  startButton = start

  const info = document.createElement('span')
  info.className = 'info'
  info.textContent = [
    transport === 'webrtc' ? 'WebRTC' : 'MSE',
    sd ? 'VGA' : 'HD',
    wakeLockSupported ? null : 'kein Wake Lock',
  ].filter(Boolean).join(' · ')

  bar.append(start, info)
}

/**
 * Die Ton-Schalter zeigen — unabhängig davon, ob der Ton schon läuft.
 *
 * Vorher erschienen sie erst, wenn ALLE Kacheln erfolgreich entstummt
 * waren. Schlug das bei einer fehl, gab es gar keine Schalter, und der
 * Ton war für keine Kamera einzeln regelbar. Genau umgekehrt ist es
 * richtig: die Schalter zeigen den echten Zustand, und über sie kommt
 * man auch dann an den Ton, wenn der Browser ihn zunächst verweigert
 * hat — ein Tap auf einen Schalter ist selbst die nötige Nutzergeste.
 */
function showPicker() {
  if (!bar.querySelector('.picker')) bar.prepend(soundPicker())
  // Solange eine Kachel Ton will, ihn aber nicht hat, bleibt der Knopf
  // das schnellste Mittel, alles auf einmal freizugeben.
  if (startButton && !tiles.some((t) => t.wantsSound && t.muted)) {
    startButton.textContent = '🔆 Bildschirm anlassen'
  }
}

/**
 * Ton pro Kamera einzeln schaltbar.
 *
 * Ursprünglich war das eine Auswahl — genau eine Cam mit Ton, weil drei
 * gleichzeitig nur Matsch ergeben. Für eine Babycam ist das aber zu
 * eng: zwei Kinderzimmer gleichzeitig zu hören ist der eigentliche
 * Zweck. Ob drei Streams sinnvoll sind, entscheidet der Mensch davor —
 * und was beim Start anliegt, steht als `sound` in `cams.json`.
 *
 * Die Schalter werden bewusst NICHT gemerkt. Nach einem Neuladen gilt
 * wieder, was in `cams.json` steht. Bei einem Babyfon ist das die
 * sichere Richtung: ein versehentlich stumm gebliebener Kanal darf nicht
 * über Tage hinweg stumm bleiben, nur weil ihn einmal jemand ausgemacht
 * hat.
 */
function soundPicker(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'picker'
  tiles.forEach((t) => {
    const b = button(t.name, async () => {
      if (t.muted) await t.unmute()
      else t.setMuted(true)
      // Erst nach dem await: lehnt der Browser den Ton ab, fällt die
      // Kachel auf stumm zurück, und der Schalter muss das zeigen statt
      // ein Anschalten zu behaupten, das nicht stattgefunden hat.
      b.classList.toggle('on', !t.muted)
    })
    b.classList.toggle('on', !t.muted)
    wrap.append(b)
  })
  return wrap
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = text
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}

// ── Vollbild ────────────────────────────────────────────────────────

function toggleFullscreen(tile: CamTile) {
  const active = app.dataset.focus === tile.id
  app.dataset.focus = active ? '' : tile.id
  tiles.forEach((t) => t.el.classList.toggle('hidden', !active && t.id !== tile.id))
}

main().catch((err) => {
  bar.textContent = `Start fehlgeschlagen: ${err.message}`
  bar.classList.add('error')
})

// Nur damit Chrome und Edge "Installieren" anbieten — der Worker cacht
// network-first, siehe public/sw.js. Registriert sich ausschließlich im
// Secure Context, über http://<IP> passiert also nichts. Das ist kein
// Fehler, sondern der Grund, warum die Installation erst mit NPMplus
// und TLS auftaucht.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js')
    .catch((err) => console.warn('[cam-viewer] Service Worker nicht registriert:', err))
}
