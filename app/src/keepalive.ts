/**
 * Bildschirm anhalten und akustisch alarmieren.
 */

// ── Wake Lock ───────────────────────────────────────────────────────

let lock: any = null

/**
 * Hält den Bildschirm an.
 *
 * Der Lock geht verloren, sobald der Tab in den Hintergrund wandert —
 * und kommt NICHT von selbst zurück. Ohne das erneute Anfordern bei
 * `visibilitychange` geht das Display nach dem ersten App-Wechsel
 * wieder aus, was man beim Testen leicht übersieht.
 */
export async function keepScreenOn() {
  const request = async () => {
    try {
      lock = await (navigator as any).wakeLock?.request('screen')
    } catch {
      // Kann fehlschlagen, wenn die Seite gerade nicht sichtbar ist.
      // Kein Grund zur Panik — beim nächsten visibilitychange erneut.
    }
  }

  await request()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && lock?.released !== false) void request()
  })
}

export const wakeLockSupported = 'wakeLock' in navigator

// ── Alarm ───────────────────────────────────────────────────────────

let ctx: AudioContext | null = null
let alarmTimer: number | undefined

/**
 * Muss aus einer echten Nutzergeste heraus laufen (Tap/Klick), sonst
 * bleibt der AudioContext gesperrt. Wir hängen das an denselben Tap,
 * mit dem der Nutzer den Ton freigibt.
 */
export function unlockAudio() {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
}

/**
 * Piept im Sekundentakt, bis `stopAlarm()` kommt.
 *
 * Bewusst ein synthetischer Ton statt einer Audiodatei: kein zusätzlicher
 * Request, kein Ladefehler im ungünstigsten Moment, und er funktioniert
 * auch, wenn der Stream gerade die ganze Bandbreite frisst.
 */
export function startAlarm() {
  if (alarmTimer !== undefined || !ctx) return
  const beep = () => {
    if (!ctx) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.3)
  }
  beep()
  alarmTimer = window.setInterval(beep, 1200)
}

export function stopAlarm() {
  clearInterval(alarmTimer)
  alarmTimer = undefined
}
