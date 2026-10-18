import * as Y from 'yjs'
import { World } from './world'
import type { CandidateFactory, Capability, Outcome, ScenarioResult } from './types'
import { enumerateBranches, foldBranches } from './zweige'
import { foldTiming, measureRuns } from './zeit'

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
      // Konvergenz heißt beides: alle lesen beide Einträge, und alle sehen dieselbe Mitgliedschaft (Review zu #35).
      const m = membersAgree(w, ['alice', 'bob', 'carol'])
      return {
        outcome: verdict(ok && m.agree),
        authority: m.text,
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
    id: 'S4c2',
    title: 'Gegenseitige Entfernung: beide sind draußen, keiner liest Neues',
    needs: ['roles'],
    async run(w) {
      // Das Soll der Spec (Access §3.6, Entscheid 05.10.): gleichzeitige gegenseitige
      // Entfernung lässt beide draußen. S4c verlangt nur Einigkeit; hier gilt das Soll,
      // und die Vertraulichkeit danach: ein Eintrag der Verbliebenen erreicht keinen der beiden.
      await base(w, [], 'admin')
      await w.partition(['alice'], ['bob'])
      await w.remove('alice', 'bob')
      await w.remove('bob', 'alice')
      await w.flush()
      await w.heal()
      await w.flush()
      await w.write('carol', 'allein')
      await w.flush()
      const bothOut = same(w.members('carol'), ['carol'])
      const readers = ['alice', 'bob'].filter((d) => w.read(d).includes('allein'))
      return {
        outcome: verdict(bothOut && readers.length === 0),
        authority: `Carol sieht ${fmt(w.members('carol'))}; alice sieht ${fmt(w.members('alice'))}, bob sieht ${fmt(w.members('bob'))}; Zustand ${w.candidate.status('carol')}`,
        keys: readers.length ? `LECK: ${readers.join(',')} lesen Carols Eintrag` : 'keiner der beiden liest Carols Eintrag',
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
      // Verglichen wird der Zustand (Baum, Schlüssel, Fork, Regeln), nicht die Notizen dahinter (Reparaturen, Verworfenes).
      const states = ['alice', 'bob', 'carol'].map((d) => w.candidate.status(d).split('; ').slice(0, 4).join('; '))
      const agree = states.every((s) => s === states[0]) && membersAgree(w, ['alice', 'bob', 'carol']).agree
      return {
        outcome: verdict(agree),
        authority: agree ? `alle: ${states[0]}` : `uneinig: ${states.join(' | ')}`,
        keys: '—',
      }
    },
  },
  {
    id: 'S4j',
    title: 'Regeländerung neben Entfernung: Fork, Ende durch eine Regeländerung auf beide Zweige',
    needs: ['roles', 'policy'],
    async run(w) {
      await base(w, [], 'admin')
      await w.partition(['alice'], ['bob', 'carol'])
      await w.candidate.changePolicy('alice', 'remove:threshold:2')
      await w.remove('bob', 'carol')
      await w.flush()
      await w.heal()
      await w.flush()
      const all = ['alice', 'bob', 'carol']
      const forked = all.every((d) => w.candidate.status(d).includes('fork=ja'))
      const m1 = membersAgree(w, all)
      const carolStays = w.members('alice').includes('carol')
      // Ende: eine Regeländerung, die auf beiden Zweigen aufbaut.
      await w.candidate.changePolicy('alice', 'join')
      await w.flush()
      const ended = all.every((d) => w.candidate.status(d).includes('fork=nein'))
      await w.remove('alice', 'carol')
      await w.flush()
      const m2 = membersAgree(w, ['alice', 'bob'])
      const carolOut = !w.members('alice').includes('carol')
      return {
        outcome: verdict(forked && m1.agree && carolStays && ended && m2.agree && carolOut),
        authority: `im Fork: ${forked ? 'alle sehen fork=ja' : all.map((d) => `${d}:${w.candidate.status(d)}`).join(' | ')}; Carol bleibt: ${carolStays ? 'ja' : 'nein'}; Ende: ${ended ? 'ja' : 'nein'}; danach ${m2.text}`,
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
      // Vertraulichkeit nach der Heilung (#33): neuer Inhalt darf die verfallene Kette nicht erreichen.
      await w.write('alice', 'nach-der-heilung')
      await w.flush()
      const leak = ['mallory', 'x', 'y'].filter((d) => w.read(d).includes('nach-der-heilung'))
      const members = ['alice', 'bob', 'carol'].every((d) => w.read(d).includes('nach-der-heilung'))
      return {
        outcome: verdict(m.agree && puppets.length === 0 && leak.length === 0 && members),
        authority: `${m.text}; übrig aus Mallorys Kette: ${puppets.length ? puppets.join(',') : 'niemand'}; ${chain}`,
        keys: leak.length ? `LECK: ${leak.join(',')} lesen neuen Inhalt` : `neuer Inhalt nur bei Mitgliedern: ${members ? 'ja' : 'nein'}`,
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
    id: 'S5b',
    title: 'Gerät verloren: Person entfernt ihr eigenes Gerät, der Finder liest nicht weiter',
    needs: ['multi-device', 'device-remove', 'steal'],
    async run(w) {
      await base(w)
      await w.device('bob', 'bob-2')
      await w.flush()
      await w.write('alice', 'vorher')
      await w.flush()
      // Verlust: Der Finder hat den ganzen Zustand von bob-2 und liest allen Verkehr mit.
      const theft = w.log.length
      const stolen = await w.candidate.steal('bob-2')
      const finderDoc = new Y.Doc()
      Y.applyUpdate(finderDoc, Y.encodeStateAsUpdate(w.docs.get('bob-2')!))
      // Positivkontrolle: bis zum Entfernen liest er mit.
      await w.write('alice', 'vor-entfernen')
      await w.flush()
      await w.removeDevice('bob', 'bob-2')
      await w.flush()
      await w.write('carol', 'nach-entfernen')
      await w.flush()
      for (const m of w.log.slice(theft)) {
        for (const u of await w.candidate.attackerOpen(stolen, m)) Y.applyUpdate(finderDoc, u)
      }
      const seen = finderDoc.getArray<string>('eintraege').toArray()
      const control = seen.includes('vor-entfernen')
      const leaked = seen.includes('nach-entfernen')
      const bobReads = w.read('bob').includes('nach-entfernen')
      const bobStays = w.members('alice').includes('bob') && w.members('carol').includes('bob')
      return {
        outcome: verdict(control && !leaked && bobReads && bobStays),
        authority: `Bob bleibt Mitglied: ${bobStays ? 'ja' : 'nein'}; Mitglieder laut Alice: ${fmt(w.members('alice'))}`,
        keys: `Finder liest vor dem Entfernen: ${control ? 'ja' : 'NEIN (Angreifer-Modell wirkungslos)'}; danach: ${leaked ? 'ja' : 'nein'}; Bobs erstes Gerät liest weiter: ${bobReads ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'S5c',
    title: 'Person mit zwei Geräten wird entfernt; keines liest Neues',
    needs: ['multi-device'],
    async run(w) {
      await base(w)
      await w.device('bob', 'bob-2')
      await w.flush()
      await w.write('alice', 'vorher')
      await w.flush()
      await w.remove('alice', 'bob')
      await w.flush()
      await w.write('carol', 'nachher')
      await w.flush()
      const bothBefore = ['bob', 'bob-2'].every((d) => w.read(d).includes('vorher'))
      const leaks = ['bob', 'bob-2'].filter((d) => w.read(d).includes('nachher'))
      const m = membersAgree(w, ['alice', 'carol'])
      const out = !w.members('alice').includes('bob')
      return {
        outcome: verdict(bothBefore && leaks.length === 0 && m.agree && out && w.read('carol').includes('nachher')),
        authority: m.text,
        keys: `beide Geräte lasen vorher: ${bothBefore ? 'ja' : 'nein'}; lesen Neues: ${leaks.length ? leaks.join(',') : 'keines'}`,
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
      await w.write('alice', 'vorher-1')
      await w.write('carol', 'vorher-2')
      await w.flush()
      // Diebstahl: ganzer Gerätezustand von Bob, inklusive seines Yjs-Stands.
      const theft = w.log.length
      const stolen = await w.candidate.steal('bob')
      const attackerDoc = new Y.Doc()
      Y.applyUpdate(attackerDoc, Y.encodeStateAsUpdate(w.docs.get('bob')!))
      // Positivkontrolle: zwischen Diebstahl und Rotation muss er mitlesen können.
      await w.write('alice', 'vor-rotation')
      await w.flush()
      await w.candidate.rotate('bob')
      await w.flush()
      await w.write('alice', 'nach-rotation')
      await w.flush()
      for (const m of w.log.slice(theft)) {
        for (const u of await w.candidate.attackerOpen(stolen, m)) Y.applyUpdate(attackerDoc, u)
      }
      const seen = attackerDoc.getArray<string>('eintraege').toArray()
      const control = seen.includes('vor-rotation')
      const leaked = seen.includes('nach-rotation')
      const honest = ['alice', 'carol'].every((d) => w.read(d).includes('nach-rotation'))
      return {
        outcome: verdict(control && !leaked && honest),
        authority: '—',
        keys: `Angreifer liest vor der Rotation: ${control ? 'ja' : 'NEIN (Angreifer-Modell wirkungslos)'}; nach der Rotation: ${leaked ? 'ja' : 'nein'}; Alice/Carol lesen nach der Rotation: ${honest ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'S11',
    title: 'Schlüsseloperation ohne Logeintrag: ein entferntes Gerät nimmt ein neues Blatt in den Baum',
    needs: ['steal', 'forge-key-op', 'roles'],
    async run(w) {
      // KV3: Das Log bindet die Epoche an das Geheimnis. Eine Baumänderung, die kein Logeintrag deckt,
      // darf keinen Zugang eröffnen: Mallorys gefälschtes Blatt liest keinen neuen Eintrag.
      await base(w, [['mallory', 'member']], 'admin')
      const stolen = await w.candidate.steal('mallory')
      const attackerDoc = new Y.Doc()
      let id = 900000
      let fed = w.log.length
      // Der Angreifer sieht allen Verkehr und seine eigenen Rahmen. Gelesen wird nur über das gefälschte Blatt:
      // der erbeutete Altzustand liest als Mitglied ohnehin (das ist S7), er darf die Kontrolle nicht tragen.
      const feedWith = async (st: unknown, frames: Array<{ label: string; body: Uint8Array }>) => {
        for (const f of frames) for (const u of await w.candidate.attackerOpen(st, { id: id++, from: 'mallory', label: f.label, body: f.body }, 'forged')) Y.applyUpdate(attackerDoc, u)
        for (const m of w.log.slice(fed)) for (const u of await w.candidate.attackerOpen(st, m, 'forged')) Y.applyUpdate(attackerDoc, u)
        fed = w.log.length
      }
      const feed = (frames: Array<{ label: string; body: Uint8Array }>) => feedWith(stolen, frames)
      // Die Rahmen erreichen alle Geräte wie über den Träger, auch Mallorys eigenes (sonst bliebe es eine Epoche
      // zurück, und der zweite Diebstahl träfe nicht die Epoche der Entfernung).
      const inject = async (frames: Array<{ label: string; body: Uint8Array }>) => {
        for (const f of frames) for (const d of ['alice', 'bob', 'carol', 'mallory']) await w.candidate.receive(d, { id: id++, from: 'mallory', label: f.label, body: f.body })
      }
      const num = (d: string, key: string) => Number(new RegExp(`${key}=(\\d+)`).exec(w.candidate.status(d))?.[1] ?? NaN)
      // Positivkontrolle, bevor der Angriff irgendetwas beweisen soll: Das gefälschte Blatt wirkt (es öffnet, was
      // der erbeutete Zustand unter dem neuen Geheimnis versiegelt), und die Mitglieder verarbeiten die Operation,
      // solange Mallory Mitglied ist: ein Blatt mehr im Baum (BeeKEM, geheilt erst vor dem nächsten Eintrag) oder
      // eine Epoche weiter (MLS, geheilt sofort nach dem Commit). Ob ein Blatt ohne Karte als Mitglied Neues
      // liest, ist eine Frage des Kandidaten (K7), nicht des Angriffs; es wird berichtet, nicht gewertet.
      const treeBefore = num('alice', 'baum')
      const epochBefore = num('alice', 'epoche')
      const forged1 = await w.candidate.forgeKeyOp!(stolen)
      if (!forged1.frames.length) return { outcome: 'nicht abbildbar', authority: 'der Angreifer konnte keine Schlüsseloperation erzeugen', keys: '—' }
      await inject(forged1.frames)
      await w.flush()
      const accepted = num('alice', 'baum') === treeBefore + 1 || (Number.isFinite(epochBefore) && num('alice', 'epoche') > epochBefore)
      const control = forged1.works && accepted
      await w.write('alice', 'kontrolle')
      await w.flush()
      await feed(forged1.frames)
      const readsAsMember = attackerDoc.getArray<string>('eintraege').toArray().includes('kontrolle')
      const controlText = `Kontrolle: Blatt wirkt ${forged1.works ? 'ja' : 'NEIN'}, Mitglieder verarbeiten die Operation ${accepted ? 'ja' : 'NEIN'}; als Mitglied liest es Neues: ${readsAsMember ? 'ja' : 'nein'}`
      if (!control) {
        return { outcome: 'nicht bestanden', authority: 'Angreifer-Modell wirkungslos', keys: controlText }
      }
      // Der Angriff: der Angreifer steht mit seiner Kopie auf der Epoche, auf der Alice Mallory entfernt (er ist dem
      // Verkehr bis hierher gefolgt), und fälscht von dort, ohne seine Entfernung einzuspielen. Bei einem linearen
      // Port ist die Fälschung damit das Geschwister des Entfernungs-Commits (gemeinsamer Vorgänger, Issue #45) und
      // kann den Tiebreak gewinnen; der Kandidat muss dann zurückfallen und heilen. Das zweite Blatt kennt nur den
      // Verkehr ab jetzt; geprüft wird allein der Eintrag danach.
      const parentA = num('alice', 'epoche')
      await w.remove('alice', 'mallory')
      await w.flush()
      const forged2 = await w.candidate.forgeKeyOp!(stolen)
      // Ob das Blatt nach der Entfernung wirkt, ist hier die Frage des Szenarios selbst, nicht Voraussetzung.
      // Verlangt wird nur, dass die Operation zustande kommt.
      if (!forged2.frames.length) return { outcome: 'nicht abbildbar', authority: 'der Angreifer konnte nach der Entfernung keine Schlüsseloperation erzeugen', keys: controlText }
      const sameParent = !Number.isFinite(parentA) || forged2.epoch === parentA
      const epochAtRemoval = num('alice', 'epoche')
      await inject(forged2.frames)
      await w.flush()
      // Linearer Port: gewinnt die Fälschung den Tiebreak, fallen die Mitglieder zurück und heilen (Alice meldet
      // den Rückfall, die Epoche geht weiter); verliert sie, ist sie veraltet. Beide Zweige müssen ohne Zugang enden.
      const rolledBack = w.candidate.status('alice').includes('Tiebreak verloren')
      const tiebreak = !Number.isFinite(epochAtRemoval) ? 'kein Tiebreak (zusammengeführt)' : rolledBack || num('alice', 'epoche') > epochAtRemoval ? 'Fälschung gewann (Rückfall, dann Heilung)' : 'Fälschung verlor (veraltet)'
      await w.write('alice', 'nachher')
      await w.flush()
      await feed(forged2.frames)
      const leaked = attackerDoc.getArray<string>('eintraege').toArray().includes('nachher')
      const honest = ['alice', 'bob', 'carol'].every((d) => w.read(d).includes('nachher'))
      const m = membersAgree(w, ['alice', 'bob', 'carol'])
      return {
        outcome: verdict(!leaked && honest && m.agree && !w.members('alice').includes('mallory') && sameParent),
        authority: `${m.text}; gemeinsamer Vorgänger von Fälschung und Entfernung: ${Number.isFinite(parentA) ? `${sameParent ? 'ja' : 'NEIN'} (Epoche ${parentA}, Fälschung auf ${forged2.epoch})` : 'ohne Epochen'}; ${tiebreak}; Zustand alice: ${w.candidate.status('alice')}`,
        keys: `${controlText}; nach der Entfernung liest das gefälschte Blatt Neues: ${leaked ? 'JA (KV3 verletzt)' : 'nein'}; Mitglieder lesen: ${honest ? 'ja' : 'nein'}`,
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

  {
    id: 'S10a',
    title: 'Dienst: Entfernter schreibt gleichzeitig, das Relay verwirft (kein Residual)',
    needs: ['service'],
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
      const bobMsg = w.log.find((m) => m.from === 'bob' && m.label === 'content')
      const verdict10 = bobMsg ? w.verdicts.get(bobMsg.id) ?? 'kein Urteil' : 'kein Rahmen'
      const residual = ['alice', 'carol'].filter((d) => w.read(d).includes('bob-gleichzeitig'))
      const bobOut = !w.members('alice').includes('bob')
      const bobReadsAfter = w.read('bob').includes('danach')
      const served = w.candidate.service!.serves('bob')
      return {
        outcome: verdict(bobOut && residual.length === 0 && !bobReadsAfter && !served && verdict10 === 'verwerfen'),
        authority: `Bob raus: ${bobOut ? 'ja' : 'nein'}; Urteil über Bobs Eintrag: ${verdict10}; Dienst bedient Bob: ${served ? 'ja' : 'nein'}; ${w.candidate.service!.status()}`,
        keys: `Residual bei ${residual.length ? residual.join(',') : 'niemandem'}; Bob liest danach: ${bobReadsAfter ? 'ja' : 'nein'}`,
      }
    },
  },
  {
    id: 'S10b',
    title: 'Dienst: Entfernung ohne Relay, der Entfernte schreibt am Relay weiter (veraltete Sicht)',
    needs: ['service', 'roles'],
    async run(w) {
      await base(w, [['dave', 'member']])
      await w.partition(['bob', 'carol', 'dave'], ['alice'])
      await w.remove('alice', 'dave')
      await w.write('dave', 'stale-1')
      await w.flush()
      const stale = w.read('carol').includes('stale-1')
      await w.heal()
      await w.flush()
      const before = w.log.length
      await w.write('dave', 'stale-2')
      await w.flush()
      // Ohne Schlüssel schreibt Dave womöglich gar nicht mehr („kein Rahmen“); mit altem Zustand verwirft das Relay.
      const second = w.log.slice(before).find((m) => m.from === 'dave' && m.label === 'content')
      const v2 = second ? w.verdicts.get(second.id) ?? 'kein Urteil' : 'kein Rahmen'
      const leak = ['alice', 'bob', 'carol'].filter((d) => w.read(d).includes('stale-2'))
      return {
        outcome: verdict(stale && (v2 === 'verwerfen' || v2 === 'kein Rahmen') && leak.length === 0 && !w.candidate.service!.serves('dave')),
        authority: `Daves Eintrag vor Zustellung der Entfernung kam durch: ${stale ? 'ja (Sicht veraltet, erwartet)' : 'nein'}; danach: ${v2}; ${w.candidate.service!.status()}`,
        keys: `stale-2 bei ${leak.length ? leak.join(',') : 'niemandem'}`,
      }
    },
  },
  {
    id: 'S10c',
    title: 'Dienst: gegenseitige Entfernung lässt nur ein Mitglied, Quorum der Sicht',
    needs: ['service', 'roles'],
    async run(w) {
      await base(w, [], 'admin')
      await w.partition(['alice', 'carol'], ['bob'])
      await w.remove('alice', 'bob')
      await w.remove('bob', 'alice')
      await w.flush()
      await w.heal()
      await w.flush()
      await w.write('carol', 'allein')
      await w.flush()
      await w.write('alice', 'alice-danach')
      await w.flush()
      const aliceMsg = w.log.filter((m) => m.from === 'alice' && m.label === 'content').at(-1)
      const v = aliceMsg ? w.verdicts.get(aliceMsg.id) ?? 'kein Urteil' : 'kein Rahmen'
      const servedOut = ['alice', 'bob'].filter((d) => w.candidate.service!.serves(d))
      // Verdrängte Geräte bekommen vom Dienst nichts mehr; ob sie von ihrer
      // Entfernung erfahren, ist eine Frage der Zustellung (Access §10.2), nicht der Sicht.
      const served = ['alice', 'bob', 'carol'].filter((d) => w.candidate.service!.serves(d))
      const m = membersAgree(w, served)
      const informed = ['alice', 'bob'].filter((d) => !w.members(d).includes(d))
      return {
        outcome: verdict(m.agree && same(w.members('carol'), ['carol']) && servedOut.length === 0 && (v === 'verwerfen' || v === 'kein Rahmen')),
        authority: `bediente Geräte ${m.text}; Dienst bedient noch: ${servedOut.length ? servedOut.join(',') : 'niemanden der Entfernten'}; wissen von ihrer Entfernung: ${informed.length ? informed.join(',') : 'keiner'}; Urteil über Alices Eintrag: ${v}; ${w.candidate.service!.status()}`,
        keys: `Carol liest ${fmt(w.read('carol'))}`,
      }
    },
  },
]

export async function runScenario(make: CandidateFactory, s: Scenario): Promise<ScenarioResult> {
  const candidate = await make()
  const missing = s.needs.filter((c) => !candidate.capabilities.has(c))
  if (missing.length) {
    return { scenario: s.id, title: s.title, outcome: 'nicht abbildbar', authority: `fehlt: ${missing.join(', ')}`, keys: '—', ms: 0 }
  }
  const t0 = performance.now()
  // Entscheidet der Kandidat nach Zufall, läuft das Szenario in jedem Zweig (Anton 18.10.; src/lab/zweige.ts).
  if (candidate.branches) {
    const once = async (c: typeof candidate) => {
      try {
        return await s.run(new World(c))
      } catch (e) {
        return { outcome: 'nicht bestanden' as const, authority: `Fehler: ${(e as Error).message}`, keys: '—' }
      }
    }
    const { runs, exhausted } = await enumerateBranches(candidate, make, once)
    return { scenario: s.id, title: s.title, ms: performance.now() - t0, ...foldBranches(candidate.branches, runs, exhausted) }
  }
  // Hängt das Szenario von Zustellzeiten ab, misst der Prüfstand eine Verteilung über mehrere Läufe (src/lab/zeit.ts).
  if (candidate.timing?.scenarios.includes(s.id)) {
    const once = async (c: typeof candidate) => {
      try {
        return await s.run(new World(c))
      } catch (e) {
        return { outcome: 'nicht bestanden' as const, authority: `Fehler: ${(e as Error).message}`, keys: '—' }
      }
    }
    const runs = await measureRuns(candidate, make, once)
    return { scenario: s.id, title: s.title, ms: performance.now() - t0, ...foldTiming(candidate.timing, runs) }
  }
  try {
    const r = await s.run(new World(candidate))
    return { scenario: s.id, title: s.title, ms: performance.now() - t0, ...r }
  } catch (e) {
    return { scenario: s.id, title: s.title, outcome: 'nicht bestanden', authority: `Fehler: ${(e as Error).message}`, keys: '—', ms: performance.now() - t0 }
  } finally {
    await candidate.dispose?.()
  }
}

export async function runAll(make: CandidateFactory): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  for (const s of scenarios) out.push(await runScenario(make, s))
  return out
}
