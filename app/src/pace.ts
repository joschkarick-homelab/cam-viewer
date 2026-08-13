/**
 * Tempo-Regelung für den MSE-Livepuffer.
 *
 * Eigenes Modul, weil das der Teil ist, der zweimal falsch war und der
 * sich als einziger ohne Browser prüfen lässt — siehe pace.test.ts. Der
 * Rest von transport.ts hängt an `window` und ist nur auf echten Geräten
 * zu beurteilen.
 */

/**
 * So viel Vergangenheit bleibt im Puffer stehen — und so groß ist das
 * Polster, auf das wir zurückfallen, wenn die Position herausrutscht.
 */
export const LIVE_WINDOW_S = 5

/**
 * Gewünschter Rückstand zum Live-Ende, in Sekunden.
 *
 * Das ist das Polster, aus dem der Dekoder zehrt, wenn das Netz kurz
 * hakt. Eine Sekunde ist bei einer Babycam nicht spürbar; ein leerer
 * Puffer dagegen sehr.
 */
export const TARGET_LAG_S = 1

/**
 * Untere Schranke: bei 0,1 läuft das Bild in Zeitlupe weiter, statt
 * stehen zu bleiben — der Puffer bekommt Zeit, sich zu füllen.
 */
export const MIN_RATE = 0.1

/**
 * Obere Schranke. go2rtcs Player deckelt gar nicht und holt notfalls mit
 * fünffacher Geschwindigkeit auf. Das konvergiert schneller, klingt beim
 * Ton aber schauerlich. Bei doppelter Geschwindigkeit ist ein volles
 * Fenster in fünf Sekunden abgebaut, das reicht.
 */
export const MAX_RATE = 2

/**
 * Abspielrate aus dem Rückstand zum Live-Ende.
 *
 * Ein Regler, kein Schalter: Rate = Rückstand / Zielrückstand. Bei einer
 * Sekunde Rückstand ergibt das exakt 1,0, darüber wird aufgeholt,
 * DARUNTER WIRD GEBREMST.
 *
 * Der letzte Punkt ist der entscheidende und war zweimal falsch. Vorher
 * stand in transport.ts sinngemäß
 *
 *     rate = rückstand > 2 ? 1.05 : 1
 *
 * — also volles Tempo bis zum Schluss. Wer mit 1,0 weiterspielt, während
 * der Puffer leer läuft, läuft ihn garantiert leer: das Bild bleibt
 * stehen, wartet auf das nächste Segment, ruckt weiter, und das bei
 * jedem Netzhakler von neuem. Auf dem iPhone war das Dauerzustand,
 * während go2rtcs eigener Player auf demselben Gerät flüssig lief — er
 * regelt genau so wie diese Funktion.
 *
 * Ein unbrauchbarer Wert ergibt 1,0: lieber normal weiterspielen als
 * wegen einer NaN in Zeitlupe verfallen.
 */
export function liveRate(gap: number): number {
  if (!Number.isFinite(gap)) return 1
  return Math.min(MAX_RATE, Math.max(MIN_RATE, gap / TARGET_LAG_S))
}
