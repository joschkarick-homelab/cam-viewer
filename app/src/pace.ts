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
 * Obergrenze für den Rückstand. Darüber wird gesprungen statt geregelt.
 *
 * Das ist die harte Zusage: **es wird nie ein Bild gezeigt, das älter
 * als MAX_LAG_S ist.** Wer weiter zurückliegt, überspringt die Bilder
 * dazwischen — bei einem Babyfon ist ein Sprung harmlos, ein veraltetes
 * Bild nicht.
 *
 * Der Abstand zum Zielrückstand ist Absicht. Genau hier stand einmal
 * eine 2, während gleichzeitig gar nicht geregelt wurde: der Rückstand
 * lag im Normalbetrieb ständig darüber, es wurde bei praktisch jedem
 * Segment gesprungen, und jeder Sprung kostet in Safari einen
 * Dekoder-Neustart — sichtbar als ~1 fps. Mit dem Regler davor ist der
 * Sprung der Notnagel, den man im Alltag nicht zu sehen bekommt: der
 * Rückstand pendelt sich bei TARGET_LAG_S ein und erreicht diese Grenze
 * nur, wenn wirklich zu wenig ankommt.
 */
export const MAX_LAG_S = 2.5

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

/**
 * Sicherheitsabstand beim Zurückholen der Abspielposition, in Sekunden.
 *
 * Klein genug, um nicht aufzufallen, groß genug, um die Ungenauigkeit
 * beim Suchen zu überdecken — siehe `seekTarget()`.
 */
export const SEEK_MARGIN_S = 0.1

/**
 * Wohin die Abspielposition springen muss — oder `null`, wenn sie passt.
 *
 * Gesprungen wird aus zwei Gründen:
 *
 * 1. **Zu alt.** Der Rückstand übersteigt MAX_LAG_S. Die Bilder dazwischen
 *    werden übersprungen. Das ist die wichtigere der beiden Regeln: ein
 *    Babyfon, das Vergangenheit zeigt, ist schlimmer als eines, das
 *    Bilder auslässt.
 * 2. **Aus dem Puffer gefallen.** Die Position liegt vor dem gepufferten
 *    Bereich, es gibt dort schlicht nichts zu dekodieren.
 *
 * Das Ziel ist in beiden Fällen dasselbe: TARGET_LAG_S hinter dem
 * Live-Ende. Nicht ans Live-Ende selbst — dort bliebe kein Polster, und
 * der nächste Netzhakler ließe den Puffer sofort leer laufen. Und nicht
 * an den Pufferanfang, wie es hier zwischenzeitlich stand: das gab zwar
 * das größte Polster, hieß aber im Ernstfall fünf Sekunden Rückstand.
 *
 * **Nie auf die Kante.** Der Sprung landet immer strikt IM Puffer. Ein
 * Sprung auf exakt den Pufferanfang endete in einer Endlosschleife:
 * WebKit landet beim Suchen minimal davor (9,97 statt 10,0), die
 * Bedingung war sofort wieder erfüllt, es wurde nie abgespielt. Die
 * Kachel stand bei `readyState: 4` und `paused: true` still, während
 * Daten hereinliefen — von außen nicht von einem toten Stream zu
 * unterscheiden. Chrome verdeckt das, weil es beim Suchen nach vorne
 * rundet; darauf darf man sich nicht verlassen.
 *
 * Aus demselben Grund muss das Ziel die Sprungbedingung selbst nicht
 * mehr erfüllen — sonst springt der nächste Aufruf erneut. Das hält
 * `TARGET_LAG_S < MAX_LAG_S` sicher, und der Test wacht darüber.
 */
export function seekTarget(t: number, bufStart: number, bufEnd: number): number | null {
  if (!Number.isFinite(t) || !Number.isFinite(bufStart) || !(bufEnd > bufStart)) return null

  const zuAlt = bufEnd - t > MAX_LAG_S
  const ausDemPuffer = t < bufStart
  if (!zuAlt && !ausDemPuffer) return null

  // Untere Schranke zuerst, obere zuletzt: bei einem Puffer, der kürzer
  // als der Sicherheitsabstand ist, gewinnt bufEnd.
  return Math.min(bufEnd, Math.max(bufStart + SEEK_MARGIN_S, bufEnd - TARGET_LAG_S))
}
