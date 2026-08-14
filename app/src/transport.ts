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

import { LIVE_WINDOW_S, liveRate, seekTarget } from './pace'

export type Transport = 'webrtc' | 'mse'

/**
 * Liest Profil, Kompatibilität und Level aus der `avcC`-Box eines
 * fMP4-Init-Segments — also aus dem, was der Bitstrom wirklich sagt.
 *
 * Aufbau: `[4 Byte Größe]['avcC'][Version][Profil][Kompat][Level]…`
 */
function avcProfileFromInit(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf)
  for (let i = 0; i + 8 < b.length; i++) {
    // 'avcC'
    if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x43) {
      return [b[i + 5], b[i + 6], b[i + 7]]
        .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
        .join('')
    }
  }
  return null
}

/**
 * Korrigiert den von go2rtc gemeldeten H.264-Codec-String.
 *
 * go2rtc leitet ihn aus der fmtp-Zeile der Quelle ab — die `tapo://`
 * aber gar nicht liefert (`pkg/tapo/producer.go` legt den Codec ohne
 * FmtpLine an). `GetProfileLevelID("")` fällt dann auf fest verdrahtete
 * Werte zurück und meldet für JEDE Tapo-Cam `avc1.640029`, also High
 * 4.1 — unabhängig davon, was die Kamera wirklich kodiert.
 *
 * Safari prüft den deklarierten String gegen die SPS im Bitstrom und
 * lehnt bei Abweichung mit MEDIA_ERR_DECODE ab; Chrome sieht darüber
 * hinweg. Genau das war die Ursache für "läuft in Chrome, nicht in
 * Safari".
 *
 * Der Audio-Teil bleibt unangetastet, falls go2rtc einen mitschickt.
 */
function correctH264Codec(mime: string, init: ArrayBuffer): string {
  const real = avcProfileFromInit(init)
  if (!real) return mime
  return mime.replace(/avc1\.[0-9A-Fa-f]{6}/, `avc1.${real}`)
}

/**
 * Wert für die Diagnose holen, ohne dass ein Fehler alles mitreißt.
 *
 * Genau die Eigenschaften, die man bei einem Problem lesen will, sind
 * die, die im Problemfall werfen — `sb.buffered` etwa, sobald der
 * SourceBuffer abgelöst wurde.
 */
export function safe<T>(fn: () => T): T | string {
  try {
    return fn()
  } catch (err) {
    return `<Fehler: ${err instanceof Error ? err.message : String(err)}>`
  }
}

/** Gepufferte Bereiche lesbar machen — "48123.4–48128.9" statt eines TimeRanges-Objekts. */
export function describeRanges(r: TimeRanges): string {
  if (!r.length) return 'leer'
  const parts: string[] = []
  for (let i = 0; i < r.length; i++) parts.push(`${r.start(i).toFixed(1)}–${r.end(i).toFixed(1)}`)
  return parts.join(', ')
}

/** Was ein Transport nach außen anbietet — bewusst minimal. */
export interface Connection {
  /** Für den Watchdog: dekodierte Frames seit Verbindungsaufbau, oder null wenn unbekannt. */
  framesDecoded(): Promise<number | null>
  /**
   * Innenansicht für die Diagnose (`?debug=1`).
   *
   * Alles, was man bei einem stummen Fehler wissen will, ohne raten zu
   * müssen: Zustände, Zähler, ausgehandelte Codecs. Wird nur auf
   * Anforderung erhoben, kostet im Normalbetrieb also nichts.
   */
  diagnostics(): Promise<Record<string, unknown>>
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

