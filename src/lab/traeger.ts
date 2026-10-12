import { World } from './world'
import type { CandidateFactory, Msg, Outcome, ScenarioResult } from './types'
import type { Scenario } from './scenarios'

// Träger-Prüfstand (E10/E11): derselbe Kandidat, der Träger spielt den
// Gegner. Jedes Szenario nennt die Tür des Vertrags, die es prüft. Plan:
// rltp/design/port-experimente-2026-10.md, „Szenarienkatalog T“.

const fmt = (xs: string[]) => `{${xs.join(', ')}}`
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const verdict = (ok: boolean): Outcome => (ok ? 'bestanden' : 'nicht bestanden')
const agree = (w: World, devices: string[]) => devices.every((d) => JSON.stringify(w.members(d)) === JSON.stringify(w.members(devices[0]!)))
const dec = new TextDecoder()
const enc = new TextEncoder()

export interface CarrierScenario extends Scenario {
  /** Tür bzw. Zusage des Vertrags, die geprüft wird. */
  readonly door: string
}

/** Gründung mit Alice, Bob und Carol, alles zugestellt. */
async function base(w: World) {
  for (const p of ['alice', 'bob', 'carol']) await w.device(p, p)
  await w.flush()
  await w.createGroup('alice')
  await w.add('alice', 'bob', 'admin')
  await w.add('alice', 'carol')
  await w.flush()
}

const isAuthFrom = (from: string, label = 'auth') => (m: Msg) => m.from === from && m.label === label

