/**
 * Selbstauskunft der App.
 *
 * Entstanden aus einer Inbetriebnahme, in der jede Fehlersuche daran
 * hing, dass jemand Werte aus den Dev-Tools abschreibt — auf dem Handy
 * und dem Fire Tablet gibt es die gar nicht. Hier sammelt die App
 * stattdessen selbst alles ein, was wir dabei je gebraucht haben.
 *
 * Aktiv nur mit `?debug=1`; im Normalbetrieb läuft davon nichts außer
 * dem Ereignisprotokoll, und das ist ein Ringpuffer über 80 Einträge.
 */

declare const __BUILD__: string

import { logEntries, startedAt } from './log'

/** Sekunden seit Seitenstart — handlicher als Uhrzeiten. */
function since(t: number): string {
  return `+${((t - startedAt) / 1000).toFixed(1)}s`
}

function env(): Record<string, unknown> {
  const nav = navigator as any
  return {
    build: typeof __BUILD__ === 'string' ? __BUILD__ : 'unbekannt',
    url: location.href,
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    // Genau die Eingangswerte der beiden Heuristiken aus main.ts —
    // damit nachvollziehbar ist, WARUM Transport und Auflösung so
    // gewählt wurden, statt es aus dem Ergebnis zu erraten.
    deviceMemory: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    hasMediaSource: 'MediaSource' in window,
    hasManagedMediaSource: 'ManagedMediaSource' in window,
    hasRTCPeerConnection: 'RTCPeerConnection' in window,
    hasWakeLock: 'wakeLock' in navigator,
    serviceWorkerControlled: !!navigator.serviceWorker?.controller,
    localStorage: {
      transport: localStorage.getItem('transport'),
      sd: localStorage.getItem('sd'),
    },
  }
}

/** Alles einsammeln und als Text ausgeben — bereit für die Zwischenablage. */
export async function collect(
  tiles: { diagnostics(): Promise<Record<string, unknown>> }[],
): Promise<string> {
  const lines: string[] = ['=== cam-viewer Diagnose ===', '']

  lines.push('-- Umgebung --')
  for (const [k, v] of Object.entries(env())) {
    lines.push(`${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
  }

  for (const tile of tiles) {
    let info: Record<string, unknown>
    try {
      info = await tile.diagnostics()
    } catch (err) {
      info = { fehler: String(err) }
    }
    lines.push('', `-- Kachel ${info.id ?? '?'} --`)
    for (const [k, v] of Object.entries(info)) {
      if (k === 'id') continue
      lines.push(`${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
    }
  }

  const events = logEntries()
  lines.push('', '-- Verlauf --')
  if (events.length === 0) lines.push('(keine Ereignisse)')
  for (const e of events) lines.push(`${since(e.t).padStart(8)} [${e.cam}] ${e.msg}`)

  return lines.join('\n')
}

/**
 * In die Zwischenablage legen, mit Rückfallebene.
 *
 * `navigator.clipboard` gibt es nur im Secure Context — und ausgerechnet
 * beim Einrichten über `http://<IP>:8091` ist der nicht gegeben. Dann
 * bleibt das Auswählen von Hand, wofür der Text sichtbar sein muss.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Anzeige aufbauen: Panel unten, Kopierknopf in der Leiste.
 *
 * Wird von main.ts nur bei `?debug=1` nachgeladen — deshalb liegt der
 * DOM-Teil hier und nicht dort.
 */
export function mountDebugPanel(
  bar: HTMLElement,
  tiles: { diagnostics(): Promise<Record<string, unknown>> }[],
) {
  const box = document.createElement('pre')
  box.className = 'debug'
  document.body.append(box)

  const copy = document.createElement('button')
  copy.textContent = '📋 Diagnose kopieren'
  copy.addEventListener('click', async (e) => {
    e.stopPropagation()
    const text = await collect(tiles)
    if (await copyToClipboard(text)) {
      copy.textContent = '✓ kopiert'
      setTimeout(() => (copy.textContent = '📋 Diagnose kopieren'), 2000)
    } else {
      // Ohne Secure Context gibt es keine Zwischenablage. Dann wenigstens
      // markierbar anzeigen, statt den Nutzer im Regen stehen zu lassen.
      box.textContent = text
      box.classList.add('full')
      copy.textContent = 'Text markieren und kopieren'
    }
  })
  bar.append(copy)

  const tick = async () => {
    if (box.classList.contains('full')) return
    box.textContent = await collect(tiles)
  }
  void tick()
  setInterval(() => void tick(), 1000)
}
