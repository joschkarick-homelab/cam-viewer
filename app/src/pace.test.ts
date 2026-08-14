/**
 * Läuft ohne Browser und ohne Abhängigkeiten:
 *
 *   cd app && npm test
 *
 * Bewusst klein. Der Zweck ist nicht Abdeckung, sondern eine Sperre
 * gegen genau die Regression, die uns schon zweimal Abende gekostet hat:
 * eine Abspielrate, die bei knappem Puffer nicht bremst.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveRate, seekTarget, MIN_RATE, MAX_RATE, TARGET_LAG_S } from './pace.ts'

test('beim Zielrückstand läuft es in Echtzeit', () => {
  assert.equal(liveRate(TARGET_LAG_S), 1)
})

test('bei knappem Puffer wird GEBREMST, nicht weitergerast', () => {
  // Der eigentliche Punkt: unterhalb des Ziels muss die Rate unter 1
  // fallen, sonst läuft der Puffer leer und das Bild ruckelt.
  assert.ok(liveRate(0.5) < 1, 'halbe Sekunde Rückstand muss bremsen')
  assert.ok(liveRate(0.2) < liveRate(0.5), 'weniger Puffer = langsamer')
})

test('leerer Puffer hält das Bild nicht an', () => {
  // Rate 0 hieße Standbild — und ein Standbild darf nie wie ein Livebild
  // aussehen. Zeitlupe ist als Zwischenzustand ehrlicher und erholt sich.
  assert.equal(liveRate(0), MIN_RATE)
  assert.equal(liveRate(-1), MIN_RATE)
})

test('großer Rückstand wird aufgeholt, aber gedeckelt', () => {
  assert.ok(liveRate(2) > 1)
  assert.equal(liveRate(60), MAX_RATE)
})

test('unbrauchbarer Rückstand ergibt Echtzeit', () => {
  assert.equal(liveRate(NaN), 1)
  assert.equal(liveRate(Infinity), 1)
})

test('im Puffer wird nicht gesprungen', () => {
  assert.equal(seekTarget(12, 10, 14.5), null)
  // Die Kante zählt als drinnen. Sonst springt es sofort wieder.
  assert.equal(seekTarget(10, 10, 14.5), null)
  assert.equal(seekTarget(14.5, 10, 14.5), null)
})

test('ein Sprung landet STRIKT im Puffer, nicht auf der Kante', () => {
  // Der eigentliche Punkt. Vorher wurde auf den Pufferanfang gesprungen,
  // WebKit landete knapp davor, und der nächste Durchlauf sprang wieder
  // — eine Schleife, die nie abspielt. Das Ziel muss so weit drinnen
  // liegen, dass ein ungenauer Sprung immer noch drinnen landet.
  const target = seekTarget(9.97, 10, 14.5)
  assert.ok(target !== null && target > 10, 'Ziel muss über dem Pufferanfang liegen')
  // Und nach dem Sprung ist Ruhe, auch wenn wir wieder etwas davor landen.
  assert.equal(seekTarget(target! - 0.03, 10, 14.5), null)
})

test('kurzer Puffer wird nicht überschossen', () => {
  assert.equal(seekTarget(0, 10, 10.05), 10.05)
})

test('unbrauchbare Bereiche ergeben keinen Sprung', () => {
  assert.equal(seekTarget(NaN, 10, 14), null)
  assert.equal(seekTarget(5, 14, 10), null)
  assert.equal(seekTarget(5, 10, 10), null)
})
