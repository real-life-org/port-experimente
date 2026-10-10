import { describe, expect, it } from 'vitest'
import { AuthorityLog, Signer, type AuthOp, type Policy, type Rule } from '../src/candidates/rltp-beekem/authority'

// E9 Schritt 1b: Eigenschaften statt Repros. Ein seeded Generator baut kleine
// Operationsgraphen mit Partitionen, geteilten Beweisen, konkurrierenden
// Aufnahmen derselben Person unter verschiedenen Schlüsseln, unberechtigten
// Signierern und Beförderungen mit dependsOn. Geprüft werden die Invarianten
// I1–I3 aus NOTES.md (E9 Schritt 1b).

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank']
const admins = (...who: string[]): Policy => ({
  'member.add': { type: 'actors', actors: who, k: 1 },
  'member.remove': { type: 'actors', actors: who, k: 1 },
  'policy.change': { type: 'strongest' },
})

interface Gen {
  /** Alle erzeugten Kopien (eine Hülle kann mehrfach mit Teil-Beweisen vorkommen). */
  copies: AuthOp[]
  keysOf: Map<string, Signer[]>
}

/** Baut einen zufälligen Graphen auf einem Referenzlog mit mehreren Köpfen (Partitionen). */
function generate(seed: number): Gen {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!
  const keysOf = new Map<string, Signer[]>(PEOPLE.map((p) => [p, [Signer.generate(p)]]))
  const key = (p: string) => keysOf.get(p)![0]!
  const ref = new AuthorityLog()
  const copies: AuthOp[] = []
  const emit = (op: AuthOp) => {
    // Beweise gelegentlich auf zwei Kopien verteilen.
    if (op.sigs.length > 1 && rnd() < 0.4) {
      const [a, ...rest] = op.sigs
      copies.push({ ...op, sigs: [a!] }, { ...op, sigs: rest })
    } else copies.push(op)
    ref.add(op)
  }
  emit(ref.make({ kind: 'create', subject: 'alice', key: key('alice').pub, policy: admins('alice') }, [key('alice')]))
  // Zwei bis drei "Partitionen": jede baut auf ihrem eigenen Kopf, bis zusammengeführt wird.
  let branches: string[][] = [ref.heads()]
  const steps = 8 + Math.floor(rnd() * 10)
  for (let i = 0; i < steps; i++) {
    const r = rnd()
    if (r < 0.12 && branches.length < 3) branches.push(branches[0]!) // Partition
    else if (r < 0.22 && branches.length > 1) branches = [ref.heads()] // Zusammenführung
    const bi = Math.floor(rnd() * branches.length)
    const preds = branches[bi]!
    const members = [...ref.members()]
    const signer = pick(PEOPLE)
    const signers = rnd() < 0.3 ? [key(signer), key(pick(PEOPLE))] : [key(signer)]
    const kind = rnd()
    let op: AuthOp
    if (kind < 0.4) {
      const subject = pick(PEOPLE)
      // Gelegentlich ein zweiter Schlüssel für dieselbe Person (Konflikt oder Wiederaufnahme unter neuem Schlüssel).
      let k = key(subject)
      if (rnd() < 0.25) {
        const alt = Signer.generate(subject)
        keysOf.get(subject)!.push(alt)
        k = alt
      }
      op = ref.make({ kind: 'add', subject, key: k.pub }, signers, preds)
      emit(op)
      if (rnd() < 0.4) {
        // Beförderung, an diese Aufnahme gebunden.
        const cur = ref.policy()
        const promote = (rule: Rule): Rule => (rule.type === 'actors' && !rule.actors.includes(subject) ? { ...rule, actors: [...rule.actors, subject] } : rule)
        const next: Policy = { ...cur, 'member.add': promote(cur['member.add']), 'member.remove': promote(cur['member.remove']) }
        emit(ref.make({ kind: 'policy', policy: next, dependsOn: [op.id] }, signers, [op.id]))
      }
      branches[bi] = ref.heads().filter((h) => !preds.includes(h) || h === op.id)
      continue
    } else if (kind < 0.75 && members.length) {
      op = ref.make({ kind: 'remove', subject: pick(members) }, signers, preds)
    } else {
      const who = PEOPLE.filter(() => rnd() < 0.5)
      const base = admins(...(who.length ? who : ['alice']))
      const policy: Policy = rnd() < 0.3 ? { ...base, 'member.remove': { type: 'threshold', k: 2 } } : base
      op = ref.make({ kind: 'policy', policy }, signers, preds)
    }
    emit(op)
    branches[bi] = [op.id]
  }
  return { copies, keysOf }
}

