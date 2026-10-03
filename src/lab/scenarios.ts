import { World } from './world'
import type { Candidate, Capability, Outcome, ScenarioResult } from './types'

export interface Scenario {
  readonly id: string
  readonly title: string
  readonly needs: Capability[]
  run(w: World): Promise<Omit<ScenarioResult, 'scenario' | 'title' | 'ms'>>
}

const fmt = (xs: string[]) => `{${xs.join(', ')}}`

/** Sehen alle genannten Geräte dieselbe Mitgliedschaft? */
function membersAgree(w: World, devices: string[]): { agree: boolean; text: string } {
  const views = devices.map((d) => `${d}:${fmt(w.members(d))}`)
  const first = JSON.stringify(w.members(devices[0]!))
  const agree = devices.every((d) => JSON.stringify(w.members(d)) === first)
  return { agree, text: agree ? `alle sehen ${fmt(w.members(devices[0]!))}` : `uneinig: ${views.join(' ')}` }
}

const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const verdict = (ok: boolean): Outcome => (ok ? 'bestanden' : 'nicht bestanden')

/** Gründung mit Alice (Admin), Bob und Carol, alles zugestellt. */
async function base(w: World, extra: Array<[string, 'admin' | 'member']> = [], bob: 'admin' | 'member' = 'member') {
  // Rollen werden beim Aufnehmen vergeben (p2panda-spaces 0.7.1 kennt kein
  // nachträgliches Befördern; Gen 2 befördert intern direkt nach dem Aufnehmen).
  const people: Array<[string, 'admin' | 'member']> = [['bob', bob], ['carol', 'member'], ...extra]
  await w.device('alice', 'alice')
  for (const [p] of people) await w.device(p, p)
  // Geräte machen sich bekannt (z. B. Key-Bundles/Pre-Keys), bevor jemand einlädt.
  await w.flush()
  await w.createGroup('alice')
  for (const [p, role] of people) await w.add('alice', p, role)
  await w.flush()
}

