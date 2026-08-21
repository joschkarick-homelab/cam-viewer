/**
 * Der komplette Icon-Satz der App — eine Handvoll Inline-SVGs.
 *
 * Bewusst KEINE Emoji: die fallen auf jedem Gerät anders aus, auf dem
 * Fire Tablet als bunte Fremdkörper, und machen die Oberfläche unruhig.
 * SVGs sehen überall gleich aus, färben sich über `currentColor` mit dem
 * umgebenden Text und dimmen mit, wenn ein Element gedämpft wird.
 *
 * Alle Pfade auf einem 24er-Raster, Strichstärke 1.8 — wer hier ein
 * Icon ergänzt, hält sich daran, sonst sieht es neben den anderen
 * sofort fremd aus.
 */

const PATHS = {
  /** Lautsprecher mit Schallwellen — Ton läuft. */
  sound:
    '<path d="M4 9.5v5h3.2L12 18.7V5.3L7.2 9.5H4z"/>' +
    '<path d="M15 9a4.2 4.2 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M17.5 6.8a7.5 7.5 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  /** Lautsprecher mit Kreuz — stumm. */
  muted:
    '<path d="M4 9.5v5h3.2L12 18.7V5.3L7.2 9.5H4z"/>' +
    '<path d="M15.5 9.7l4.6 4.6m0-4.6l-4.6 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  /** Bildschirm — Wake Lock. */
  screen:
    '<rect x="3" y="5" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M9 20h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  /** Bild-in-Bild: Rahmen mit eingesetztem Fenster. */
  pip:
    '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<rect x="12" y="12" width="7" height="5" rx="1"/>',
  /** Kreuz — ausblenden/schließen. */
  hide:
    '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  /** Durchgestrichene Kamera — ausgeblendet, wird nicht überwacht. */
  camoff:
    '<path d="M4 7h9a1 1 0 0 1 1 1v2.2l4-2.4v8.4l-4-2.4V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" ' +
    'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<path d="M4.5 4.5l15 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
}

export type IconName = keyof typeof PATHS

export function icon(name: IconName, size = 16): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `aria-hidden="true" fill="currentColor">${PATHS[name]}</svg>`
  )
}
