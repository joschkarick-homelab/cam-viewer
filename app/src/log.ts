/**
 * Ereignisprotokoll — winziger Ringpuffer, immer aktiv.
 *
 * Bewusst getrennt von `diagnostics.ts`: das Protokollieren passiert im
 * Normalbetrieb (Zustandswechsel, Fehlversuche), das Auswerten nur auf
 * Anforderung. So bleibt der ausgewertete Teil aus dem Hauptbundle
 * heraus und wird erst bei `?debug=1` nachgeladen.
 */

export interface LogEntry {
  t: number
  cam: string
  msg: string
}

const LOG_MAX = 80
const entries: LogEntry[] = []

export const startedAt = Date.now()

/**
 * Hält fest, was passiert ist — mit Zeitstempel.
 *
 * Der Verlauf ist oft aussagekräftiger als der Einzelwert: ob eine
 * Kachel alle 15 s neu verbindet oder einmalig scheiterte, sieht man
 * nur daran.
 */
export function logEvent(cam: string, msg: string) {
  entries.push({ t: Date.now(), cam, msg })
  if (entries.length > LOG_MAX) entries.shift()
}

export function logEntries(): readonly LogEntry[] {
  return entries
}