    async diagnostics() {
      const out: Record<string, unknown> = {
        transport: 'webrtc',
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        connectionState: pc.connectionState,
        signalingState: pc.signalingState,
      }
      try {
        const stats = await pc.getStats()
        stats.forEach((r: any) => {
          if (r.type === 'inbound-rtp') {
            out[`inbound-${r.kind}`] = {
              bytesReceived: r.bytesReceived,
              packetsReceived: r.packetsReceived,
              packetsLost: r.packetsLost,
              framesDecoded: r.framesDecoded,
              frameWidth: r.frameWidth,
              frameHeight: r.frameHeight,
            }
          }
          // Verrät, WELCHER Kandidat gewonnen hat — bei Problemen mit
          // webrtc.candidates die entscheidende Zeile.
          if (r.type === 'candidate-pair' && r.state === 'succeeded') {
            out.candidatePair = {
              localCandidateId: r.localCandidateId,
              remoteCandidateId: r.remoteCandidateId,
              currentRoundTripTime: r.currentRoundTripTime,
            }
          }
          if (r.type === 'remote-candidate') {
            out[`remoteCandidate-${r.id}`] =
              `${r.protocol} ${r.address}:${r.port} ${r.candidateType}`
          }
        })
      } catch (err) {
        out.statsError = String(err)
      }
      return out
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

/**
 * Safari (macOS wie iOS, ab 17) bringt ManagedMediaSource mit, Chrome
 * nicht. Die beiden verhalten sich beim Anhängen und beim Öffnen
 * unterschiedlich genug, dass wir das an mehreren Stellen wissen müssen.
 */
const managedMediaSource = 'ManagedMediaSource' in window

/**
 * Deckel für die Warteschlange, in Bytes.
 *
 * Sie füllt sich nur, solange der SourceBuffer beschäftigt ist. Nimmt er
 * dauerhaft nichts mehr an, wüchse sie ohne Grenze — auf einem iPhone
 * beendet Safari den Tab dann irgendwann wegen Speicherdrucks, und zwar
 * ohne jede Meldung. Ein verworfenes Segment kostet kurz Artefakte, ein
 * beendeter Tab die ganze Nacht.
 */
const MAX_QUEUE_BYTES = 4 * 1024 * 1024

export const mseSupported = !!MediaSourceImpl

/** Codecs, die go2rtc anbieten kann — gefiltert auf das, was dieser Browser wirklich kann. */
function supportedCodecs(): string {
  // Bewusst Zeichen für Zeichen die Liste aus go2rtcs eigenem Player
  // (www/video-rtc.js, CODECS). Wir hatten hier zusätzlich
  // 'avc1.42E01E' (H.264 Baseline) stehen, gedacht fürs Fire Tablet.
  // Verdacht: bietet der Client Baseline an, während die Kamera High
  // liefert, kann go2rtc den Stream mit dem falschen Profil etikettieren
  // — und Safari lehnt so etwas mit MEDIA_ERR_DECODE ab, wo Chrome
  // großzügig ist. H.264 handelt go2rtc ohnehin aus, die Zeile war also
  // nie nötig.
  const candidates = [
    'avc1.640029', 'avc1.64002A', 'avc1.640033', // H.264 High 4.1/4.2/5.1
    'hvc1.1.6.L153.B0',                           // HEVC
    'mp4a.40.2', 'mp4a.40.5',                     // AAC LC / HE
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

  const cleanup = () => {
    ws.close()
    if (managedMediaSource) {
      video.srcObject = null
    } else {
      URL.revokeObjectURL(video.src)
      video.removeAttribute('src')
    }
    video.load()
  }
  signal.addEventListener('abort', cleanup, { once: true })

  let sb: SourceBuffer | null = null
  const queue: ArrayBuffer[] = []

  // Nur für die Diagnose. "Bytes fließen, aber buffered ist leer" war
  // heute der Befund, der die Ursache eingegrenzt hat — den will man
  // nicht jedes Mal aus dem Netzwerk-Tab ablesen müssen.
  let bytesReceived = 0
  let chunksAppended = 0
  let chunksDropped = 0
  let queuedBytes = 0
  let lastGap: number | null = null
  let negotiatedCodecs = ''
  // Was wir daraus gemacht haben — die Diagnose soll beides zeigen.
  let effectiveCodecs = ''

  /**
   * Segment einreihen und dabei den Deckel einhalten.
   *
   * Verworfen wird von vorne: das älteste Segment ist das, dessen
   * Anzeigezeitpunkt am weitesten zurückliegt — bei einem Livebild also
   * das mit Abstand wertloseste.
   */
  const enqueue = (chunk: ArrayBuffer) => {
    queue.push(chunk)
    queuedBytes += chunk.byteLength
    while (queuedBytes > MAX_QUEUE_BYTES && queue.length > 1) {
      queuedBytes -= queue.shift()!.byteLength
      chunksDropped++
    }
  }

  const flush = () => {
    if (!sb || sb.updating || queue.length === 0) return
    const chunk = queue.shift()!
    queuedBytes -= chunk.byteLength
    try {
      sb.appendBuffer(chunk)
      chunksAppended++
    } catch {
      // QuotaExceeded: der Puffer ist voll. Wir schneiden alles ab, was
      // hinter der aktuellen Position liegt — bei einem Livestream ist
      // die Vergangenheit wertlos.
      try {
        if (video.currentTime > 5) sb.remove(0, video.currentTime - 2)
      } catch { /* ignorieren, nächster Versuch */ }
    }
  }

  /**
   * Vergangenheit wegschneiden, Position im Fenster halten, Tempo regeln.
   *
   * Drei Aufgaben, die zusammengehören, weil alle drei am selben
   * gepufferten Bereich hängen.
   *
   * **Position.** Die Segmente tragen die Zeitachse der Kamera, nicht
   * unsere: der Puffer beginnt womöglich bei Sekunde 48000, während
   * `video.currentTime` auf 0 steht. Die Abspielposition läge damit
   * außerhalb des Puffers und das Element fängt nie an — Daten kommen an,
   * es passiert trotzdem nichts. Chrome bügelt das still aus, Safari
   * nicht; genau dieser Unterschied hat uns "Daten fließen, kein Bild"
   * beschert.
   *
   * **Tempo.** Übernimmt `liveRate()` aus pace.ts — dort steht auch,
   * warum ein Regler und kein Schalter.
   *
   * Zurückgeholt wird die Position nur, wenn sie aus dem Puffer gefallen
   * ist, und dann an dessen Anfang statt ans Live-Ende — `seekTarget()`
   * in pace.ts entscheidet das und begründet den Sicherheitsabstand.
   * Vorher sprang diese Funktion auf `bufEnd - 0.5`; das klingt richtiger,
   * lässt aber ein halbes Polster übrig, und der nächste Netzhakler kommt
   * bestimmt.
   *
   * **Schneiden.** Ohne Wegschneiden wächst der Puffer bis zum
   * QuotaExceeded; bei einem Livestream ist alles außer den letzten
   * Sekunden ohnehin wertlos.
   */
  const pace = () => {
    if (!sb || sb.updating || !sb.buffered.length) return

    const bufEnd = sb.buffered.end(sb.buffered.length - 1)
    const keepFrom = bufEnd - LIVE_WINDOW_S

    // Erst schneiden, dann rechnen: danach steht fest, wo das Fenster
    // wirklich beginnt.
    if (keepFrom > sb.buffered.start(0)) {
      try {
        sb.remove(sb.buffered.start(0), keepFrom)
        ms.setLiveSeekableRange?.(keepFrom, bufEnd)
      } catch { /* nächster Durchlauf */ }
    }

    const target = seekTarget(video.currentTime, sb.buffered.start(0), bufEnd)
    if (target !== null) video.currentTime = target

    // Ein pausiertes Element holt sich von selbst nichts mehr.
    //
    // `play()` läuft einmal beim Aufbau — und lehnt der Browser dort ab,
    // versuchte es bisher nie wieder jemand. Bei ManagedMediaSource ist
    // das ein Rennen: play() kommt, bevor überhaupt Daten da sind. Auf
    // dem iPhone stand deshalb eine Kachel bei `readyState: 4` mit
    // `paused: true` — volle Puffer, kein Bild.
    if (video.paused && video.readyState >= 2) void video.play().catch(() => {})

    const gap = bufEnd - video.currentTime
    const rate = liveRate(gap)
    // Nur bei echter Abweichung zuweisen. Jede Zuweisung feuert
    // `ratechange`, und das mehrmals pro Sekunde je Kachel ist auf einem
    // iPhone spürbar.
    if (Math.abs(video.playbackRate - rate) > 0.02) video.playbackRate = rate
    lastGap = gap
  }

  // Erst nachschieben, dann aufräumen — remove() setzt `updating`, der
  // nächste updateend erledigt dann wieder das Anhängen.
  const onUpdateEnd = () => { flush(); pace() }

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const done = () => { settled = true; resolve() }

    /**
     * Jeder Fehler landet hier — auch die aus den Event-Handlern.
     *
     * Ohne das fällt z.B. ein InvalidStateError aus dem
     * message-Handler als "uncaught" daneben: die Promise bliebe offen,
     * der Aufbau liefe stumm in den Timeout, und in der Konsole stünde
     * ein Fehler ohne erkennbaren Bezug zur Kachel.
     */
    const fail = (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e))
      if (settled) {
        console.warn(`[cam-viewer/${src}] MSE-Fehler nach dem Aufbau:`, err)
        return
      }
      settled = true
      reject(err)
    }

    ws.addEventListener('error', () => fail(new Error('WebSocket-Fehler')), { once: true })
    ws.addEventListener('close', () => fail(new Error('WebSocket geschlossen')), { once: true })
    signal.addEventListener('abort', () => fail(new Error('abgebrochen')), { once: true })

    // Die Codecliste geht erst raus, wenn BEIDE Seiten bereit sind: der
    // Socket offen und die MediaSource geöffnet. Die Reihenfolge ist
    // nicht vorhersagbar, deshalb das Gatter statt einer Annahme.
    let wsOpen = false
    let sourceOpen = false
    const requestCodecs = () => {
      if (!wsOpen || !sourceOpen) return
      ws.send(JSON.stringify({ type: 'mse', value: supportedCodecs() }))
    }

    ws.addEventListener('open', () => { wsOpen = true; requestCodecs() })

    ws.addEventListener('message', (ev) => {
      try {
        if (typeof ev.data === 'string') {
          const msg = JSON.parse(ev.data)
          if (msg.type !== 'mse') return
          // addSourceBuffer() wirft InvalidStateError, wenn die
          // MediaSource nicht (mehr) offen ist. Bei ManagedMediaSource
          // ist das keine Theorie: sie schließt wieder, sobald das
          // Element gerade keine Daten braucht.
          if (ms.readyState !== 'open') {
            throw new Error(`MediaSource ist "${ms.readyState}" statt "open"`)
          }
          // Nur merken. Der SourceBuffer entsteht erst mit dem ersten
          // Binärblock — das ist das Init-Segment, und nur dort steht,
          // welches H.264-Profil wirklich anliegt.
          negotiatedCodecs = msg.value
          return
        }

        const chunk = ev.data as ArrayBuffer
        bytesReceived += chunk.byteLength

        if (!sb) {
          if (!negotiatedCodecs) throw new Error('Binärdaten vor der Codec-Aushandlung')
          if (ms.readyState !== 'open') {
            throw new Error(`MediaSource ist "${ms.readyState}" statt "open"`)
          }
          effectiveCodecs = correctH264Codec(negotiatedCodecs, chunk)
          try {
            sb = ms.addSourceBuffer(effectiveCodecs)
          } catch (err) {
            // Lieber go2rtcs Angabe versuchen als gar nichts — dann
            // scheitert es wie bisher, aber nicht schlimmer.
            console.warn(
              `[cam-viewer/${src}] "${effectiveCodecs}" abgelehnt, versuche "${negotiatedCodecs}":`,
              err,
            )
            effectiveCodecs = negotiatedCodecs
            sb = ms.addSourceBuffer(negotiatedCodecs)
          }
          sb.mode = 'segments'
          sb.addEventListener('updateend', onUpdateEnd)
          done()
        }

        enqueue(chunk)
        flush()
      } catch (err) {
        fail(err)
      }
    })

    // Reihenfolge ist hier entscheidend: erst den sourceopen-Listener,
    // DANN anhängen und abspielen. Bei ManagedMediaSource kann das
    // Ereignis unmittelbar nach dem Anhängen feuern — registrierten wir
    // den Listener erst danach, verpassten wir es und warteten ewig.
    const onSourceOpen = () => { sourceOpen = true; requestCodecs() }
    if (ms.readyState === 'open') onSourceOpen()
    else ms.addEventListener('sourceopen', onSourceOpen, { once: true })

    // ManagedMediaSource (Safari ab 17) verlangt srcObject; über
    // createObjectURL feuert dort kein sourceopen. Chrome kennt nur die
    // klassische MediaSource und braucht die Object-URL.
    if (managedMediaSource) {
      video.srcObject = ms as unknown as MediaProvider
    } else {
      video.src = URL.createObjectURL(ms as MediaSource)
      video.srcObject = null
    }

    // Muss vor dem Warten auf sourceopen passieren: ManagedMediaSource
    // öffnet sich erst, wenn das Element tatsächlich Daten anfordert.
    void video.play().catch(() => {})
  })

  return {
    // MSE liefert keine Frame-Zähler. Der Watchdog fällt hier auf
    // video.currentTime zurück, was für diesen Pfad ausreicht.
    async framesDecoded() {
      return null
    },

    async diagnostics() {
      // Jeder Wert einzeln abgesichert. Ein `sb.buffered` auf einem
      // abgelösten SourceBuffer wirft InvalidStateError — und riss
      // vorher den GESAMTEN Abschnitt mit, ausgerechnet inklusive
      // negotiatedCodecs. Eine Diagnose, die beim ersten Fehler
      // aufgibt, ist genau dann nutzlos, wenn man sie braucht.
      return {
        transport: 'mse',
        managedMediaSource,
        wsReadyState: safe(() =>
          ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] ?? ws.readyState),
        mediaSourceReadyState: safe(() => ms.readyState),
        negotiatedCodecs,
        effectiveCodecs,
        offeredCodecs: safe(() => supportedCodecs()),
        bytesReceived,
        chunksAppended,
        chunksDropped,
        queued: queue.length,
        queuedBytes,
        sourceBufferUpdating: safe(() => sb?.updating ?? null),
        sourceBufferRanges: safe(() => (sb ? describeRanges(sb.buffered) : null)),
        // Die vier Zeilen, an denen man Ruckeln erkennt, ohne zu raten:
        // ein Rückstand nahe null bei readyState < 3 heißt "Puffer leer
        // gelaufen", eine Rate dauerhaft am unteren Anschlag heißt "es
        // kommt zu wenig nach".
        lastGap: lastGap === null ? null : Number(lastGap.toFixed(2)),
        playbackRate: safe(() => Number(video.playbackRate.toFixed(2))),
        currentTime: safe(() => Number(video.currentTime.toFixed(1))),
        videoReadyState: safe(() =>
          ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][
            video.readyState
          ] ?? video.readyState),
      }
    },
    close: cleanup,
  }
}
