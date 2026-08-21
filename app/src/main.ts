import { CamTile, type CamConfig } from './tile'
import type { Transport } from './transport'
import { mseSupported } from './transport'
import { keepScreenOn, wakeLockSupported, unlockAudio, stopAlarm } from './keepalive'
import { icon } from './icons'
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

// ── Ausgeblendete Kameras ───────────────────────────────────────────
//
// Pro GERÄT gemerkt, nicht global: das Fire Tablet im Flur braucht den
// selten genutzten Springer nicht, das iPhone vielleicht schon.
//
// Wichtig fürs Gewissen: eine ausgeblendete Kamera wird NICHT überwacht
// — keine Verbindung, kein Watchdog, kein Alarm. Deshalb bleibt sie in
// der Leiste als Chip sichtbar, statt spurlos zu verschwinden.

const hiddenIds = new Set<string>(readHidden())

function readHidden(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('hiddenCams') ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function isHidden(t: CamTile): boolean {
  return hiddenIds.has(t.id)
}

function setHidden(t: CamTile, hidden: boolean) {
  if (hidden) hiddenIds.add(t.id)
  else hiddenIds.delete(t.id)
  try {
    localStorage.setItem('hiddenCams', JSON.stringify([...hiddenIds]))
  } catch { /* ohne Speicher gilt es eben nur bis zum Neuladen */ }

  t.el.classList.toggle('off', hidden)
  if (hidden) t.suspend()
  else void t.connect()
  renderPicker()
  layoutGrid()
}

async function main() {
  const cfg: AppConfig = await fetch('cams.json', { cache: 'no-cache' }).then((r) => r.json())
  const transport = pickTransport()
  const sd = useSubstream()
  const base = cfg.go2rtc || ''

  tiles = cfg.cams.map((cam) => new CamTile(cam, base, transport, sd))
  tiles.forEach((t) => {
    t.el.classList.toggle('off', isHidden(t))
    app.append(t.el)
    t.el.addEventListener('click', () => toggleFullscreen(t))
  })

  buildBar(transport, sd)

  // Der Alarm braucht einen entsperrten AudioContext, und Browser
  // entsperren nur in einer echten Geste. Bisher hing das allein am
  // Startknopf — läuft der Ton aber von selbst an oder fliegt der Knopf
  // mangels Wake Lock raus, tippt ihn nie jemand, und der Alarm bliebe
  // stumm. Deshalb entsperrt die ERSTE Berührung, egal wo sie landet.
  document.addEventListener('pointerdown', () => unlockAudio(), { once: true })

  // Nur bei Bedarf nachladen: die Diagnose kostet gut 1,5 kB, die im
  // Normalbetrieb niemand braucht.
  if (debugEnabled()) {
    void import('./diagnostics').then((d) => d.mountDebugPanel(bar, tiles))
  }

  // Alarm zentral verwalten: er verstummt erst, wenn KEINE sichtbare
  // Kachel mehr "lost" ist. Ausgeblendete zählen nicht — sie sind
  // absichtlich unbeobachtet, und das zeigt ihr Chip in der Leiste.
  app.addEventListener('tilestate', () => {
    if (!tiles.some((t) => !isHidden(t) && t.isLost())) stopAlarm()
  })
  // Zustandsänderungen von außen (Hintergrund-Stummschaltung, spät
  // abgelehnter Ton) in den Schaltern nachziehen.
  app.addEventListener('tilemuted', renderPicker)

  // Das Raster passt sich den echten Bildmaßen und der Fensterform an.
  app.addEventListener('tileaspect', layoutGrid)
  window.addEventListener('resize', layoutGrid)
  layoutGrid()

  await Promise.all(tiles.filter((t) => !isHidden(t)).map((t) => t.connect()))

  // Ton sofort versuchen. Klappt das (Desktop mit Media Engagement,
  // teils auch die installierte PWA), spart es den Tap; klappt es nicht,
  // bleibt alles stumm und der Knopf in der Leiste erledigt es später.
  await Promise.all(tiles.filter((t) => !isHidden(t)).map((t) => t.tryUnmute()))
  renderPicker()
  updateStartButton()

  watchVisibility()
}

// ── Sichtbarkeit ────────────────────────────────────────────────────

/**
 * Der Ton folgt der Sichtbarkeit: App im Hintergrund → stumm, App
 * wieder vorn → der vorherige Zustand kommt zurück.
 *
 * Anlass war das Fire Tablet, auf dem der Ton nach dem Verlassen der
 * App einfach weiterlief — unsichtbar und damit unauffindbar. Wer
 * bewusst WEITERHÖREN will, nimmt Bild-in-Bild: ein PiP-Fenster ist
 * sichtbar, und seine Kachel wird deshalb ausdrücklich nicht angefasst.
 *
 * Beim Zurückkommen werden außerdem tote Streams neu verbunden: nach
 * einem Suspend (Deckel zu, Tab weg) sind sie meist hin, ohne dass ein
 * Ereignis feuert.
 */
function watchVisibility() {
  const mutedInBackground = new Set<CamTile>()

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      tiles.forEach((t) => {
        if (!t.muted && !t.pipActive()) {
          t.setMuted(true)
          mutedInBackground.add(t)
        }
      })
      return
    }

    const restore = [...mutedInBackground]
    mutedInBackground.clear()
    restore.forEach((t) => void t.unmute())
    tiles.filter((t) => !isHidden(t) && t.isLost()).forEach((t) => void t.connect())
  })
}