function build(copies: AuthOp[], order: AuthOp[]): AuthorityLog {
  const log = new AuthorityLog()
  let pending = order
  while (pending.length) {
    const rest: AuthOp[] = []
    for (const op of pending) if (log.add(op) === 'wartet') rest.push(op)
    if (rest.length === pending.length) throw new Error('Vorgänger fehlen dauerhaft')
    pending = rest
  }
  void copies
  return log
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const snapshot = (log: AuthorityLog) =>
  JSON.stringify({ members: [...log.members()].sort(), policy: log.policy(), version: log.policyVersion(), forked: log.forked(), valid: log.ops().map((o) => [o.id, log.isValid(o.id)]).sort() })

describe('E9 Eigenschaften (seeded, 60 Graphen)', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => 1000 + i)

  it('I1: gleicher Evidenzbestand ergibt gleichen Zustand, unabhängig von Reihenfolge und Verteilung der Beweise', () => {
    for (const seed of seeds) {
      const { copies } = generate(seed)
      const rnd = mulberry32(seed * 7)
      const a = build(copies, copies)
      const want = snapshot(a)
      for (let k = 0; k < 3; k++) {
        const b = build(copies, shuffle(copies, rnd))
        expect(snapshot(b), `seed ${seed}, Reihenfolge ${k}`).toBe(want)
      }
    }
  })

  it('I2: keine Rechte aus gescheiterten Aufnahmen; Schlüsselbindung stammt aus der gültigen Aufnahme', () => {
    for (const seed of seeds) {
      const { copies } = generate(seed)
      const log = build(copies, copies)
      const valid = (id: string) => log.isValid(id)
      for (const op of log.ops()) {
        if (op.kind === 'policy' && op.dependsOn && valid(op.id)) {
          for (const d of op.dependsOn) expect(valid(d), `seed ${seed}: Beförderung gilt, Aufnahme nicht`).toBe(true)
        }
      }
      for (const m of log.members()) {
        const admitted = log.ops().filter((o) => (o.kind === 'add' || o.kind === 'create') && o.subject === m && valid(o.id))
        expect(admitted.length, `seed ${seed}: ${m} ist Mitglied ohne gültige Aufnahme`).toBeGreaterThan(0)
        expect(admitted.some((o) => o.key === log.keyOf(m)), `seed ${seed}: Schlüssel von ${m} stammt nicht aus einer gültigen Aufnahme`).toBe(true)
      }
    }
  })

  it('I3: widersprüchliche Schlüssel gewinnen nie, auch nicht durch zusätzliche Kopien', () => {
    for (const seed of seeds) {
      const { copies } = generate(seed)
      const rnd = mulberry32(seed * 13)
      const log = build(copies, copies)
      // Je Person genau ein Schlüssel unter allen gültigen Aufnahmen.
      for (const p of PEOPLE) {
        const keys = new Set(log.ops().filter((o) => o.kind === 'add' && o.subject === p && log.isValid(o.id)).map((o) => o.key))
        expect(keys.size, `seed ${seed}: ${p} hat ${keys.size} gültige Schlüssel`).toBeLessThanOrEqual(1)
      }
      // Zusätzliche Kopien (Teil-Beweise, Duplikate) ändern nichts.
      const extra = [...copies, ...shuffle(copies, rnd).slice(0, 5).map((o) => ({ ...o, sigs: o.sigs.slice(0, 1) }))]
      expect(snapshot(build(extra, shuffle(extra, rnd)))).toBe(snapshot(log))
    }
  })
})
