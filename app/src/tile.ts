/**
 * Eine Kamera-Kachel: Video, Statusanzeige, Verbindungsverwaltung.
 *
 * Der Zustandsautomat ist absichtlich klein gehalten:
 *
 *   connecting ──→ live ──→ stalled ──→ connecting  (Schleife)
 *                            │
 *                            └──→ lost  (nach mehreren Fehlversuchen)
 *
 * Wichtig: die Kachel zeigt IMMER an, was sie gerade ist. Es gibt keinen
 * Zustand, in dem ein altes Standbild als Livebild durchgehen könnte.
 */

import {
  connectWebRTC, connectMSE, describeRanges,
  type Connection, type Transport,
} from './transport'
import { Watchdog, backoffMs } from './watchdog'
import { startAlarm, stopAlarm } from './keepalive'
import { logEvent } from './log'

export type TileState = 'connecting' | 'live' | 'stalled' | 'lost'

export interface CamConfig {
  id: string
  name: string
  /** Alternativer Stream-Name für schwache Geräte (VGA-Substream). */
  sd?: string
  /** Bei Verbindungsverlust Alarm auslösen. Für die Babycams: ja. */
  alarm?: boolean
}

/** Ab so vielen Fehlversuchen in Folge gilt die Cam als "lost" und der Alarm geht los. */
const LOST_AFTER = 3

/**
 * Deckel für den Verbindungsaufbau.
 *
 * Beide Transporte können hängen bleiben, ohne je zu scheitern: MSE
 * wartet auf die Init-Nachricht von go2rtc, die über einen offenen, aber
 * stummen WebSocket nie kommt. Ohne diesen Deckel bliebe die Kachel für
 * immer auf "Verbinde…" stehen — kein Watchdog, kein Reconnect, und vor
 * allem kein Alarm, weil der Fehlversuchszähler nie hochzählt. Eine
 * tote Kamera, die niemandem auffällt, ist bei einer Babycam der
 * schlechteste aller Ausgänge.
 */
const CONNECT_TIMEOUT_MS = 15000