export const scenarios: Scenario[] = [
  {
    id: 'S1',
    title: 'Gründen, zwei Mitglieder aufnehmen, Inhalte tauschen',
    needs: [],
    async run(w) {
      await base(w)
      for (const d of ['alice', 'bob', 'carol']) await w.write(d, `von-${d}`)
      await w.flush()
      const want = ['von-alice', 'von-bob', 'von-carol']
      const reads = ['alice', 'bob', 'carol'].map((d) => w.read(d))
      const m = membersAgree(w, ['alice', 'bob', 'carol'])
      return {
        outcome: verdict(m.agree && reads.every((r) => same(r, want))),
        authority: m.text,
        keys: reads.every((r) => same(r, want)) ? 'alle lesen alle drei Einträge' : `Lesestand: ${reads.map(fmt).join(' ')}`,
      }
    },
  },
  {
    id: 'S2',
    title: 'Mitglied entfernen; Entfernter liest Neues nicht mehr',
    needs: [],
    async run(w) {
      await base(w)
      await w.remove('alice', 'carol')
      await w.flush()
      await w.write('bob', 'nach-entfernen')
      await w.flush()
      const carolReads = w.read('carol').includes('nach-entfernen')
      const othersRead = ['alice', 'bob'].every((d) => w.read(d).includes('nach-entfernen'))
      const m = membersAgree(w, ['alice', 'bob'])
      const carolOut = !w.members('alice').includes('carol')
      return {
        outcome: verdict(m.agree && carolOut && othersRead && !carolReads),
        authority: m.text,
        keys: `Carol liest Neues: ${carolReads ? 'ja' : 'nein'}; Alice/Bob lesen: ${othersRead ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'S3',
    title: 'Offline schreiben, danach konvergieren',
    needs: [],
    async run(w) {
      await base(w)
      await w.partition(['alice', 'carol'], ['bob'])
      await w.write('bob', 'offline-bob')
      await w.write('alice', 'online-alice')
      await w.flush()
      await w.heal()
      await w.flush()
      const want = ['offline-bob', 'online-alice']
      const ok = ['alice', 'bob', 'carol'].every((d) => same(w.read(d), want))
      return {
        outcome: verdict(ok),
        authority: membersAgree(w, ['alice', 'bob', 'carol']).text,
        keys: ok ? 'alle lesen beide Einträge' : ['alice', 'bob', 'carol'].map((d) => `${d}:${fmt(w.read(d))}`).join(' '),
      }
    },
  },
  {
    id: 'S4a',
    title: 'Alice entfernt Bob, während Bob schreibt',
    needs: [],
    async run(w) {
      await base(w)
      await w.partition(['alice', 'carol'], ['bob'])
      await w.remove('alice', 'bob')
      await w.write('bob', 'bob-gleichzeitig')
      await w.flush()
      await w.heal()
      await w.flush()
      await w.write('alice', 'danach')
      await w.flush()
      const m = membersAgree(w, ['alice', 'carol'])
      const bobOut = !w.members('alice').includes('bob')
      const bobReadsAfter = w.read('bob').includes('danach')
      const concurrent = ['alice', 'carol'].map((d) => `${d}:${w.read(d).includes('bob-gleichzeitig') ? 'sieht' : 'verwirft'}`)
      return {
        outcome: verdict(m.agree && bobOut && !bobReadsAfter),
        authority: `${m.text}; Bobs gleichzeitiger Eintrag: ${concurrent.join(' ')}`,
        keys: `Bob liest Einträge nach dem Zusammenführen: ${bobReadsAfter ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'S4b',
    title: 'Zwei Admins entfernen gleichzeitig verschiedene Personen',
    needs: ['roles'],
    async run(w) {
      await base(w, [['dave', 'member']], 'admin')
      await w.partition(['alice', 'carol'], ['bob', 'dave'])
      await w.remove('alice', 'carol')
      await w.remove('bob', 'dave')
      await w.flush()
      await w.heal()
      await w.flush()
      await w.write('alice', 'danach')
      await w.flush()
      const m = membersAgree(w, ['alice', 'bob'])
      const usable = w.read('bob').includes('danach')
      const outsiders = ['carol', 'dave'].filter((d) => w.read(d).includes('danach'))
      return {
        outcome: verdict(m.agree && same(w.members('alice'), ['alice', 'bob']) && usable && outsiders.length === 0),
        authority: `${m.text}; Zustand ${w.candidate.status('alice')}`,
        keys: `Bob liest Neues: ${usable ? 'ja' : 'nein'}; Entfernte lesen Neues: ${outsiders.length ? outsiders.join(',') : 'niemand'}`,
      }
    },
  },
  {
    id: 'S4c',
    title: 'Gegenseitige Entfernung zweier Admins',
    needs: ['roles'],
    async run(w) {
      await base(w, [], 'admin')
      await w.partition(['alice'], ['bob'])
      await w.remove('alice', 'bob')
      await w.remove('bob', 'alice')
      await w.flush()
      await w.heal()
      await w.flush()
      // Kein festes Soll für das Ergebnis (Produktfrage); verlangt ist, dass sich
      // alle einig sind, die laut Carol (unbeteiligt) noch Mitglied sind.
      const remaining = ['alice', 'bob', 'carol'].filter((d) => d === 'carol' || w.members('carol').includes(d))
      const m = membersAgree(w, remaining)
      const others = ['alice', 'bob'].filter((d) => !remaining.includes(d)).map((d) => `${d} (entfernt) sieht ${fmt(w.members(d))}`)
      return {
        outcome: verdict(m.agree),
        authority: [`${m.text}`, ...others, `Zustand ${w.candidate.status('carol')}`].join('; '),
        keys: '—',
      }
    },
  },
  {
    id: 'S4d',
    title: 'Entfernung neben Rotation eines anderen Mitglieds',
    needs: ['roles', 'rotate'],
    async run(w) {
      await base(w, [], 'admin')
      await w.partition(['alice', 'carol'], ['bob'])
      await w.remove('alice', 'carol')
      await w.candidate.rotate('bob')
      await w.flush()
      await w.heal()
      await w.flush()
      await w.write('bob', 'danach')
      await w.flush()
      const m = membersAgree(w, ['alice', 'bob'])
      const carolReads = w.read('carol').includes('danach')
      const aliceReads = w.read('alice').includes('danach')
      return {
        outcome: verdict(m.agree && same(w.members('alice'), ['alice', 'bob']) && aliceReads && !carolReads),
        authority: `${m.text}; Zustand ${w.candidate.status('alice')}`,
        keys: `Alice liest Neues: ${aliceReads ? 'ja' : 'nein'}; Carol liest Neues: ${carolReads ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'S4e',
    title: 'Zwei gleichzeitige Änderungen der Gruppenregeln',
    needs: ['roles', 'policy'],
    async run(w) {
      await base(w, [], 'admin')
      await w.partition(['alice'], ['bob'])
      await w.candidate.changePolicy('alice', 'regel-a')
      await w.candidate.changePolicy('bob', 'regel-b')
      await w.flush()
      await w.heal()
      await w.flush()
      const states = ['alice', 'bob', 'carol'].map((d) => w.candidate.status(d))
      const agree = states.every((s) => s === states[0])
      return {
        outcome: verdict(agree),
        authority: agree ? `alle: ${states[0]}` : `uneinig: ${states.join(' | ')}`,
        keys: '—',
      }
    },
  },
  {
    id: 'S4f',
    title: 'Entfernte lädt gleichzeitig ein, Eingeladener lädt weiter ein',
    needs: ['roles'],
    async run(w) {
      await base(w, [['mallory', 'admin']])
      await w.device('x', 'x')
      await w.device('y', 'y')
      await w.flush()
      await w.partition(['alice', 'bob', 'carol'], ['mallory', 'x', 'y'])
      await w.remove('alice', 'mallory')
      await w.add('mallory', 'x', 'admin')
      await w.flush()
      let chain = 'x lädt y ein'
      try {
        await w.add('x', 'y', 'member')
      } catch (e) {
        chain = `x kann y nicht einladen (${(e as Error).message})`
      }
      await w.flush()
      await w.heal()
      await w.flush()
      const m = membersAgree(w, ['alice', 'bob', 'carol'])
      const puppets = ['mallory', 'x', 'y'].filter((p) => w.members('alice').includes(p))
      return {
        outcome: verdict(m.agree && puppets.length === 0),
        authority: `${m.text}; übrig aus Mallorys Kette: ${puppets.length ? puppets.join(',') : 'niemand'}; ${chain}`,
        keys: '—',
      }
    },
  },
  {
    id: 'S5',
    title: 'Zweites Gerät derselben Person',
    needs: ['multi-device'],
    async run(w) {
      await base(w)
      await w.write('alice', 'vorher')
      await w.flush()
      await w.device('bob', 'bob-2')
      await w.flush()
      await w.write('carol', 'nachher')
      await w.flush()
      const r = w.read('bob-2')
      const ok = same(r, ['nachher', 'vorher'])
      return {
        outcome: verdict(ok && !w.members('alice').includes('bob-2')),
        authority: `Mitglieder laut Alice: ${fmt(w.members('alice'))}`,
        keys: `bob-2 liest ${fmt(r)}`,
      }
    },
  },
  {
    id: 'S6',
    title: 'Neues Mitglied liest die Historie',
    needs: [],
    async run(w) {
      await base(w)
      for (const t of ['alt-1', 'alt-2', 'alt-3']) await w.write('alice', t)
      await w.flush()
      await w.device('dave', 'dave')
      await w.flush()
      await w.add('alice', 'dave')
      await w.flush()
      const r = w.read('dave')
      return {
        outcome: verdict(same(r, ['alt-1', 'alt-2', 'alt-3'])),
        authority: `Dave Mitglied: ${w.members('alice').includes('dave') ? 'ja' : 'nein'}`,
        keys: `Dave liest ${fmt(r)}`,
      }
    },
  },
  {
    id: 'S6b',
    title: 'Neues Mitglied liest die Historie nach dem nächsten Eintrag',
    needs: [],
    async run(w) {
      await base(w)
      for (const t of ['alt-1', 'alt-2']) await w.write('alice', t)
      await w.write('bob', 'alt-bob')
      await w.flush()
      await w.device('dave', 'dave')
      await w.flush()
      await w.add('alice', 'dave')
      await w.flush()
      const direkt = w.read('dave').length
      // Bei kausaler Verschlüsselung (Keyhive) öffnet erst ein neuer Eintrag
      // den Weg zurück in die Historie.
      await w.write('alice', 'neu')
      await w.flush()
      const r = w.read('dave')
      return {
        outcome: verdict(same(r, ['alt-1', 'alt-2', 'alt-bob', 'neu'])),
        authority: `Dave Mitglied: ${w.members('alice').includes('dave') ? 'ja' : 'nein'}`,
        keys: `direkt nach Aufnahme ${direkt} Einträge; nach neuem Eintrag ${fmt(r)}`,
      }
    },
  },
  {
    id: 'S7',
    title: 'Gerät erbeutet, danach Rotation: liest der Angreifer weiter?',
    needs: ['steal', 'rotate'],
    async run(w) {
      await base(w)
      const theft = w.log.length
      const stolen = await w.candidate.steal('bob')
      await w.candidate.rotate('bob')
      await w.flush()
      const mark = w.log.length
      await w.write('alice', 'nach-rotation')
      await w.flush()
      // Der Angreifer sieht allen Verkehr ab dem Diebstahl, in Log-Reihenfolge.
      const opened: Uint8Array[] = []
      for (const m of w.log.slice(theft)) {
        const r = await w.candidate.attackerOpen(stolen, m)
        if (r && w.log.indexOf(m) >= mark) opened.push(r)
      }
      return {
        outcome: verdict(opened.length === 0),
        authority: '—',
        keys: opened.length ? `Angreifer öffnet ${opened.length} Nachricht(en) nach der Rotation` : 'Angreifer öffnet nichts nach der Rotation',
      }
    },
  },
  {
    id: 'S8',
    title: 'Ersteller fällt weg, Gruppe bleibt handlungsfähig',
    needs: ['roles'],
    async run(w) {
      await base(w, [['dave', 'member']], 'admin')
      await w.partition(['bob', 'carol', 'dave'], ['alice'])
      await w.remove('bob', 'dave')
      await w.flush()
      await w.write('carol', 'ohne-alice')
      await w.flush()
      const daveOut = !w.members('carol').includes('dave')
      const bobReads = w.read('bob').includes('ohne-alice')
      return {
        outcome: verdict(daveOut && bobReads && !w.read('dave').includes('ohne-alice')),
        authority: `Carol sieht ${fmt(w.members('carol'))}; Zustand ${w.candidate.status('bob')}`,
        keys: `Bob liest Neues: ${bobReads ? 'ja' : 'nein'}; Dave liest Neues: ${w.read('dave').includes('ohne-alice') ? 'ja' : 'nein'}`,
      }
    },
  },
]

export async function runScenario(make: () => Candidate, s: Scenario): Promise<ScenarioResult> {
  const candidate = make()
  const missing = s.needs.filter((c) => !candidate.capabilities.has(c))
  if (missing.length) {
    return { scenario: s.id, title: s.title, outcome: 'nicht abbildbar', authority: `fehlt: ${missing.join(', ')}`, keys: '—', ms: 0 }
  }
  const t0 = performance.now()
  try {
    const r = await s.run(new World(candidate))
    return { scenario: s.id, title: s.title, ms: performance.now() - t0, ...r }
  } catch (e) {
    return { scenario: s.id, title: s.title, outcome: 'nicht bestanden', authority: `Fehler: ${(e as Error).message}`, keys: '—', ms: performance.now() - t0 }
  } finally {
    await candidate.dispose?.()
  }
}

export async function runAll(make: () => Candidate): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  for (const s of scenarios) out.push(await runScenario(make, s))
  return out
}
