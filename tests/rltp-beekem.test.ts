import { describe, expect, it } from 'vitest'
import { runAll } from '../src/lab/scenarios'
import { rltpBeekem } from '../src/candidates/rltp-beekem'

// E6: Autoritätslog nach der Konfliktmatrix entscheidet die Mitgliedschaft,
// BeeKEM 0.4.0 (rust/beekem-wasm) liefert die Schlüssel, Inhalt Yjs.
// Erwartungen halten das Verhalten fest; Begründungen in
// src/candidates/rltp-beekem/NOTES.md.
describe('Kandidat RLTP-Autorität über BeeKEM', () => {
  it('Basislinie je Szenario', async () => {
    const results = await runAll(rltpBeekem)
    const byId = Object.fromEntries(results.map((r) => [r.scenario, r.outcome]))
    expect(byId, JSON.stringify(results, null, 1)).toEqual({
      S1: 'bestanden',
      S2: 'bestanden',
      S3: 'bestanden',
      S4a: 'bestanden', // Bobs Eintrag unter altem Schlüssel bleibt lesbar (content residual), Bob liest nichts Neues
      S4b: 'bestanden', // zwei Entfernungen gleichzeitig: beide gelten, niemand liest mit (KV2, KV6)
      S4c: 'bestanden', // gegenseitige Entfernung: beide raus (Matrix-Entscheidung 2)
      S4d: 'bestanden', // Rotation neben Entfernung (KV5, KV6)
      S4e: 'nicht abbildbar', // keine Gruppenregeln im Experiment
      S4f: 'bestanden', // Strong Removal transitiv: Mallorys Kette ungültig, Baum geheilt
      S5: 'bestanden', // E7: ein Blatt je Gerät, Person bleibt Subjekt im Log
      S5b: 'bestanden', // E7: eigenes Gerät entfernen = neues Geheimnis ohne dessen Blatt (KV1), Person bleibt
      S5c: 'bestanden', // E7: Entfernen der Person entfernt alle ihre Blätter
      S6: 'nicht bestanden', // Historie erst über die Kette des nächsten Eintrags (wie Keyhive b)
      S6b: 'bestanden',
      S7: 'bestanden', // PCS: passiver Dieb liest nach der Rotation nichts mehr (KV5)
      S8: 'bestanden', // Gründerin ohne Sonderrolle
    })
  }, 120_000)
})