/** Lässt eine Promise scheitern, statt sie ewig offen zu lassen. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`keine Antwort beim Verbindungsaufbau (${ms / 1000}s)`)),
      ms,
    )
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

export class CamTile {
  readonly el: HTMLElement
  private video: HTMLVideoElement
  private badge: HTMLElement
  private label: HTMLElement
  private reason: HTMLElement

  private conn: Connection | null = null
  private dog: Watchdog | null = null
  private abort: AbortController | null = null
  private retryTimer: number | undefined
  private attempt = 0
  private state: TileState = 'connecting'
  private disposed = false

  constructor(
    private cam: CamConfig,
    private base: string,
    private transport: Transport,
    private useSd: boolean,
  ) {
    this.el = document.createElement('article')
    this.el.className = 'tile'

    this.video = document.createElement('video')
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.muted = true // Start immer stumm — Autoplay mit Ton blockt jeder Browser
    this.video.preload = 'none'

    this.badge = document.createElement('div')
    this.badge.className = 'badge'

    this.label = document.createElement('div')
    this.label.className = 'label'
    this.label.textContent = cam.name

    // Zeigt den letzten Fehlergrund, sobald die Kachel rot ist. Auf dem
    // Fire Tablet gibt es keine Entwicklerkonsole — ohne diese Zeile
    // bleibt dort nur "Verbindung weg" ohne jeden Anhaltspunkt.
    this.reason = document.createElement('div')
    this.reason.className = 'reason'

    this.el.append(this.video, this.label, this.badge, this.reason)
    this.setState('connecting')
  }

  get id() { return this.cam.id }
  get muted() { return this.video.muted }

  /** Der Stream-Name in go2rtc — je nach Gerät HD oder Substream. */
  private get src(): string {
    return this.useSd && this.cam.sd ? this.cam.sd : this.cam.id
  }

  async connect() {
    if (this.disposed) return

    // Einen noch laufenden Reconnect-Timer verwerfen. Ohne das reißt er
    // eine gerade wiederhergestellte Verbindung sofort wieder ab: kommt
    // die App aus dem Hintergrund zurück, ruft main.ts connect() auf,
    // während der alte 15-Sekunden-Timer noch pendelt — und der macht
    // dann kurz nach dem Wiederverbinden ein zweites Mal teardown().
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined

    this.teardown()
    this.setState('connecting')

    this.abort = new AbortController()
    const signal = this.abort.signal

    try {
      this.conn = await withTimeout(
        this.transport === 'webrtc'
          ? connectWebRTC(this.base, this.src, this.video, signal)
          : connectMSE(this.base, this.src, this.video, signal),
        CONNECT_TIMEOUT_MS,
      )

      // play() kann trotz autoplay abgelehnt werden. Stumm klappt es
      // praktisch immer; den Ton schaltet der Nutzer separat frei.
      await this.video.play().catch(() => {})

      if (signal.aborted) return

      // Die Kachel bleibt auf "Verbinde…", bis wirklich ein Bild
      // dekodiert wurde. Eine ausgehandelte Verbindung ist noch kein
      // Livebild — und "Live" ohne Bild ist genau die Lüge, die diese
      // App nicht erzählen darf.
      this.dog = new Watchdog(
        this.video,
        this.conn,
        () => {
          // Kein throw, also auch kein Eintrag in den Dev-Tools. Bei
          // WebRTC ist das der Normalfall eines kaputten Medienpfads:
          // die Signalisierung klappt, nur es kommt nie ein Bild.
          this.note(`keine Frames (${this.transport})`)
          this.setState('stalled')
          this.scheduleRetry()
        },
        () => {
          // Erst das erste Bild zählt als geglückter Versuch. Würde der
          // Zähler schon nach der Aushandlung zurückgesetzt, käme eine
          // Cam, die zwar aushandelt aber nie ein Bild liefert, niemals
          // in den Zustand "lost": jeder Reconnect setzte ihn auf 0
          // zurück, und der Alarm bliebe für immer stumm.
          this.attempt = 0
          this.reason.textContent = ''
          this.setState('live')
        },
      )
      this.dog.start()
    } catch (err) {
      if (!signal.aborted) {
        this.note(err instanceof Error ? err.message : String(err))
        // Aufräumen, bevor der nächste Versuch startet: bei einem
        // Timeout läuft der Verbindungsaufbau sonst im Hintergrund
        // weiter und hält seinen Socket offen.
        this.teardown()
        this.scheduleRetry()
      }
    }
  }

  /**
   * Hält den letzten Fehlergrund fest — in der Konsole und auf der
   * Kachel.
   *
   * Vorher stand hier ein blankes `catch {}`. Das hat jeden Grund
   * verschluckt: die Kachel wurde rot, die Konsole blieb leer, und beim
   * Einrichten war nicht zu unterscheiden, ob go2rtc nicht erreichbar
   * ist, der Stream-Name nicht stimmt oder nur keine Frames ankommen.
   */
  private note(msg: string) {
    console.warn(`[cam-viewer/${this.cam.id}] ${msg}`)
    this.reason.textContent = msg
    logEvent(this.cam.id, msg)
  }

  /**
   * Vollbild der Kachel für `?debug=1`.
   *
   * Bewusst alles auf einmal: Zustand, Zähler, Videoelement, Transport.
   * Wer bei einem stummen Fehler sucht, weiß vorher nicht, welcher Wert
   * der entscheidende ist — heute war es `buffered.length`, davor die
   * ICE-Kandidaten, davor der ausgehandelte Codec.
   */
  async diagnostics(): Promise<Record<string, unknown>> {
    const v = this.video
    const out: Record<string, unknown> = {
      id: this.cam.id,
      src: this.src,
      state: this.state,
      attempt: this.attempt,
      lastReason: this.reason.textContent || null,
      staleForMs: this.dog?.staleFor() ?? null,
      video: {
        readyState: v.readyState,
        networkState: v.networkState,
        currentTime: Number(v.currentTime.toFixed(2)),
        buffered: describeRanges(v.buffered),
        size: `${v.videoWidth}x${v.videoHeight}`,
        paused: v.paused,
        muted: v.muted,
        error: v.error ? `${v.error.code}: ${v.error.message}` : null,
      },
    }
    if (this.conn) {
      try {
        Object.assign(out, await this.conn.diagnostics())
      } catch (err) {
        out.connDiagnosticsError = String(err)
      }
    } else {
      out.connection = 'keine'
    }
    return out
  }

  private scheduleRetry() {
    if (this.disposed) return
    this.attempt++
    if (this.attempt >= LOST_AFTER) {
      this.setState('lost')
      if (this.cam.alarm) startAlarm()
    }
    clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => void this.connect(), backoffMs(this.attempt))
  }

  private setState(s: TileState) {
    if (s !== this.state) logEvent(this.cam.id, `→ ${s}`)
    this.state = s
    this.el.dataset.state = s
    this.badge.textContent = {
      connecting: 'Verbinde…',
      live: 'Live',
      stalled: 'Kein Bild',
      lost: 'Verbindung weg',
    }[s]
    // Der Alarm gilt global: er verstummt erst, wenn keine Kachel mehr
    // "lost" ist. Das prüft main.ts, weil eine Kachel den Zustand der
    // anderen nicht kennt.
    this.el.dispatchEvent(new CustomEvent('tilestate', { bubbles: true, detail: s }))
  }

  isLost() { return this.state === 'lost' }

  setMuted(m: boolean) {
    this.video.muted = m
    this.el.dataset.muted = String(m)
  }

  /** Aktuelles Bild als PNG. Liefert null, solange kein Frame da ist. */
  async snapshot(): Promise<Blob | null> {
    const w = this.video.videoWidth
    const h = this.video.videoHeight
    if (!w || !h) return null
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')!.drawImage(this.video, 0, 0)
    return new Promise((r) => canvas.toBlob(r, 'image/png'))
  }

  private teardown() {
    this.dog?.stop()
    this.dog = null
    this.abort?.abort()
    this.abort = null
    this.conn?.close()
    this.conn = null
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.retryTimer)
    this.teardown()
    stopAlarm()
  }
}
