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

import { connectWebRTC, connectMSE, type Connection, type Transport } from './transport'
import { Watchdog, backoffMs } from './watchdog'
import { startAlarm, stopAlarm } from './keepalive'

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

export class CamTile {
  readonly el: HTMLElement
  private video: HTMLVideoElement
  private badge: HTMLElement
  private label: HTMLElement

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

    this.el.append(this.video, this.label, this.badge)
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
    this.teardown()
    this.setState('connecting')

    this.abort = new AbortController()
    const signal = this.abort.signal

    try {
      this.conn = this.transport === 'webrtc'
        ? await connectWebRTC(this.base, this.src, this.video, signal)
        : await connectMSE(this.base, this.src, this.video, signal)

      // play() kann trotz autoplay abgelehnt werden. Stumm klappt es
      // praktisch immer; den Ton schaltet der Nutzer separat frei.
      await this.video.play().catch(() => {})

      if (signal.aborted) return

      this.attempt = 0
      this.setState('live')

      this.dog = new Watchdog(this.video, this.conn, () => {
        this.setState('stalled')
        this.scheduleRetry()
      })
      this.dog.start()
    } catch {
      if (!signal.aborted) this.scheduleRetry()
    }
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
