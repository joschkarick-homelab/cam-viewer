/**
 * Rauchtest: App headless laden und die Diagnose auslesen.
 *
 * Prüft, was ein Build allein nicht zeigt — dass die Kacheln ihren
 * Fehlerpfad sauber durchlaufen, das Diagnose-Panel sich füllt und der
 * Verlauf die Backoff-Zeiten protokolliert. Läuft ohne go2rtc; die
 * Verbindungen SOLLEN scheitern.
 *
 * Playwright steht bewusst NICHT in package.json — es würde sonst bei
 * jedem Docker-Build mitinstalliert, ohne dort je gebraucht zu werden.
 *
 *   cd app
 *   npm run build && npm i -D playwright
 *   (cd dist && python3 -m http.server 8099 &)
 *   node smoke.mjs
 *
 * Liegt bewusst neben package.json — Node löst ESM-Importe relativ zum
 * Skript auf, aus einem tools/ am Repo-Wurzelverzeichnis fände es
 * playwright nicht.
 *
 * Deckt nur Chromium ab. Safari/WebKit geht so nicht — und genau dort
 * saßen die hartnäckigsten Fehler. Der Test ersetzt also keinen Blick
 * auf echte Geräte, er fängt Regressionen.
 */

import { chromium } from 'playwright'

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.goto('http://127.0.0.1:8099/?debug=1', { waitUntil: 'load' })
// Verbindungen dürfen scheitern — genau das wollen wir sehen.
await page.waitForTimeout(6000)

const panel = await page.textContent('.debug')
console.log('=== Panel vorhanden:', !!panel, '| Länge:', panel?.length)
console.log(panel?.split('\n').slice(0, 26).join('\n'))
console.log('...')
const verlauf = panel?.split('-- Verlauf --')[1] ?? ''
console.log('-- Verlauf --' + verlauf.split('\n').slice(0, 10).join('\n'))
// Direktes Kind: seit die Ton-Schalter in der Leiste stehen, träfe
// "#bar button" auch die aus dem .picker — und zwar zuerst.
console.log('\n=== Kopierknopf:', await page.textContent('#bar > button:last-of-type'))

// Bild-in-Bild: Chromium meldet Unterstützung, also muss je Kachel ein
// Knopf im DOM stehen. Sichtbar ist er hier nicht — ohne Bild blendet
// CSS ihn aus, und genau das soll auch so sein.
console.log('=== PiP-Knöpfe (erwartet 3):', await page.locator('.tile .pip').count())

// Ohne Stream lehnt play() ab, der Ton darf also NICHT angehen. Wichtig
// ist, dass die Kacheln danach trotzdem stumm weiterlaufen statt zu
// hängen — ein fehlgeschlagenes Entstummen darf nichts abreißen.
console.log('=== Kacheln stumm (erwartet true):',
  await page.locator('video').evaluateAll((vs) => vs.every((v) => v.muted)))

// Jede Kachel muss ihren Tonzustand anzeigen, auch den stummen. Fehlt
// data-muted, zeigt die Kachel gar kein Symbol — der Fehler, den das
// hier abfangen soll.
console.log('=== data-muted gesetzt (erwartet 3x true):',
  await page.locator('.tile').evaluateAll((ts) => ts.map((t) => t.dataset.muted)))

// Die Schalter müssen da sein, AUCH wenn der Ton nicht angehen konnte —
// sonst gibt es keinen Weg, ihn pro Kamera nachträglich anzuschalten.
console.log('=== Ton-Schalter (erwartet 3):', await page.locator('.picker button').count())

console.log('=== Unerwartete Fehler:', errors.filter(e => !e.includes('Failed to load resource') && !e.includes('WebSocket')).length)
await browser.close()