export const carrierScenarios: CarrierScenario[] = [
  {
    id: 'T1',
    title: 'Träger verliert einen Rahmen still',
    door: 'DV2 nichts endet still · I12 Lückenreparatur',
    needs: [],
    async run(w) {
      await base(w)
      const c = w.carrier()!
      // Die nächste Autoritätsoperation von Alice (Aufnahme von Dave) geht verloren.
      await w.device('dave', 'dave')
      await w.flush()
      let dropped = false
      c.drop((m) => {
        if (!dropped && isAuthFrom('alice')(m)) return (dropped = true)
        return false
      })
      await w.add('alice', 'dave')
      await w.flush()
      c.reset()
      await w.write('alice', 'danach')
      await w.flush()
      const ok = agree(w, ['alice', 'bob', 'carol', 'dave']) && same(w.members('bob'), ['alice', 'bob', 'carol', 'dave']) && w.read('dave').includes('danach')
      return {
        outcome: verdict(ok),
        authority: ok ? 'Lücke geschlossen' : `Lücke bleibt: alice ${fmt(w.members('alice'))}, bob ${fmt(w.members('bob'))}; verschluckt ${w.swallowed.length} Rahmen; Zustand bob: ${w.candidate.status('bob')}`,
        keys: `Dave liest: ${w.read('dave').includes('danach') ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'T2',
    title: 'Träger ordnet um',
    door: 'I2 kausale Anwendung',
    needs: [],
    async run(w) {
      const c = w.carrier()!
      c.reverse(true)
      await base(w)
      await w.device('dave', 'dave')
      await w.flush()
      await w.add('alice', 'dave')
      await w.remove('bob', 'carol')
      await w.write('alice', 'eins')
      await w.flush()
      await w.write('dave', 'zwei')
      await w.flush()
      const ok = agree(w, ['alice', 'bob', 'dave']) && same(w.members('alice'), ['alice', 'bob', 'dave']) && ['alice', 'bob', 'dave'].every((d) => same(w.read(d), ['eins', 'zwei']))
      return { outcome: verdict(ok), authority: `alice ${fmt(w.members('alice'))} bob ${fmt(w.members('bob'))} dave ${fmt(w.members('dave'))}`, keys: ['alice', 'bob', 'dave'].map((d) => `${d}:${fmt(w.read(d))}`).join(' ') }
    },
  },
  {
    id: 'T3',
    title: 'Träger liefert doppelt',
    door: 'DV3 / 6.3 idempotent über den Inhalt',
    needs: [],
    async run(w) {
      const c = w.carrier()!
      c.duplicate(true)
      await base(w)
      await w.remove('alice', 'carol')
      await w.flush()
      await w.write('bob', 'einmal')
      await w.flush()
      const reads = ['alice', 'bob'].map((d) => w.read(d))
      const ok = agree(w, ['alice', 'bob']) && same(w.members('alice'), ['alice', 'bob']) && reads.every((r) => same(r, ['einmal'])) && !w.read('carol').includes('einmal')
      return { outcome: verdict(ok), authority: `alice ${fmt(w.members('alice'))} bob ${fmt(w.members('bob'))}; carol liest ${fmt(w.read('carol'))}; Zustand bob: ${w.candidate.status('bob')}`, keys: `Einträge: ${reads.map(fmt).join(' ')}` }
    },
  },
  {
    id: 'T4',
    title: 'Träger spielt eine alte Entfernung erneut ein',
    door: 'I8 Zustand, nicht Kante · RLTP-ACC-3475',
    needs: [],
    async run(w) {
      await base(w)
      await w.remove('alice', 'carol')
      await w.flush()
      await w.add('alice', 'carol')
      await w.flush()
      const c = w.carrier()!
      // Die Entfernung von damals kommt noch einmal.
      await c.replay((m) => m.from === 'alice' && m.label === 'auth' && dec.decode(m.body).includes('"remove"'))
      await w.flush()
      await w.write('carol', 'noch-da')
      await w.flush()
      const ok = agree(w, ['alice', 'bob', 'carol']) && same(w.members('bob'), ['alice', 'bob', 'carol']) && w.read('alice').includes('noch-da')
      return { outcome: verdict(ok), authority: `bob ${fmt(w.members('bob'))}`, keys: `Alice liest Carols Eintrag: ${w.read('alice').includes('noch-da') ? 'ja' : 'nein'}` }
    },
  },
  {
    id: 'T5',
    title: 'Träger verändert einen Rahmen',
    door: 'D1 signierter DAG · Form vor Inhalt',
    needs: [],
    async run(w) {
      await base(w)
      const c = w.carrier()!
      await w.device('dave', 'dave')
      await w.flush()
      // Alices Aufnahme von Dave wird unterwegs zu einer Entfernung von Bob umgeschrieben, und ein zweiter Rahmen zu Müll.
      let n = 0
      c.tamper(isAuthFrom('alice'), (body) => {
        n++
        if (n === 1) return enc.encode(dec.decode(body).replace('"kind":"add"', '"kind":"remove"').replace('"subject":"dave"', '"subject":"bob"'))
        return enc.encode('{"t":"auth","op":')
      })
      await w.add('alice', 'dave')
      await w.flush()
      await w.write('alice', 'x')
      await w.flush()
      c.reset()
      const bobStays = ['alice', 'bob', 'carol'].every((d) => w.members(d).includes('bob'))
      const noDave = ['bob', 'carol'].every((d) => !w.members(d).includes('dave'))
      return { outcome: verdict(bobStays && noDave && agree(w, ['bob', 'carol'])), authority: `bob ${fmt(w.members('bob'))} carol ${fmt(w.members('carol'))}; Zustand bob: ${w.candidate.status('bob')}`, keys: '—' }
    },
  },
  {
    id: 'T6',
    title: 'Träger hält einem Gerät gezielt einen Eintrag vor',
    door: 'D5 beglaubigtes Konvergenzziel · I5',
    needs: [],
    async run(w) {
      await base(w)
      const c = w.carrier()!
      await w.device('dave', 'dave')
      await w.flush()
      c.withhold('carol', isAuthFrom('alice'))
      await w.add('alice', 'dave')
      await w.flush()
      await w.write('dave', 'von-dave')
      await w.flush()
      // Carol müsste merken, dass sie zurückliegt. Erkennbar hier nur daran, dass sie Daves Eintrag nicht lesen kann.
      const carolBehind = !w.members('carol').includes('dave')
      const carolReads = w.read('carol').includes('von-dave')
      const noticed = w.candidate.status('carol').includes('lücke') || w.candidate.status('carol').includes('gap')
      return {
        outcome: verdict(noticed),
        authority: `Carol sieht ${fmt(w.members('carol'))} (zurück: ${carolBehind ? 'ja' : 'nein'}); bemerkt: ${noticed ? 'ja' : 'nein'}; Zustand: ${w.candidate.status('carol')}`,
        keys: `Carol liest Daves Eintrag: ${carolReads ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'T12',
    title: 'Versiegelter Eintrag: was der Träger liest',
    door: 'I6 key-blindness · Access-Envelope',
    needs: [],
    async run(w) {
      await base(w)
      await w.write('alice', 'geheim')
      await w.flush()
      const c = w.carrier()!
      const leaks: string[] = []
      for (const m of c.carried()) {
        const text = dec.decode(m.body)
        for (const name of ['alice', 'bob', 'carol']) if (text.includes(`"${name}"`)) leaks.push(`${m.label}:${name}`)
        if (text.includes('geheim')) leaks.push(`${m.label}:INHALT`)
      }
      const unique = [...new Set(leaks)]
      return { outcome: verdict(unique.length === 0), authority: unique.length ? `im Klartext beim Träger: ${unique.join(', ')}` : 'nur Chiffretext', keys: unique.some((l) => l.endsWith('INHALT')) ? 'Inhalt lesbar' : 'Inhalt versiegelt' }
    },
  },
]

export async function runCarrier(make: CandidateFactory): Promise<Array<ScenarioResult & { door: string }>> {
  const out: Array<ScenarioResult & { door: string }> = []
  for (const s of carrierScenarios) {
    const candidate = await make()
    const t0 = performance.now()
    try {
      const w = new World(candidate)
      if (!w.carrier()) {
        out.push({ scenario: s.id, title: s.title, door: s.door, outcome: 'nicht abbildbar', authority: 'Träger ohne Fehlerinjektion', keys: '—', ms: 0 })
        continue
      }
      const r = await s.run(w)
      out.push({ scenario: s.id, title: s.title, door: s.door, ms: performance.now() - t0, ...r })
    } catch (e) {
      out.push({ scenario: s.id, title: s.title, door: s.door, outcome: 'nicht bestanden', authority: `Fehler: ${(e as Error).message}`, keys: '—', ms: performance.now() - t0 })
    } finally {
      await candidate.dispose?.()
    }
  }
  return out
}