// ── Kachelraster ────────────────────────────────────────────────────

/**
 * Spaltenzahl so wählen, dass die Kacheln den Platz maximal nutzen.
 *
 * `auto-fit` mit fester Mindestbreite hat das nicht geschafft: auf dem
 * Fire Tablet quer standen drei winzige Kacheln in einer Reihe über
 * einem leeren Rest — bei drei Kameras ist dort 2+1 die richtige
 * Aufteilung. Die lässt sich nicht deklarativ hinschreiben, also wird
 * gerechnet: für jede Spaltenzahl die mögliche Kachelbreite bestimmen
 * (begrenzt durch Breite UND Höhe), die beste gewinnt.
 *
 * Beim schmalsten Seitenverhältnis begrenzt die HÖHE die Breite — das
 * höchste Bild bestimmt die Zeilenhöhe, deshalb rechnet die Schranke
 * mit dem kleinsten Verhältnis aller sichtbaren Kacheln.
 */
function layoutGrid() {
  if (app.dataset.focus) return
  const visible = tiles.filter((t) => !isHidden(t))
  if (visible.length === 0) {
    app.style.gridTemplateColumns = ''
    return
  }

  const gap = 8
  const w = app.clientWidth - 16
  const h = app.clientHeight - 16
  if (w <= 0 || h <= 0) return

  const ar = Math.min(...visible.map((t) => t.aspect))
  let best = { cols: 1, width: 0 }
  for (let cols = 1; cols <= visible.length; cols++) {
    const rows = Math.ceil(visible.length / cols)
    const byWidth = (w - (cols - 1) * gap) / cols
    const byHeight = ((h - (rows - 1) * gap) / rows) * ar
    const width = Math.min(byWidth, byHeight)
    if (width > best.width) best = { cols, width }
  }

  app.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.width)}px)`
}

// ── Bedienleiste ────────────────────────────────────────────────────

let startButton: HTMLButtonElement | null = null

function button(html: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.innerHTML = html
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}

function buildBar(transport: Transport, sd: boolean) {
  // Ein einziger Tap, der drei Dinge gleichzeitig erledigt: AudioContext
  // entsperren (sonst kein Alarm), Wake Lock anfordern (Browser verlangen
  // dafür teils eine Geste) und den Ton freigeben.
  //
  // Der Knopf bleibt auch dann nötig, wenn der Ton schon von selbst
  // läuft — Wake Lock gibt es ohne Geste nirgends.
  // Ohne Wake-Lock-API verspricht der Knopf nur, was er halten kann.
  const startLabel = wakeLockSupported ? 'Ton & Bildschirm an' : 'Ton an'
  const start = button(`${icon('sound')}<span>${startLabel}</span>`, async () => {
    try {
      unlockAudio()

      // Reihenfolge ist hier entscheidend. Safari erklärt die Nutzergeste
      // nach dem ersten `await` für verbraucht — stünde `keepScreenOn()`
      // davor, käme das entscheidende `play()` zu spät und der Ton bliebe
      // aus, obwohl getippt wurde. Deshalb erst anstoßen, dann warten.
      const unmuting = Promise.all(
        tiles.filter((t) => !isHidden(t)).map((t) => t.tryUnmute()),
      )
      await keepScreenOn()
      await unmuting
    } finally {
      // Auch wenn oben etwas schiefgeht: die Leiste MUSS reagieren.
      // Auf dem Fire Tablet hing genau hier alles — ein Tap ohne jede
      // sichtbare Folge ist schlimmer als eine halbe Fehlermeldung.
      renderPicker()
      updateStartButton()
    }
  })
  start.classList.add('primary')
  startButton = start

  const picker = document.createElement('div')
  picker.className = 'picker'

  const info = document.createElement('span')
  info.className = 'info'
  info.textContent = [
    transport === 'webrtc' ? 'WebRTC' : 'MSE',
    sd ? 'VGA' : 'HD',
    wakeLockSupported ? null : 'kein Wake Lock',
  ].filter(Boolean).join(' · ')

  bar.append(picker, start, info)
  renderPicker()
}

/**
 * Läuft überall Ton, wo er laufen soll, schrumpft der Startknopf auf
 * seine verbleibende Aufgabe zusammen: den Bildschirm wachhalten.
 *
 * Und wo es die Wake-Lock-API gar nicht gibt — Fire Tablet —, hat er
 * dann KEINE Aufgabe mehr und verschwindet. Ein Knopf, der nichts tut,
 * ist schlimmer als kein Knopf; den Bildschirm hält dort ohnehin die
 * Kiosk-App wach. Der Alarm hängt nicht mehr an ihm: die erste
 * Berührung irgendwo entsperrt den AudioContext (siehe main()).
 */
function updateStartButton() {
  if (!startButton) return
  const soundDone = !tiles.some((t) => !isHidden(t) && t.wantsSound && t.muted)
  if (!soundDone) return
  if (wakeLockSupported) {
    startButton.innerHTML = `${icon('screen')}<span>Bildschirm anlassen</span>`
  } else {
    startButton.remove()
    startButton = null
  }
}

/**
 * Ein Chip je Kamera: Name mit Tonsymbol (Tap = Ton an/aus) und daneben
 * ein schmales ✕ zum Ausblenden. Ausgeblendete Kameras bleiben als
 * gedämpfter Chip mit + stehen — bewusst sichtbar, denn eine
 * ausgeblendete Kamera wird nicht überwacht, und das darf niemand
 * vergessen, der auf die Leiste schaut.
 *
 * Die Schalter zeigen immer den ECHTEN Zustand: sie werden nach jedem
 * tilemuted-Ereignis neu aufgebaut, statt sich Klicks zu merken. Ein
 * Tap auf einen Chip ist zugleich die Nutzergeste, die der Browser für
 * den Ton verlangt — deshalb sind die Chips auch dann da, wenn die
 * automatische Freigabe beim Start abgelehnt wurde.
 *
 * Tonzustand wird bewusst NICHT gemerkt (nach Neuladen gilt cams.json),
 * die Ausblendung schon — Ersteres ist eine Sicherheits-, Letzteres
 * eine Geräteentscheidung.
 */
function renderPicker() {
  const wrap = bar.querySelector('.picker')
  if (!wrap) return
  wrap.replaceChildren()

  // Aktive zuerst, Ausgeblendete gesammelt dahinter. Nach cams.json
  // sortiert stünden die grauen Chips mitten zwischen den grünen —
  // zwei Gruppen lesen sich schneller als eine gemischte Reihe.
  const ordered = [
    ...tiles.filter((t) => !isHidden(t)),
    ...tiles.filter((t) => isHidden(t)),
  ]

  ordered.forEach((t) => {
    if (isHidden(t)) {
      const b = button(`${icon('camoff')}<span>${t.name}</span>`, () => setHidden(t, false))
      b.className = 'chip ghost'
      b.title = `${t.name} einblenden`
      wrap.append(b)
      return
    }

    const chip = document.createElement('div')
    chip.className = 'chip'
    chip.classList.toggle('on', !t.muted)

    const snd = button(
      `${icon(t.muted ? 'muted' : 'sound')}<span>${t.name}</span>`,
      async () => {
        if (t.muted) await t.unmute()
        else t.setMuted(true)
        renderPicker()
      },
    )
    snd.className = 'snd'
    snd.title = t.muted ? `Ton für ${t.name} einschalten` : `Ton für ${t.name} ausschalten`

    const hide = button(icon('hide'), () => setHidden(t, true))
    hide.className = 'hide'
    hide.title = `${t.name} ausblenden`

    chip.append(snd, hide)
    wrap.append(chip)
  })
}

// ── Vollbild ────────────────────────────────────────────────────────

/**
 * Eine Kachel groß — und zwar so groß, wie das Gerät hergibt.
 *
 * Zwei Stufen, weil nicht jedes Gerät beide kann:
 *
 * 1. **Fokus** (immer): alle anderen Kacheln raus, die Bedienleiste weg,
 *    die verbleibende Kachel füllt die Seite.
 * 2. **Echtes Vollbild** (wo vorhanden): zusätzlich `requestFullscreen()`
 *    auf `#app`, was auch die Browserleisten verschwinden lässt.
 *
 * Vollbild wird bewusst auf `#app` angefordert und nicht auf die Kachel:
 * so gelten die bestehenden Fokus-Regeln unverändert weiter, und vor
 * allem bleiben Statusabzeichen und Ausgrauen erhalten. Auf dem iPhone
 * gäbe es über `video.webkitEnterFullscreen()` zwar auch echtes
 * Vollbild, aber nur im nativen Player — ohne Abzeichen und ohne
 * Ausgrauen. Ein eingefrorenes Bild sähe dort aus wie ein Livebild, und
 * genau das darf diese App nicht zulassen. Deshalb bleibt es auf dem
 * iPhone bei Stufe 1, die im installierten Zustand ohnehin fast den
 * ganzen Schirm füllt.
 */
function toggleFullscreen(tile: CamTile) {
  setFocus(app.dataset.focus === tile.id ? null : tile)
}

function setFocus(tile: CamTile | null) {
  app.dataset.focus = tile?.id ?? ''
  document.body.classList.toggle('focused', tile !== null)
  tiles.forEach((t) => t.el.classList.toggle('hidden', tile !== null && t.id !== tile.id))
  // Zurück im Raster: die Spalten neu rechnen, die Fensterform kann
  // sich im Vollbild geändert haben (Drehung, Browserleisten).
  if (!tile) layoutGrid()

  if (tile) {
    // Nur versuchen, nicht erzwingen: ohne Unterstützung bleibt es bei
    // Stufe 1, und das ist kein Fehlerfall.
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      void app.requestFullscreen?.().catch(() => {})
    }
  } else if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
  }
}

// Escape und die Wischgeste beenden das Vollbild am Browser vorbei. Ohne
// das bliebe die App im Fokus hängen: eine Kachel sichtbar, zwei
// versteckt, und die anderen beiden Kameras unbemerkt aus dem Blick.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && app.dataset.focus) setFocus(null)
})

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
