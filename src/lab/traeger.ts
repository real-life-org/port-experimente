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

/**
 * Zählt, wie oft eine Fehlerregel greift. Greift sie nie, hat der Träger
 * keinen Rahmen dieser Art gesehen (der Kandidat nennt seine Rahmen anders),
 * und das Szenario ist für ihn nicht abbildbar statt still bestanden.
 */
function counted<T extends (m: Msg) => boolean>(pred: T): { pred: (m: Msg) => boolean; hits: () => number } {
  let n = 0
  return {
    pred: (m) => {
      const h = pred(m)
      if (h) n++
      return h
    },
    hits: () => n,
  }
}
const untouched = (what: string): ScenarioOutcome => ({ outcome: 'nicht abbildbar', authority: `der Träger hat keinen Rahmen dieser Art gesehen (${what}); der Kandidat nennt seine Rahmen anders`, keys: '—' })
type ScenarioOutcome = { outcome: Outcome; authority: string; keys: string }

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
      const rule = counted((m) => {
        if (!dropped && isAuthFrom('alice')(m)) return (dropped = true)
        return false
      })
      c.drop(rule.pred)
      await w.add('alice', 'dave')
      await w.flush()
      c.reset()
      if (!rule.hits()) return untouched('Autoritätsrahmen von alice')
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
      // Bobs Entfernung von Carol ist gleichzeitig mit Daves Aufnahme und unter einem Schlüssel ohne Dave
      // versiegelt; Dave liest sie erst mit dem nächsten Eintrag eines Mitglieds, das sie gelesen hat (Kette).
      await w.write('bob', 'drei')
      await w.flush()
      const all3 = ['eins', 'zwei', 'drei']
      const ok = agree(w, ['alice', 'bob', 'dave']) && same(w.members('alice'), ['alice', 'bob', 'dave']) && ['alice', 'bob', 'dave'].every((d) => same(w.read(d), all3))
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
      // Alices Autoritätsrahmen von damals kommen noch einmal, die Entfernung darunter (versiegelt: der Träger kann sie nicht gezielt auswählen).
      const replayed = await c.replay((m) => m.from === 'alice' && m.label === 'auth')
      await w.flush()
      if (!replayed) return untouched('Autoritätsrahmen von alice')
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
      // Alices nächste zwei Autoritätsrahmen (Aufnahme von Dave, von Eve) werden unterwegs verändert: im ersten
      // kippt ein Byte des Chiffretexts, der zweite wird zu Müll. Versiegelt kann der Träger nichts Gezieltes
      // mehr schreiben (eine Aufnahme zur Entfernung umdeuten); er kann nur zerstören.
      await w.device('eve', 'eve')
      await w.flush()
      let hit = 0
      const rule = counted(isAuthFrom('alice'))
      c.tamper(rule.pred, (body) => {
        hit++
        if (hit === 1) {
          const f = JSON.parse(dec.decode(body)) as { c?: string }
          // Versiegelt: ein Byte im Chiffretext kippt. Unversiegelt (Klartextmodus): der Rahmen wird abgeschnitten.
          if (typeof f.c === 'string') return enc.encode(JSON.stringify({ ...f, c: (f.c[0] === 'A' ? 'B' : 'A') + f.c.slice(1) }))
          return body.slice(0, Math.max(1, body.length - 7))
        }
        if (hit === 2) return enc.encode('{"t":"sealed","kind":"auth","c":')
        return body
      })
      await w.add('alice', 'dave')
      await w.flush()
      await w.add('alice', 'eve')
      await w.flush()
      await w.write('alice', 'x')
      await w.flush()
      c.reset()
      if (!rule.hits()) return untouched('Autoritätsrahmen von alice')
      // Der Träger konnte nur zerstören: Bob bleibt, nichts wurde umgedeutet. Was zerstört wurde, holt die
      // Lückenreparatur über den Beleg von Alices Inhalt zurück: Dave und Eve kommen doch an.
      const bobStays = ['alice', 'bob', 'carol'].every((d) => w.members(d).includes('bob'))
      const repaired = ['bob', 'carol'].every((d) => w.members(d).includes('dave') && w.members(d).includes('eve'))
      const st = w.candidate.status('bob')
      const garbageNoted = st.includes('verworfen')
      return { outcome: verdict(bobStays && repaired && garbageNoted && agree(w, ['alice', 'bob', 'carol'])), authority: `bob ${fmt(w.members('bob'))} carol ${fmt(w.members('carol'))}; Müll notiert: ${garbageNoted ? 'ja' : 'nein'}; zerstörte Rahmen repariert: ${repaired ? 'ja' : 'nein'}; Zustand bob: ${st}`, keys: '—' }
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
      const rule = counted(isAuthFrom('alice'))
      c.withhold('carol', rule.pred)
      await w.add('alice', 'dave')
      await w.flush()
      await w.write('dave', 'von-dave')
      await w.flush()
      if (!rule.hits()) return untouched('Autoritätsrahmen von alice')
      // Carol müsste merken, dass sie zurückliegt. Erkennbar hier nur daran, dass sie Daves Eintrag nicht lesen kann.
      const carolBehind = !w.members('carol').includes('dave')
      const carolReads = w.read('carol').includes('von-dave')
      const noticed = /lücke=[1-9]|repariert [1-9]/.test(w.candidate.status('carol')) // eine offene oder geschlossene Lücke, nicht bloß das Feld
      return {
        outcome: verdict(noticed),
        authority: `Carol sieht ${fmt(w.members('carol'))} (zurück: ${carolBehind ? 'ja' : 'nein'}); bemerkt: ${noticed ? 'ja' : 'nein'}; Zustand: ${w.candidate.status('carol')}`,
        keys: `Carol liest Daves Eintrag: ${carolReads ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'T6b',
    title: 'Träger friert ein Gerät ein (alles vorgehalten)',
    door: 'D5 beglaubigtes Konvergenzziel · I5',
    needs: [],
    async run(w) {
      await base(w)
      const c = w.carrier()!
      await w.device('dave', 'dave')
      await w.flush()
      // Carol bekommt gar nichts mehr: kein Eintrag, der auf das Vorgehaltene aufbaut, erreicht sie.
      c.withhold('carol', () => true)
      await w.add('alice', 'dave')
      await w.flush()
      await w.write('dave', 'von-dave')
      await w.flush()
      const noticed = /lücke=[1-9]/.test(w.candidate.status('carol')) // nur eine offene Lücke zählt; frühere, geschlossene sagen nichts über den eingefrorenen Feed
      return {
        outcome: verdict(noticed),
        authority: `Carol sieht ${fmt(w.members('carol'))}; bemerkt: ${noticed ? 'ja' : 'nein'}; Zustand: ${w.candidate.status('carol')}`,
        keys: `Carol liest Daves Eintrag: ${w.read('carol').includes('von-dave') ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'T7',
    title: 'Entferntes Gerät fragt weiter',
    door: 'Dienstklassen §9.3 · KV1',
    needs: [],
    async run(w) {
      await base(w)
      await w.remove('alice', 'carol')
      await w.flush()
      await w.write('alice', 'nach-entfernung')
      await w.flush()
      // Blind: der Träger bedient Carol weiter, sie kann den Eintrag nicht öffnen (KV1). Sicht/Log: der Dienst verweigert.
      const svc = w.candidate.service
      const served = svc ? svc.serves('carol') : true
      const reads = w.read('carol').includes('nach-entfernung')
      const ok = !reads && (!svc || !served)
      return { outcome: verdict(ok), authority: `Carol ${svc ? (served ? 'wird noch bedient' : 'wird verweigert') : 'wird bedient (blind)'}; Zustand: ${w.candidate.status('carol')}`, keys: `Carol liest nach der Entfernung: ${reads ? 'ja' : 'nein'}` }
    },
  },
  {
    id: 'T8',
    title: 'Trägerwechsel mitten im Leben',
    door: 'I15 Rebinding · Portabilität',
    needs: [],
    async run(w) {
      const c = w.carrier()!
      if (!c.rebind) return { outcome: 'nicht abbildbar', authority: 'der Träger kennt keinen Wechsel (ein Prüfstand-Relay)', keys: '—' }
      await base(w)
      await w.write('alice', 'vorher')
      await w.flush()
      await c.rebind()
      await w.device('dave', 'dave')
      await w.flush()
      await w.add('bob', 'dave')
      await w.flush()
      await w.write('carol', 'nachher')
      await w.flush()
      const all = ['alice', 'bob', 'carol', 'dave']
      const ok = agree(w, all) && same(w.members('dave'), all) && all.every((d) => same(w.read(d), ['vorher', 'nachher']))
      return { outcome: verdict(ok), authority: `nach dem Wechsel: dave ${fmt(w.members('dave'))}`, keys: all.map((d) => `${d}:${fmt(w.read(d))}`).join(' ') }
    },
  },
  {
    id: 'T11',
    title: 'Zwei Gruppen auf einem Träger',
    door: 'DV4/DV6 Pseudonym je Gruppe',
    needs: [],
    async run() {
      // Grenze des Harness: ein Kandidat trägt eine Gruppe; was der Träger je Gruppe liest, zeigt T12.
      return { outcome: 'nicht abbildbar', authority: 'ein Kandidat trägt genau eine Gruppe; Verknüpfung über Gruppen hinweg braucht zwei Gruppen auf einem Träger', keys: '—' }
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
