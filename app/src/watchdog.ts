/**
 * Erkennt eingefrorene Streams.
 *
 * Warum nicht einfach `pc.connectionState`? Weil der lügt. Ein
 * WebRTC-PeerConnection meldet minutenlang "connected", während längst
 * keine Frames mehr ankommen — etwa wenn die Cam neu startet oder das
 * WLAN kurz weg war. Genau dieser Zustand ist bei einer Babycam der
 * gefährlichste: ein Standbild sieht aus wie ein schlafendes Kind.
 *
 * Deshalb prüfen wir zwei Lebenszeichen — aber nicht gleichberechtigt:
 *
 *   1. framesDecoded  (nur WebRTC, dafür der einzige echte Beweis, dass
 *                      ein BILD dekodiert wurde)
 *   2. video.currentTime  (gilt für beide Transporte, ist aber nur ein
 *                      Indiz: er läuft auch weiter, wenn nur noch Ton
 *                      ankommt)
 *
 * Sobald framesDecoded verfügbar ist, entscheidet ausschließlich dieser
 * Wert. Würden wir „eines von beiden genügt" rechnen, hielte ein
 * weiterlaufender Audiotrack das Bild künstlich am Leben: currentTime
 * tickt, framesDecoded steht — und die Kachel zeigt weiter ein
 * eingefrorenes Standbild als „Live". Genau der Zustand, den diese Datei
 * verhindern soll. Nur wenn framesDecoded nichts liefert (MSE, oder ein
 * reiner Audiostream ohne inbound-rtp-Videoreport), fallen wir auf
 * currentTime zurück.
 */

import type { Connection } from './transport'

/** Nach so vielen Millisekunden ohne Lebenszeichen gilt der Stream als tot. */
const STALL_MS = 3000

/** Prüfintervall. 1 s ist der Kompromiss aus Reaktionszeit und Ruhe auf schwacher Hardware. */
const TICK_MS = 1000

export class Watchdog {
  private timer: number | undefined
  private lastProgress = 0
  private lastTime = -1
  private lastFrames = -1
  private busy = false

  constructor(
    private video: HTMLVideoElement,
    private conn: Connection,
    private onStall: () => void,
  ) {}

  start() {
    this.lastProgress = Date.now()
    this.lastTime = -1
    this.lastFrames = -1
    this.timer = window.setInterval(() => void this.tick(), TICK_MS)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Millisekunden seit dem letzten belegten Lebenszeichen. Für die Anzeige. */
  staleFor(): number {
    return Date.now() - this.lastProgress
  }

  private async tick() {
    // getStats() kann unter Last länger als einen Tick brauchen. Ohne
    // diesen Riegel stapeln sich die Aufrufe und wir messen Unsinn.
    if (this.busy) return
    this.busy = true
    try {
      const t = this.video.currentTime
      const timeMoved = t !== this.lastTime
      this.lastTime = t

      const frames = await this.conn.framesDecoded()

      // framesDecoded schlägt currentTime, wo es das gibt — siehe Kopf
      // der Datei. Ein Standbild mit laufendem Ton darf nicht als „Live"
      // durchgehen.
      let alive: boolean
      if (frames !== null) {
        alive = frames !== this.lastFrames
        this.lastFrames = frames
      } else {
        alive = timeMoved
      }

      if (alive) {
        this.lastProgress = Date.now()
      } else if (this.staleFor() > STALL_MS) {
        this.stop() // nur einmal melden — der Aufrufer baut neu auf
        this.onStall()
      }
    } catch {
      // Ein fehlgeschlagenes getStats() heißt meist: die Verbindung ist
      // schon weg. Nicht als Lebenszeichen werten, aber auch nicht sofort
      // eskalieren — der Stall-Timer erledigt das gleich von selbst.
    } finally {
      this.busy = false
    }
  }
}

/**
 * Wartezeiten für Reconnects: 1s, 2s, 4s, 8s, dann alle 15s.
 *
 * Der Deckel ist Absicht. Unbegrenztes Backoff würde bedeuten, dass die
 * Cam nach einem längeren Ausfall erst Minuten später zurückkommt — für
 * eine Babycam inakzeptabel. 15 s Dauertakt kostet auf dem Server nichts.
 */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000)
}
