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

/** Nach so vielen Millisekunden ohne Lebenszeichen gilt ein LAUFENDER Stream als tot. */
const STALL_MS = 3000

/**
 * Geduld bis zum allerersten Frame.
 *
 * Bis ein Bild ankommt, passiert einiges: go2rtc meldet sich bei der Cam
 * an, ICE handelt einen Pfad aus, DTLS gibt sich die Hand. Zusammen sind
 * das bei WebRTC schnell mehrere Sekunden — deutlich mehr als bei MSE,
 * wo die Daten sofort durch den bestehenden WebSocket laufen.
 *
 * Mit denselben 3 s wie beim laufenden Betrieb würden wir eine völlig
 * gesunde WebRTC-Verbindung abschießen, bevor sie das erste Bild
 * liefern konnte — und der Reconnect fängt wieder bei null an.
 */
const STARTUP_MS = 12000

/** Prüfintervall. 1 s ist der Kompromiss aus Reaktionszeit und Ruhe auf schwacher Hardware. */
const TICK_MS = 1000

export class Watchdog {
  private timer: number | undefined
  private lastProgress = 0
  private lastTime = -1
  private lastFrames: number | null = null
  private busy = false

  /** Basiswerte erfasst? Der erste Tick misst nur, er wertet noch nicht. */
  private started = false

  /** Kam jemals ein Bild an? Trennt Anlaufphase von laufendem Betrieb. */
  private everAlive = false

  constructor(
    private video: HTMLVideoElement,
    private conn: Connection,
    private onStall: () => void,
    /** Feuert einmalig beim ersten belegten Lebenszeichen. */
    private onAlive: () => void,
  ) {}

  start() {
    this.lastProgress = Date.now()
    this.started = false
    this.everAlive = false
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
      const frames = await this.conn.framesDecoded()

      // Der erste Durchlauf nimmt nur Maß. Ohne das zählte schon der
      // Sprung von „noch nichts gemessen" auf den ersten Messwert als
      // Lebenszeichen — die Anlaufphase wäre sofort vorbei, und ein
      // Stream, der nie ein Bild liefert, sähe eine Sekunde lang gesund
      // aus.
      if (!this.started) {
        this.started = true
        this.lastTime = t
        this.lastFrames = frames
        return
      }

      // framesDecoded schlägt currentTime, wo es das gibt — siehe Kopf
      // der Datei. Ein Standbild mit laufendem Ton darf nicht als „Live"
      // durchgehen.
      let alive: boolean
      if (frames !== null) {
        alive = frames !== this.lastFrames
        this.lastFrames = frames
      } else {
        alive = t !== this.lastTime
      }
      this.lastTime = t

      if (alive) {
        this.lastProgress = Date.now()
        if (!this.everAlive) {
          this.everAlive = true
          this.onAlive()
        }
      } else if (this.staleFor() > (this.everAlive ? STALL_MS : STARTUP_MS)) {
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
