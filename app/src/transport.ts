/**
 * Transport-Schicht: holt einen Stream aus go2rtc in ein <video>-Element.
 *
 * Zwei Wege, bewusst getrennt:
 *
 *   WebRTC  — ~0,3 s Latenz, Medien fließen direkt zu go2rtc:8555.
 *             Geht nur im LAN, weil der Port am Reverse Proxy vorbeiläuft.
 *
 *   MSE     — ~1 s Latenz, alles über die bestehende HTTPS/WSS-Verbindung.
 *             Damit auch von außen durch authentik hindurch nutzbar,
 *             ohne einen zweiten Port aufzumachen.
 *
 * Die Auswahl trifft nicht der Nutzer, sondern `pickTransport()` in main.ts.
 */

export type Transport = 'webrtc' | 'mse'

/** Was ein Transport nach außen anbietet — bewusst minimal. */
export interface Connection {
  /** Für den Watchdog: dekodierte Frames seit Verbindungsaufbau, oder null wenn unbekannt. */
  framesDecoded(): Promise<number | null>
  close(): void
}

// ── WebRTC ──────────────────────────────────────────────────────────

export async function connectWebRTC(
  base: string,
  src: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<Connection> {
  const pc = new RTCPeerConnection({
    // Im LAN brauchen wir keinen STUN — die Host-Kandidaten aus
    // go2rtc.yaml reichen. Spart einen externen Roundtrip beim Start
    // und macht den Verbindungsaufbau spürbar schneller.
    iceServers: [],
    bundlePolicy: 'max-bundle',
  })

  const cleanup = () => {
    pc.getReceivers().forEach((r) => r.track?.stop())
    pc.close()
  }
  signal.addEventListener('abort', cleanup, { once: true })

  // Der Medienpfad kann scheitern, ohne dass irgendetwas wirft: POST
  // /api/webrtc liefert brav eine SDP-Answer, die Kachel geht kurz auf
  // "Live", und erst der Watchdog merkt, dass nie ein Bild kommt. In
  // den Dev-Tools steht dann nur ein erfolgreicher 200er.
  //
  // Typische Ursache im LAN: webrtc.candidates in go2rtc.yaml zeigt auf
  // die falsche IP, oder Port 8555 ist nicht erreichbar. Beides sieht
  // man nur hier.
  pc.addEventListener('iceconnectionstatechange', () => {
    const s = pc.iceConnectionState
    if (s === 'failed' || s === 'disconnected') {
      console.warn(
        `[cam-viewer/${src}] ICE ${s} — kein Medienpfad zu go2rtc:8555. ` +
        `Prüfen: webrtc.candidates in go2rtc.yaml und Erreichbarkeit von Port 8555.`,
      )
    }
  })

  const stream = new MediaStream()
  pc.addEventListener('track', (ev) => {
    stream.addTrack(ev.track)
    // Erst zuweisen, wenn wirklich ein Track da ist. Ein leerer
    // MediaStream lässt manche Browser auf "playing" gehen, obwohl
    // nie ein Bild kommt — genau der Fehlerfall, den wir nicht wollen.
    video.srcObject = stream
  })

  // recvonly: wir empfangen nur. Der Mikrofon-Rückkanal läuft später
  // über go2rtcs WebSocket-Signaling, nicht über diesen POST-Weg.
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })

  await pc.setLocalDescription(await pc.createOffer())
  await gatheringComplete(pc, signal)
  if (signal.aborted) throw new Error('abgebrochen')

  const res = await fetch(`${base}/api/webrtc?src=${encodeURIComponent(src)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'offer', sdp: pc.localDescription!.sdp }),
    signal,
    credentials: 'include', // authentik-Session mitschicken
  })
  if (!res.ok) throw new Error(`go2rtc antwortete ${res.status}`)

  const answer = await res.json()
  if (!answer?.sdp) throw new Error('keine SDP-Answer erhalten')
  await pc.setRemoteDescription({ ...answer, sdp: dropBrokenCandidates(answer.sdp) })

  return {
    async framesDecoded() {
      const stats = await pc.getStats()
      let frames: number | null = null
      stats.forEach((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          frames = r.framesDecoded ?? null
        }
      })
      return frames
    },
    close: cleanup,
  }
}

/**
 * Wirft unbrauchbare `a=candidate:`-Zeilen aus der Answer.
 *
 * Der Browser parst das SDP als Ganzes: EINE fehlerhafte Zeile lässt
 * `setRemoteDescription` scheitern — und damit nicht nur den einen Pfad,
 * sondern die komplette Verbindung. Alle Kacheln bleiben schwarz.
 *
 * go2rtcs eigener Player merkt davon nichts, weil er Trickle-ICE über
 * WebSocket nutzt: dort kommt jeder Kandidat einzeln, ein schlechter
 * fällt allein durch. Über den POST-Weg stehen alle in einem Dokument,
 * also reißt einer alle mit.
 *
 * Konkreter Auslöser war ein `/tcp`-Suffix in `webrtc.candidates`, das
 * go2rtc ungeprüft als Portnummer ins SDP schreibt ("8555/tcp"). Das
 * gehört in der Config korrigiert — diese Funktion ist kein Ersatz
 * dafür, sondern die Zusicherung, dass ein Vertipper dort höchstens
 * einen Netzwerkpfad kostet und nicht das ganze Bild.
 */
function dropBrokenCandidates(sdp: string): string {
  const PREFIX = 'a=candidate:'
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith(PREFIX)) return true
      // <foundation> <component> <transport> <priority> <address> <port> typ …
      const port = line.slice(PREFIX.length).split(' ')[5]
      if (/^\d+$/.test(port ?? '')) return true
      console.warn(`[cam-viewer] ICE-Kandidat verworfen, Port unbrauchbar: ${line}`)
      return false
    })
    .join('\r\n')
}

/**
 * Wartet, bis alle ICE-Kandidaten gesammelt sind — mit Deckel.
 *
 * Ohne Timeout hängt der Verbindungsaufbau, wenn ein Kandidat nicht
 * auflösbar ist (z.B. ein STUN-Server im Gastnetz). 800 ms reichen im
 * LAN dreifach; danach schicken wir, was wir haben.
 */
function gatheringComplete(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => pc.iceGatheringState === 'complete' && done()
    const timer = setTimeout(done, 800)
    pc.addEventListener('icegatheringstatechange', onChange)
    signal.addEventListener('abort', done, { once: true })
  })
}

// ── MSE über WebSocket ──────────────────────────────────────────────

// ManagedMediaSource gibt es auf iOS ab 17.1 — davor kann iPhone-Safari
// kein MSE. Dort greift als letzte Stufe HLS (siehe main.ts).
const MediaSourceImpl: typeof MediaSource | undefined =
  (window as any).ManagedMediaSource ?? (window as any).MediaSource

export const mseSupported = !!MediaSourceImpl

/** Codecs, die go2rtc anbieten kann — gefiltert auf das, was dieser Browser wirklich kann. */
function supportedCodecs(): string {
  const candidates = [
    'avc1.640029', 'avc1.64002A', 'avc1.640033', // H.264 High
    'avc1.42E01E',                                // H.264 Baseline (Fire Tablet)
    'hvc1.1.6.L153.B0',                           // HEVC
    'mp4a.40.2', 'mp4a.40.5',                     // AAC
    'flac', 'opus',
  ]
  return candidates
    .filter((c) => MediaSourceImpl!.isTypeSupported(`video/mp4; codecs="${c}"`))
    .join()
}

export async function connectMSE(
  base: string,
  src: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<Connection> {
  if (!MediaSourceImpl) throw new Error('MSE wird von diesem Browser nicht unterstützt')

  const wsBase = base
    ? base.replace(/^http/, 'ws')
    : location.origin.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsBase}/api/ws?src=${encodeURIComponent(src)}`)
  ws.binaryType = 'arraybuffer'

  const ms = new MediaSourceImpl()
  // ManagedMediaSource will explizit "airplay: deny", sonst zeigt iOS
  // einen AirPlay-Button, der den Stream abreißen lässt.
  video.disableRemotePlayback = true
  video.src = URL.createObjectURL(ms as MediaSource)

  const cleanup = () => {
    ws.close()
    URL.revokeObjectURL(video.src)
    video.removeAttribute('src')
    video.load()
  }
  signal.addEventListener('abort', cleanup, { once: true })

  let sb: SourceBuffer | null = null
  const queue: ArrayBuffer[] = []

  const flush = () => {
    if (!sb || sb.updating || queue.length === 0) return
    try {
      sb.appendBuffer(queue.shift()!)
    } catch {
      // QuotaExceeded: der Puffer ist voll. Wir schneiden alles ab, was
      // hinter der aktuellen Position liegt — bei einem Livestream ist
      // die Vergangenheit wertlos.
      try {
        if (video.currentTime > 5) sb.remove(0, video.currentTime - 2)
      } catch { /* ignorieren, nächster Versuch */ }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const fail = (e: unknown) => reject(e instanceof Error ? e : new Error('WebSocket-Fehler'))
    ws.addEventListener('error', fail, { once: true })
    ws.addEventListener('close', () => reject(new Error('WebSocket geschlossen')), { once: true })
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'mse', value: supportedCodecs() }))
    })
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data)
        if (msg.type !== 'mse') return
        const attach = () => {
          sb = ms.addSourceBuffer(msg.value)
          sb.mode = 'segments'
          sb.addEventListener('updateend', flush)
          resolve()
        }
        ms.readyState === 'open'
          ? attach()
          : ms.addEventListener('sourceopen', attach, { once: true })
        return
      }
      queue.push(ev.data as ArrayBuffer)
      flush()
    })
    signal.addEventListener('abort', () => reject(new Error('abgebrochen')), { once: true })
  })

  return {
    // MSE liefert keine Frame-Zähler. Der Watchdog fällt hier auf
    // video.currentTime zurück, was für diesen Pfad ausreicht.
    async framesDecoded() {
      return null
    },
    close: cleanup,
  }
}
