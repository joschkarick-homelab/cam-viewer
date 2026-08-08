/**
 * Erkennt eingefrorene Streams.
 *
 * Warum nicht einfach `pc.connectionState`? Weil der lügt. Ein
 * WebRTC-PeerConnection meldet minutenlang "connected", während längst
 * keine Frames mehr ankommen — etwa wenn die Cam neu startet oder das
 * WLAN kurz weg war. Genau dieser Zustand ist bei einer Babycam der
 * gefährlichste: ein Standbild sieht aus wie ein schlafendes Kind.
 *
 * Deshalb prüfen wir zwei unabhängige Lebenszeichen:
 *
 *   1. video.currentTime muss vorwärts laufen  (gilt für beide Transporte)
 *   2. framesDecoded muss steigen              (nur WebRTC, dafür präzise)
 *
 * Eines von beiden genügt als Beweis, dass Bild ankommt. Stehen beide
 * still, gilt der Stream als tot — auch wenn der Browser das anders sieht.
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
      let alive = false

      const t = this.video.currentTime
      if (t !== this.lastTime) {
        this.lastTime = t
        alive = true
      }

      const frames = await this.conn.framesDecoded()
      if (frames !== null && frames !== this.lastFrames) {
        this.lastFrames = frames
        alive = true
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
